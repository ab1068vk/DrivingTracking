package com.drivesense.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.YuvImage;

import androidx.camera.core.ImageProxy;

import com.google.mlkit.vision.text.Text;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

final class SpeedSignReviewCrop {
    private static final int MAX_EDGE_PX = 480;
    private static final int JPEG_QUALITY = 82;
    private static final Pattern REGULATORY_TEXT = Pattern.compile(
        "\\b(SPEED\\s+LIMIT|MAXIMUM|MAX\\s+SPEED)\\b"
    );

    private SpeedSignReviewCrop() {}

    static Bitmap uprightBitmap(ImageProxy imageProxy) {
        if (imageProxy == null || imageProxy.getPlanes().length < 3) return null;
        int width = imageProxy.getWidth();
        int height = imageProxy.getHeight();
        if (width <= 0 || height <= 0) return null;
        try {
            byte[] nv21 = toNv21(imageProxy, width, height);
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream(width * height / 3);
            YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, width, height, null);
            if (!yuv.compressToJpeg(new Rect(0, 0, width, height), 88, jpeg)) return null;
            byte[] bytes = jpeg.toByteArray();
            Bitmap raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (raw == null) return null;
            int rotation = Math.floorMod(imageProxy.getImageInfo().getRotationDegrees(), 360);
            if (rotation == 0) return raw;
            Matrix matrix = new Matrix();
            matrix.postRotate(rotation);
            Bitmap upright = Bitmap.createBitmap(
                raw,
                0,
                0,
                raw.getWidth(),
                raw.getHeight(),
                matrix,
                true
            );
            if (upright != raw) raw.recycle();
            return upright;
        } catch (Exception ignored) {
            return null;
        }
    }

    static byte[] croppedJpeg(Bitmap upright, Text recognizedText, int displayedValue) {
        if (upright == null || recognizedText == null) return null;
        Rect target = bestCandidateBounds(recognizedText, displayedValue);
        if (target == null || target.width() <= 0 || target.height() <= 0) return null;
        Rect padded = paddedBounds(target, upright.getWidth(), upright.getHeight());
        if (padded.width() < 24 || padded.height() < 24) return null;

        Bitmap cropped = null;
        Bitmap scaled = null;
        try {
            cropped = Bitmap.createBitmap(
                upright,
                padded.left,
                padded.top,
                padded.width(),
                padded.height()
            );
            int longest = Math.max(cropped.getWidth(), cropped.getHeight());
            if (longest > MAX_EDGE_PX) {
                double scale = MAX_EDGE_PX / (double) longest;
                scaled = Bitmap.createScaledBitmap(
                    cropped,
                    Math.max(1, (int) Math.round(cropped.getWidth() * scale)),
                    Math.max(1, (int) Math.round(cropped.getHeight() * scale)),
                    true
                );
            }
            Bitmap output = scaled == null ? cropped : scaled;
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream(48_000);
            if (!output.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpeg)) return null;
            byte[] result = jpeg.toByteArray();
            return result.length <= 300_000 ? result : null;
        } catch (Exception ignored) {
            return null;
        } finally {
            if (scaled != null && scaled != cropped) scaled.recycle();
            if (cropped != null && cropped != upright) cropped.recycle();
        }
    }

    /** Retains only an already-isolated sign proposal when OCR bounds are weak. */
    static byte[] candidateJpeg(Bitmap candidate) {
        if (candidate == null || candidate.isRecycled()) return null;
        Bitmap scaled = null;
        try {
            Bitmap output = candidate;
            int longest = Math.max(candidate.getWidth(), candidate.getHeight());
            if (longest > MAX_EDGE_PX) {
                double scale = MAX_EDGE_PX / (double) longest;
                scaled = Bitmap.createScaledBitmap(
                    candidate,
                    Math.max(1, (int) Math.round(candidate.getWidth() * scale)),
                    Math.max(1, (int) Math.round(candidate.getHeight() * scale)),
                    true
                );
                output = scaled;
            }
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream(48_000);
            if (!output.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpeg)) return null;
            byte[] result = jpeg.toByteArray();
            return result.length <= 300_000 ? result : null;
        } catch (RuntimeException ignored) {
            return null;
        } finally {
            if (scaled != null && scaled != candidate) scaled.recycle();
        }
    }

    private static Rect bestCandidateBounds(Text recognizedText, int displayedValue) {
        Rect best = null;
        int bestArea = 0;
        for (Text.TextBlock block : recognizedText.getTextBlocks()) {
            List<String> lines = new ArrayList<>();
            for (Text.Line line : block.getLines()) lines.add(line.getText());
            SpeedSignObservationFusion.ParsedFrame parsed =
                SpeedSignObservationFusion.parseFrame(lines);
            Rect bounds = block.getBoundingBox();
            if (parsed == null || parsed.value != displayedValue || bounds == null) continue;
            int area = bounds.width() * bounds.height();
            if (area > bestArea) {
                best = new Rect(bounds);
                bestArea = area;
            }
        }
        if (best != null) return best;

        List<Rect> markers = new ArrayList<>();
        List<Rect> numbers = new ArrayList<>();
        Pattern valuePattern = Pattern.compile(
            "(?<!\\d)" + Pattern.quote(String.valueOf(displayedValue)) + "(?!\\d)"
        );
        for (Text.TextBlock block : recognizedText.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                Rect bounds = line.getBoundingBox();
                if (bounds == null) continue;
                String normalized = line.getText().toUpperCase(Locale.ROOT);
                if (REGULATORY_TEXT.matcher(normalized).find()) markers.add(new Rect(bounds));
                if (valuePattern.matcher(normalized).find()) numbers.add(new Rect(bounds));
            }
        }
        long bestDistance = Long.MAX_VALUE;
        Rect paired = null;
        for (Rect marker : markers) {
            for (Rect number : numbers) {
                long dx = marker.centerX() - number.centerX();
                long dy = marker.centerY() - number.centerY();
                long distance = dx * dx + dy * dy;
                if (distance >= bestDistance) continue;
                Rect union = new Rect(marker);
                union.union(number);
                paired = union;
                bestDistance = distance;
            }
        }
        return paired;
    }

    private static Rect paddedBounds(Rect source, int imageWidth, int imageHeight) {
        int padX = Math.max(18, source.width() / 2);
        int padY = Math.max(18, source.height() / 2);
        return new Rect(
            Math.max(0, source.left - padX),
            Math.max(0, source.top - padY),
            Math.min(imageWidth, source.right + padX),
            Math.min(imageHeight, source.bottom + padY)
        );
    }

    private static byte[] toNv21(ImageProxy imageProxy, int width, int height) {
        ImageProxy.PlaneProxy[] planes = imageProxy.getPlanes();
        int ySize = width * height;
        int chromaWidth = (width + 1) / 2;
        int chromaHeight = (height + 1) / 2;
        byte[] output = new byte[ySize + chromaWidth * chromaHeight * 2];
        copyLuma(planes[0], output, width, height);

        ByteBuffer u = planes[1].getBuffer().duplicate();
        ByteBuffer v = planes[2].getBuffer().duplicate();
        int uBase = u.position();
        int vBase = v.position();
        int outputIndex = ySize;
        for (int row = 0; row < chromaHeight; row++) {
            for (int column = 0; column < chromaWidth; column++) {
                int vIndex = vBase + row * planes[2].getRowStride()
                    + column * planes[2].getPixelStride();
                int uIndex = uBase + row * planes[1].getRowStride()
                    + column * planes[1].getPixelStride();
                output[outputIndex++] = v.get(vIndex);
                output[outputIndex++] = u.get(uIndex);
            }
        }
        return output;
    }

    private static void copyLuma(
        ImageProxy.PlaneProxy plane,
        byte[] output,
        int width,
        int height
    ) {
        ByteBuffer buffer = plane.getBuffer().duplicate();
        int base = buffer.position();
        int outputIndex = 0;
        for (int row = 0; row < height; row++) {
            for (int column = 0; column < width; column++) {
                int index = base + row * plane.getRowStride() + column * plane.getPixelStride();
                output[outputIndex++] = buffer.get(index);
            }
        }
    }
}
