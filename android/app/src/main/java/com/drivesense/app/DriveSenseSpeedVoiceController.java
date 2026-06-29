package com.drivesense.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class DriveSenseSpeedVoiceController {
    interface Callback {
        void onSpeedLimitCommand(int limitKmh, boolean posted, String transcript);
        void onDiagnostic(String type, String reason);
    }

    private static final Pattern DIGIT_SPEED_PATTERN = Pattern.compile(
        "(?:posted\\s+)?(?:speed|speed\\s+limit|limit)(?:\\s+(?:is|to|at|equals|set\\s+to))?\\D{0,18}(\\d{2,3})"
    );
    private static final long RESTART_DELAY_MS = 900L;
    private static final long AFTER_CAPTURE_DELAY_MS = 2500L;

    private static final Map<String, Integer> WORD_SPEEDS = new HashMap<>();

    static {
        WORD_SPEEDS.put("twenty", 20);
        WORD_SPEEDS.put("thirty", 30);
        WORD_SPEEDS.put("forty", 40);
        WORD_SPEEDS.put("fifty", 50);
        WORD_SPEEDS.put("sixty", 60);
        WORD_SPEEDS.put("seventy", 70);
        WORD_SPEEDS.put("eighty", 80);
        WORD_SPEEDS.put("ninety", 90);
        WORD_SPEEDS.put("hundred", 100);
        WORD_SPEEDS.put("one hundred", 100);
        WORD_SPEEDS.put("one ten", 110);
        WORD_SPEEDS.put("one twenty", 120);
    }

    private final Context context;
    private final Callback callback;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private boolean enabled;
    private boolean listening;

    DriveSenseSpeedVoiceController(Context context, Callback callback) {
        this.context = context.getApplicationContext();
        this.callback = callback;
    }

    void start() {
        enabled = true;
        if (!hasAudioPermission()) {
            notifyDiagnostic("voice_speed_marker_unavailable", "record_audio_permission_missing");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            notifyDiagnostic("voice_speed_marker_unavailable", "speech_recognizer_unavailable");
            return;
        }
        ensureRecognizer();
        listenSoon(150L);
    }

    void stop() {
        enabled = false;
        listening = false;
        handler.removeCallbacksAndMessages(null);
        if (recognizer != null) {
            try {
                recognizer.cancel();
                recognizer.destroy();
            } catch (Exception ignored) {}
            recognizer = null;
        }
    }

    private boolean hasAudioPermission() {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void ensureRecognizer() {
        if (recognizer != null) return;
        recognizer = SpeechRecognizer.createSpeechRecognizer(context);
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {}
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() { listening = false; }
            @Override public void onPartialResults(Bundle partialResults) {}
            @Override public void onEvent(int eventType, Bundle params) {}

            @Override
            public void onError(int error) {
                listening = false;
                if (enabled) listenSoon(RESTART_DELAY_MS);
            }

            @Override
            public void onResults(Bundle results) {
                listening = false;
                SpeedCommand command = parseResults(results);
                if (command != null) {
                    callback.onSpeedLimitCommand(command.limitKmh, command.posted, command.transcript);
                    if (enabled) listenSoon(AFTER_CAPTURE_DELAY_MS);
                    return;
                }
                if (enabled) listenSoon(RESTART_DELAY_MS);
            }
        });
    }

    private void listenSoon(long delayMs) {
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::listenNow, Math.max(0L, delayMs));
    }

    private void listenNow() {
        if (!enabled || listening || !hasAudioPermission()) return;
        ensureRecognizer();
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
        try {
            listening = true;
            recognizer.startListening(intent);
        } catch (Exception error) {
            listening = false;
            notifyDiagnostic("voice_speed_marker_unavailable", "speech_recognizer_start_failed");
            if (enabled) listenSoon(3_000L);
        }
    }

    private SpeedCommand parseResults(Bundle results) {
        ArrayList<String> matches = results == null
            ? null
            : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null) return null;
        for (String transcript : matches) {
            SpeedCommand command = parseTranscript(transcript);
            if (command != null) return command;
        }
        return null;
    }

    static SpeedCommand parseTranscript(String transcript) {
        String normalized = normalize(transcript);
        if (normalized.isEmpty()) return null;
        boolean hasWakePhrase = normalized.contains("road sage") ||
            normalized.contains("roadsage") ||
            normalized.contains("hey sage") ||
            normalized.contains("road safe");
        boolean hasExplicitSpeedPhrase = normalized.contains("speed is") ||
            normalized.contains("speed limit") ||
            normalized.contains("posted speed") ||
            normalized.startsWith("speed ");
        if (!hasWakePhrase && !hasExplicitSpeedPhrase) return null;

        int limit = parseDigitLimit(normalized);
        if (limit <= 0) limit = parseWordLimit(normalized);
        if (!isReasonableLimit(limit)) return null;
        boolean posted = normalized.contains("posted") || normalized.contains("sign says") || normalized.contains("speed sign");
        return new SpeedCommand(limit, posted, transcript == null ? "" : transcript.trim());
    }

    private static String normalize(String value) {
        return String.valueOf(value == null ? "" : value)
            .toLowerCase(Locale.US)
            .replace('-', ' ')
            .replaceAll("[^a-z0-9\\s]", " ")
            .replaceAll("\\s+", " ")
            .trim();
    }

    private static int parseDigitLimit(String normalized) {
        Matcher matcher = DIGIT_SPEED_PATTERN.matcher(normalized);
        if (!matcher.find()) return -1;
        try {
            return Integer.parseInt(matcher.group(1));
        } catch (NumberFormatException error) {
            return -1;
        }
    }

    private static int parseWordLimit(String normalized) {
        for (Map.Entry<String, Integer> entry : WORD_SPEEDS.entrySet()) {
            if (normalized.contains("speed " + entry.getKey()) ||
                normalized.contains("speed is " + entry.getKey()) ||
                normalized.contains("speed limit " + entry.getKey()) ||
                normalized.contains("posted speed " + entry.getKey())) {
                return entry.getValue();
            }
        }
        return -1;
    }

    private static boolean isReasonableLimit(int limitKmh) {
        return limitKmh >= 20 && limitKmh <= 130 && limitKmh % 5 == 0;
    }

    private void notifyDiagnostic(String type, String reason) {
        if (callback != null) callback.onDiagnostic(type, reason);
    }

    static final class SpeedCommand {
        final int limitKmh;
        final boolean posted;
        final String transcript;

        SpeedCommand(int limitKmh, boolean posted, String transcript) {
            this.limitKmh = limitKmh;
            this.posted = posted;
            this.transcript = transcript;
        }
    }
}
