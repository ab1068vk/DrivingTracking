package com.drivesense.app;

import android.graphics.Bitmap;
import android.graphics.Rect;

/**
 * Offline visual gate that keeps OCR on the forward road region and rejects
 * unusable frames before the text recognizer spends power on them.
 *
 * This is deliberately described as a visual gate, not a trained ML model.
 * It evaluates real pixels for exposure, contrast, edge sharpness, and
 * sign-like bright/red panels. It also proposes and enlarges the strongest
 * roadside-sign region so OCR is not asked to read one tiny sign from an
 * entire 1280x720 frame. A bundled trained detector can replace this class
 * later without changing evidence or review semantics.
 */
final class SpeedSignVisualGate {
    private static final double MIN_LUMINANCE = 42d;
    private static final double MAX_LUMINANCE = 232d;
    private static final double MIN_CONTRAST = 20d;
    private static final double MIN_EDGE_SCORE = 10d;

    private SpeedSignVisualGate() {}

    static Result analyze(Bitmap upright) {
        if (upright == null || upright.getWidth() < 160 || upright.getHeight() < 120) {
            return Result.rejected("frame_unavailable", "Frame unavailable", 0d, null);
        }
        int width = upright.getWidth();
        int height = upright.getHeight();
        // Exclude most of the dashboard and cabin. Regulatory signs should be
        // in the forward scene above the lower windshield region.
        int left = Math.max(0, Math.round(width * 0.04f));
        int top = Math.max(0, Math.round(height * 0.08f));
        int right = Math.min(width, Math.round(width * 0.96f));
        int bottom = Math.min(height, Math.round(height * 0.70f));
        int roiWidth = Math.max(1, right - left);
        int roiHeight = Math.max(1, bottom - top);
        Bitmap roi;
        try {
            roi = Bitmap.createBitmap(upright, left, top, roiWidth, roiHeight);
        } catch (RuntimeException error) {
            return Result.rejected("roi_failed", "Forward view unavailable", 0d, null);
        }

        int step = Math.max(2, Math.min(8, Math.max(roiWidth, roiHeight) / 220));
        long count = 0;
        double sum = 0d;
        double sumSquares = 0d;
        double edgeSum = 0d;
        int edgeCount = 0;
        int brightNeutral = 0;
        for (int y = step; y < roiHeight - step; y += step) {
            for (int x = step; x < roiWidth - step; x += step) {
                int pixel = roi.getPixel(x, y);
                int red = (pixel >> 16) & 0xff;
                int green = (pixel >> 8) & 0xff;
                int blue = pixel & 0xff;
                double luminance = 0.2126d * red + 0.7152d * green + 0.0722d * blue;
                sum += luminance;
                sumSquares += luminance * luminance;
                count += 1;
                if (
                    luminance >= 145d && luminance <= 250d &&
                    Math.max(red, Math.max(green, blue)) - Math.min(red, Math.min(green, blue)) <= 42
                ) brightNeutral += 1;

                int rightPixel = roi.getPixel(x + step, y);
                int downPixel = roi.getPixel(x, y + step);
                double rightLuma = luminance(rightPixel);
                double downLuma = luminance(downPixel);
                edgeSum += Math.abs(luminance - rightLuma) + Math.abs(luminance - downLuma);
                edgeCount += 2;
            }
        }
        if (count == 0) {
            roi.recycle();
            return Result.rejected("frame_empty", "Forward view unavailable", 0d, null);
        }
        double mean = sum / count;
        double variance = Math.max(0d, sumSquares / count - mean * mean);
        double contrast = Math.sqrt(variance);
        double edgeScore = edgeCount == 0 ? 0d : edgeSum / edgeCount;
        double brightPanelRatio = brightNeutral / (double) count;
        double quality = clamp01(
            0.34d * exposureScore(mean) +
            0.33d * clamp01(contrast / 58d) +
            0.25d * clamp01(edgeScore / 30d) +
            0.08d * clamp01(brightPanelRatio / 0.12d)
        );

        if (mean < MIN_LUMINANCE) {
            roi.recycle();
            return Result.rejected("too_dark", "Too dark", quality, null);
        }
        if (mean > MAX_LUMINANCE) {
            roi.recycle();
            return Result.rejected("overexposed", "Too much glare", quality, null);
        }
        if (contrast < MIN_CONTRAST || edgeScore < MIN_EDGE_SCORE) {
            roi.recycle();
            return Result.rejected("motion_or_blur", "Waiting for a sharper road view", quality, null);
        }
        String label = quality >= 0.72d ? "Strong road view" : quality >= 0.52d ? "Usable road view" : "Limited road view";
        CandidateWindow candidate = findSignCandidate(roi);
        Bitmap primary = candidate == null ? roi : enlargedCandidate(roi, candidate.bounds);
        if (primary == null) primary = roi;
        boolean targetFound = primary != roi;
        return new Result(
            true,
            "accepted",
            targetFound ? "Sign-like target isolated" : label,
            quality,
            brightPanelRatio,
            primary,
            targetFound ? roi : null,
            targetFound,
            candidate == null ? 0d : candidate.score
        );
    }

