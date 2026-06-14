package com.drivesense.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

final class DriveSenseSpeechController {
    interface Callback {
        void onAccepted();
        void onError(String message);
    }

    private static final AudioAttributes SPEECH_ATTRIBUTES = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build();

    private final Context context;
    private final AudioManager audioManager;
    private final ArrayDeque<SpeechRequest> pending = new ArrayDeque<>();
    private final Set<String> activeUtterances = new HashSet<>();
    private final AudioManager.OnAudioFocusChangeListener focusListener = focusChange -> {};

    private TextToSpeech textToSpeech;
    private AudioFocusRequest audioFocusRequest;
    private boolean ready;
    private boolean initializing;
    private boolean hasAudioFocus;

    DriveSenseSpeechController(Context context) {
        this.context = context.getApplicationContext();
        this.audioManager = (AudioManager) this.context.getSystemService(Context.AUDIO_SERVICE);
    }

    void speak(
        String text,
        float rate,
        float pitch,
        float volume,
        boolean interrupt,
        Callback callback
    ) {
        String message = text == null ? "" : text.trim();
        if (message.isEmpty()) {
            if (callback != null) callback.onError("text is required.");
            return;
        }

        SpeechRequest request = new SpeechRequest(
            message,
            clamp(rate, 0.5f, 1.4f),
            clamp(pitch, 0.75f, 1.25f),
            clamp(volume, 0f, 1f),
            interrupt,
            callback
        );
        if (ready && textToSpeech != null) {
            speakNow(request);
            return;
        }

        pending.addLast(request);
        initializeIfNeeded();
    }

    void shutdown() {
        pending.clear();
        activeUtterances.clear();
        abandonAudioFocus();
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
        ready = false;
        initializing = false;
    }

    private void initializeIfNeeded() {
        if (initializing || textToSpeech != null) return;
        initializing = true;
        textToSpeech = new TextToSpeech(context, status -> {
            initializing = false;
            if (status != TextToSpeech.SUCCESS || textToSpeech == null) {
                failPending("Android text-to-speech is unavailable.");
                return;
            }

            int languageResult = textToSpeech.setLanguage(Locale.getDefault());
            if (languageResult == TextToSpeech.LANG_MISSING_DATA ||
                languageResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                failPending("The device language is unavailable for text-to-speech.");
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                textToSpeech.setAudioAttributes(SPEECH_ATTRIBUTES);
            }
            textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {}

                @Override
                public void onDone(String utteranceId) {
                    finishUtterance(utteranceId);
                }

                @Override
                public void onError(String utteranceId) {
                    finishUtterance(utteranceId);
                }

                @Override
                public void onStop(String utteranceId, boolean interrupted) {
                    finishUtterance(utteranceId);
                }
            });
            ready = true;
            while (!pending.isEmpty()) speakNow(pending.removeFirst());
        });
    }

    private void speakNow(SpeechRequest request) {
        if (textToSpeech == null) {
            if (request.callback != null) request.callback.onError("Android text-to-speech is unavailable.");
            return;
        }

        requestAudioFocus();
        textToSpeech.setSpeechRate(request.rate);
        textToSpeech.setPitch(request.pitch);
        String utteranceId = "roadsage_" + System.currentTimeMillis() + "_" + activeUtterances.size();
        int queueMode = request.interrupt ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
        if (request.interrupt) activeUtterances.clear();
        activeUtterances.add(utteranceId);

        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Bundle params = new Bundle();
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, request.volume);
            result = textToSpeech.speak(request.text, queueMode, params, utteranceId);
        } else {
            result = textToSpeech.speak(request.text, queueMode, null);
        }

        if (result == TextToSpeech.ERROR) {
            finishUtterance(utteranceId);
            if (request.callback != null) request.callback.onError("Android text-to-speech could not start.");
        } else if (request.callback != null) {
            request.callback.onAccepted();
        }
    }

    private synchronized void finishUtterance(String utteranceId) {
        activeUtterances.remove(utteranceId);
        if (activeUtterances.isEmpty()) abandonAudioFocus();
    }

    private void requestAudioFocus() {
        if (audioManager == null || hasAudioFocus) return;
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(SPEECH_ATTRIBUTES)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(focusListener)
                    .build();
            }
            result = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            result = audioManager.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
            );
        }
        hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonAudioFocus() {
        if (audioManager == null || !hasAudioFocus) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
        } else {
            audioManager.abandonAudioFocus(focusListener);
        }
        hasAudioFocus = false;
    }

    private void failPending(String message) {
        ready = false;
        if (textToSpeech != null) {
            textToSpeech.shutdown();
            textToSpeech = null;
        }
        while (!pending.isEmpty()) {
            SpeechRequest request = pending.removeFirst();
            if (request.callback != null) request.callback.onError(message);
        }
    }

    private static float clamp(float value, float min, float max) {
        if (Float.isNaN(value) || Float.isInfinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    private static final class SpeechRequest {
        final String text;
        final float rate;
        final float pitch;
        final float volume;
        final boolean interrupt;
        final Callback callback;

        SpeechRequest(String text, float rate, float pitch, float volume, boolean interrupt, Callback callback) {
            this.text = text;
            this.rate = rate;
            this.pitch = pitch;
            this.volume = volume;
            this.interrupt = interrupt;
            this.callback = callback;
        }
    }
}
