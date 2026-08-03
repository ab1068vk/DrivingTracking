package com.drivesense.app;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Conservative, text-only speed-sign evidence fusion.
 *
 * This class intentionally does not infer a legal limit from a bare number.
 * A supported regulatory marker must be present, disqualifying qualifiers must
 * be absent, and the same value must appear in multiple independent frames.
 */
final class SpeedSignObservationFusion {
    static final int REQUIRED_FRAMES = 2;
    static final long WINDOW_MS = 6_000L;
    static final long MIN_SPAN_MS = 450L;

    private static final Pattern NUMBER_PATTERN = Pattern.compile(
        "(?<![A-Z0-9])([0-9OQDSILB]{2,3})(?![A-Z0-9])"
    );
    private static final List<Pattern> REGULATORY_MARKERS = Arrays.asList(
        Pattern.compile("\\bSPEED\\s+L[I1L]M[I1L]T\\b"),
        Pattern.compile("\\bMAX[I1L]M[UO]M\\b"),
        Pattern.compile("\\bMAX[I1L]M[UO]N\\b"),
        Pattern.compile("\\bMAX\\s+SPEED\\b")
    );
    private static final List<String> UNSUPPORTED_TEXT = Arrays.asList(
        "ADVISORY",
        "TRUCK",
        "BUS",
        "MINIMUM",
        "CURVE",
        "RAMP",
        "EXIT",
        "AHEAD",
        "ENDS"
    );

    private final Deque<FrameObservation> observations = new ArrayDeque<>();
    private int lastEmittedValue = -1;
    private String lastEmittedQualifier = "";
    private long lastEmittedAtMs = 0L;

    FusedObservation addFrame(List<String> recognizedLines, long timestampMs) {
        ParsedFrame parsed = parseFrame(recognizedLines);
        prune(timestampMs);
        if (parsed == null) return null;

        observations.addLast(new FrameObservation(parsed.value, parsed.qualifierKind, timestampMs));
        List<FrameObservation> matching = new ArrayList<>();
        for (FrameObservation observation : observations) {
            if (observation.value == parsed.value && observation.qualifierKind.equals(parsed.qualifierKind)) matching.add(observation);
        }
        if (matching.size() < REQUIRED_FRAMES) return null;

        long spanMs = matching.get(matching.size() - 1).timestampMs - matching.get(0).timestampMs;
        if (spanMs < MIN_SPAN_MS) return null;
        if (
            parsed.value == lastEmittedValue &&
            parsed.qualifierKind.equals(lastEmittedQualifier) &&
            timestampMs - lastEmittedAtMs < 60_000L
        ) return null;

        lastEmittedValue = parsed.value;
        lastEmittedQualifier = parsed.qualifierKind;
        lastEmittedAtMs = timestampMs;
        observations.clear();
        double confidence = Math.min(
            parsed.conditional ? 0.72d : 0.80d,
            0.60d + matching.size() * 0.06d
        );
        return new FusedObservation(
            parsed.value,
            matching.size(),
            confidence,
            timestampMs,
            parsed.qualifierKind,
            parsed.conditional
        );
    }

    private void prune(long timestampMs) {
        while (!observations.isEmpty() && timestampMs - observations.peekFirst().timestampMs > WINDOW_MS) {
            observations.removeFirst();
        }
    }

    static ParsedFrame parseFrame(List<String> recognizedLines) {
        if (recognizedLines == null || recognizedLines.isEmpty()) return null;
        String normalized = String.join(" ", recognizedLines)
            .toUpperCase(Locale.ROOT)
            .replaceAll("\\s+", " ")
            .trim();
        if (normalized.isEmpty()) return null;

        for (String phrase : UNSUPPORTED_TEXT) {
            if (normalized.contains(phrase)) return null;
        }
        boolean regulatory = false;
        for (Pattern marker : REGULATORY_MARKERS) {
            if (marker.matcher(normalized).find()) {
                regulatory = true;
                break;
            }
        }
        if (!regulatory) return null;

        Matcher matcher = NUMBER_PATTERN.matcher(normalized);
        Integer value = null;
        while (matcher.find()) {
            int candidate;
            try {
                candidate = parseOcrNumber(matcher.group(1));
            } catch (NumberFormatException ignored) {
                continue;
            }
            if (candidate < 10 || candidate > 130 || candidate % 5 != 0) continue;
            if (value != null && value != candidate) return null;
            value = candidate;
        }
        if (value == null) return null;
        String qualifierKind = "regulatory_text_no_qualifiers";
        if (normalized.contains("SCHOOL") || normalized.contains("PLAYGROUND") || normalized.contains("CHILDREN")) {
            qualifierKind = normalized.contains("FLASHING")
                ? "conditional_school_when_flashing"
                : "conditional_school";
        } else if (
            normalized.contains("CONSTRUCTION") || normalized.contains("WORK ZONE") ||
            normalized.contains("ROAD WORK") || normalized.contains("TEMPORARY")
        ) {
            qualifierKind = "conditional_temporary_work_zone";
        } else if (normalized.contains("DAYTIME")) {
            qualifierKind = "conditional_daytime";
        } else if (normalized.contains("NIGHT")) {
            qualifierKind = "conditional_night";
        }
        return new ParsedFrame(value, qualifierKind);
    }

    private static int parseOcrNumber(String token) throws NumberFormatException {
        StringBuilder normalized = new StringBuilder(token.length());
        for (int index = 0; index < token.length(); index++) {
            char value = token.charAt(index);
            if (value >= '0' && value <= '9') {
                normalized.append(value);
            } else if (value == 'O' || value == 'Q' || value == 'D') {
                normalized.append('0');
            } else if (value == 'I' || value == 'L') {
                normalized.append('1');
            } else if (value == 'S') {
                normalized.append('5');
            } else if (value == 'B') {
                normalized.append('8');
            } else {
                throw new NumberFormatException("Unsupported OCR digit");
            }
        }
        return Integer.parseInt(normalized.toString());
    }

    static final class ParsedFrame {
        final int value;
        final String qualifierKind;
        final boolean conditional;

        ParsedFrame(int value, String qualifierKind) {
            this.value = value;
            this.qualifierKind = qualifierKind;
            this.conditional = !"regulatory_text_no_qualifiers".equals(qualifierKind);
        }
    }

    static final class FusedObservation {
        final int displayedValue;
        final int frameCount;
        final double confidence;
        final long timestampMs;
        final String qualifierKind;
        final boolean conditional;

        FusedObservation(
            int displayedValue,
            int frameCount,
            double confidence,
            long timestampMs,
            String qualifierKind,
            boolean conditional
        ) {
            this.displayedValue = displayedValue;
            this.frameCount = frameCount;
            this.confidence = confidence;
            this.timestampMs = timestampMs;
            this.qualifierKind = qualifierKind;
            this.conditional = conditional;
        }
    }

    private static final class FrameObservation {
        final int value;
        final String qualifierKind;
        final long timestampMs;

        FrameObservation(int value, String qualifierKind, long timestampMs) {
            this.value = value;
            this.qualifierKind = qualifierKind;
            this.timestampMs = timestampMs;
        }
    }
}