    /**
     * Finds a compact bright panel containing dark text/edges. Regulatory
     * signs vary by country (white rectangles and red circles), so this is a
     * proposal stage only; regulatory wording and repeated-frame fusion still
     * decide whether any evidence may be retained.
     */
    private static CandidateWindow findSignCandidate(Bitmap roi) {
        int width = roi.getWidth();
        int height = roi.getHeight();
        int sample = Math.max(2, Math.min(5, Math.max(width, height) / 280));
        int gridWidth = Math.max(1, width / sample);
        int gridHeight = Math.max(1, height / sample);
        if (gridWidth < 20 || gridHeight < 20) return null;
        int stride = gridWidth + 1;
        int size = stride * (gridHeight + 1);
        int[] bright = new int[size];
        int[] dark = new int[size];
        int[] edge = new int[size];
        int[] red = new int[size];

        for (int gridY = 1; gridY <= gridHeight; gridY++) {
            int rowBright = 0;
            int rowDark = 0;
            int rowEdge = 0;
            int rowRed = 0;
            int pixelY = Math.min(height - 1, (gridY - 1) * sample + sample / 2);
            for (int gridX = 1; gridX <= gridWidth; gridX++) {
                int pixelX = Math.min(width - 1, (gridX - 1) * sample + sample / 2);
                int pixel = roi.getPixel(pixelX, pixelY);
                int redValue = (pixel >> 16) & 0xff;
                int greenValue = (pixel >> 8) & 0xff;
                int blueValue = pixel & 0xff;
                double luma = luminance(pixel);
                int chroma = Math.max(redValue, Math.max(greenValue, blueValue))
                    - Math.min(redValue, Math.min(greenValue, blueValue));
                if (luma >= 122d && luma <= 252d && chroma <= 68) rowBright += 1;
                if (luma <= 108d) rowDark += 1;
                if (
                    redValue >= 115 &&
                    redValue > greenValue * 1.18d &&
                    redValue > blueValue * 1.12d
                ) rowRed += 1;
                int rightX = Math.min(width - 1, pixelX + sample);
                int downY = Math.min(height - 1, pixelY + sample);
                if (
                    Math.abs(luma - luminance(roi.getPixel(rightX, pixelY))) >= 18d ||
                    Math.abs(luma - luminance(roi.getPixel(pixelX, downY))) >= 18d
                ) rowEdge += 1;

                int index = gridY * stride + gridX;
                int above = index - stride;
                bright[index] = bright[above] + rowBright;
                dark[index] = dark[above] + rowDark;
                edge[index] = edge[above] + rowEdge;
                red[index] = red[above] + rowRed;
            }
        }

        double[] heightRatios = { 0.08d, 0.11d, 0.15d, 0.20d, 0.27d };
        double[] aspects = { 0.62d, 0.78d, 0.95d, 1.18d, 1.42d };
        CandidateWindow best = null;
        for (double heightRatio : heightRatios) {
            int windowHeight = Math.max(6, (int) Math.round(gridHeight * heightRatio));
            for (double aspect : aspects) {
                int windowWidth = Math.max(5, (int) Math.round(windowHeight * aspect));
                if (windowWidth >= gridWidth || windowHeight >= gridHeight) continue;
                int stepX = Math.max(2, windowWidth / 3);
                int stepY = Math.max(2, windowHeight / 3);
                for (int top = 0; top + windowHeight <= gridHeight; top += stepY) {
                    for (int left = 0; left + windowWidth <= gridWidth; left += stepX) {
                        int right = left + windowWidth;
                        int bottom = top + windowHeight;
                        double area = windowWidth * (double) windowHeight;
                        double brightRatio = areaSum(bright, stride, left, top, right, bottom) / area;
                        double darkRatio = areaSum(dark, stride, left, top, right, bottom) / area;
                        double edgeRatio = areaSum(edge, stride, left, top, right, bottom) / area;
                        double redRatio = areaSum(red, stride, left, top, right, bottom) / area;
                        if (brightRatio < 0.14d || darkRatio < 0.035d || darkRatio > 0.58d || edgeRatio < 0.045d) {
                            continue;
                        }
                        double score =
                            0.42d * clamp01((brightRatio - 0.10d) / 0.58d) +
                            0.28d * clamp01(edgeRatio / 0.34d) +
                            0.20d * clamp01(1d - Math.abs(darkRatio - 0.20d) / 0.28d) +
                            0.10d * clamp01(redRatio / 0.10d);
                        if (best != null && score <= best.score) continue;
                        Rect bounds = new Rect(
                            Math.max(0, left * sample),
                            Math.max(0, top * sample),
                            Math.min(width, right * sample),
                            Math.min(height, bottom * sample)
                        );
                        best = new CandidateWindow(bounds, score);
                    }
                }
            }
        }
        return best != null && best.score >= 0.34d ? best : null;
    }

    private static int areaSum(int[] integral, int stride, int left, int top, int right, int bottom) {
        int a = integral[top * stride + left];
        int b = integral[top * stride + right];
        int c = integral[bottom * stride + left];
        int d = integral[bottom * stride + right];
        return d - b - c + a;
    }

    private static Bitmap enlargedCandidate(Bitmap roi, Rect source) {
        if (source == null || source.width() < 12 || source.height() < 12) return null;
        int padX = Math.max(8, source.width() / 5);
        int padY = Math.max(8, source.height() / 5);
        Rect padded = new Rect(
            Math.max(0, source.left - padX),
            Math.max(0, source.top - padY),
            Math.min(roi.getWidth(), source.right + padX),
            Math.min(roi.getHeight(), source.bottom + padY)
        );
        if (padded.width() < 12 || padded.height() < 12) return null;
        Bitmap crop = null;
        try {
            crop = Bitmap.createBitmap(
                roi,
                padded.left,
                padded.top,
                padded.width(),
                padded.height()
            );
            int longest = Math.max(crop.getWidth(), crop.getHeight());
            double scale = Math.min(6d, Math.max(1d, 720d / Math.max(1, longest)));
            if (scale <= 1.05d) return crop;
            Bitmap enlarged = Bitmap.createScaledBitmap(
                crop,
                Math.max(1, (int) Math.round(crop.getWidth() * scale)),
                Math.max(1, (int) Math.round(crop.getHeight() * scale)),
                true
            );
            if (enlarged != crop) crop.recycle();
            return enlarged;
        } catch (RuntimeException error) {
            if (crop != null && !crop.isRecycled()) crop.recycle();
            return null;
        }
    }

    private static double luminance(int pixel) {
        int red = (pixel >> 16) & 0xff;
        int green = (pixel >> 8) & 0xff;
        int blue = pixel & 0xff;
        return 0.2126d * red + 0.7152d * green + 0.0722d * blue;
    }

    private static double exposureScore(double mean) {
        return clamp01(1d - Math.abs(mean - 132d) / 132d);
    }

    private static double clamp01(double value) {
        return Math.max(0d, Math.min(1d, value));
    }

    static final class Result {
        final boolean accepted;
        final String reason;
        final String qualityLabel;
        final double qualityScore;
        final double brightPanelRatio;
        final Bitmap analysisBitmap;
        final Bitmap fallbackBitmap;
        final boolean signTargetFound;
        final double signTargetScore;

        Result(
            boolean accepted,
            String reason,
            String qualityLabel,
            double qualityScore,
            double brightPanelRatio,
            Bitmap analysisBitmap,
            Bitmap fallbackBitmap,
            boolean signTargetFound,
            double signTargetScore
        ) {
            this.accepted = accepted;
            this.reason = reason;
            this.qualityLabel = qualityLabel;
            this.qualityScore = qualityScore;
            this.brightPanelRatio = brightPanelRatio;
            this.analysisBitmap = analysisBitmap;
            this.fallbackBitmap = fallbackBitmap;
            this.signTargetFound = signTargetFound;
            this.signTargetScore = signTargetScore;
        }

        static Result rejected(String reason, String label, double quality, Bitmap bitmap) {
            return new Result(false, reason, label, quality, 0d, bitmap, null, false, 0d);
        }
    }

    private static final class CandidateWindow {
        final Rect bounds;
        final double score;

        CandidateWindow(Rect bounds, double score) {
            this.bounds = bounds;
            this.score = score;
        }
    }
}
