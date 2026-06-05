# Road Sage Voice Alerts

Road Sage voice alerts are on-device speech prompts used during active trips for live coaching, speed warnings, phone-use warnings, repeated-event-area warnings, heading-drift beta prompts, long-drive reminders, idling prompts, and possible incident check-ins. They do not use the microphone, do not send audio to a cloud speech service, and do not require a paid AI service.

## Current Architecture

| Layer | File | Responsibility |
| --- | --- | --- |
| Shared speech helper | `src/lib/voiceAlerts.js` | Normalizes messages, checks `voice_alerts_enabled`, routes native speech through the Capacitor plugin when available, falls back to Web Speech, and tracks keyed cooldowns. |
| Live trip overlay | `src/components/LiveCoachOverlay.jsx` | Evaluates route points and detected events every 15 seconds, queues one visible alert at a time, speaks the alert, and logs handled speech failures. |
| Dashboard direct alerts | `src/pages/Dashboard.jsx` | Speaks higher-level driving warnings that are not owned by the overlay, including repeated-event areas, heading-drift patterns, speed warnings, and possible incident check-ins. |
| Android Capacitor bridge | `android/app/src/main/java/com/roadsage/app/DriveSenseActivityRecognitionPlugin.java` | Exposes `speakText` to JavaScript and uses Android `TextToSpeech` with the device locale. |
| Android native tracking service | `android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java` | Speaks native phone-use warnings while background auto tracking is running, even when the web UI is not actively driving the prompt. |
| Settings UI | `src/settings/sections/AdvancedSettings.jsx`, `src/settings/sections/TrackingSettings.jsx`, `src/settings/sections/ScoringSettings.jsx` | Lets users enable voice alerts, test speech output, enable live coaching, configure phone-use live alerts, and control speed warning behavior. |
| Defaults and persistence | `src/lib/trackingStore.js` | Defines defaults and sanitization for `voice_alerts_enabled`, `live_coaching_enabled`, `phone_use_live_alert_enabled`, `speed_warning_enabled`, and related notification toggles. |

## Important Code Snippets

These excerpts show the current voice-alert control flow. Keep them synchronized when changing speech backend behavior, cooldowns, live-coach priority, or native phone-use warnings.

### Shared Speech Backend

From `src/lib/voiceAlerts.js`, all normal JavaScript callers go through `speakSafetyAlert()`. It gates on `voice_alerts_enabled`, tries native Android TTS first, then falls back to browser Web Speech.

```javascript
export async function speakSafetyAlert(text, settings = localSettings.get()) {
  const message = String(text || '').trim();
  if (!message || settings.voice_alerts_enabled === false || typeof window === 'undefined') return false;

  if (isNativePlatform()) {
    try {
      await NativeSpeech.speakText({ text: message });
      return true;
    } catch {
      // Fall through to Web Speech for browser/WebView cases without the native bridge.
    }
  }

  if (!window.speechSynthesis) return false;
  const Utterance = window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
  if (!Utterance) return false;

  const utterance = new Utterance(message);
  utterance.rate = 0.95;
  utterance.volume = 0.95;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
  return true;
}
```

### Shared Cooldown Gate

`speakSafetyAlertOnce()` only records a cooldown after speech succeeds. This avoids silencing future alerts when TTS is unavailable.

```javascript
export function canSpeakSafetyAlert(key, cooldownMs = 0, now = Date.now()) {
  if (!key || !cooldownMs) return true;
  const last = lastSpokenAtByKey.get(key);
  if (!last) return true;
  return now - last >= cooldownMs;
}

export async function speakSafetyAlertOnce(key, text, settings = localSettings.get(), cooldownMs = 0, now = Date.now()) {
  if (!canSpeakSafetyAlert(key, cooldownMs, now)) return false;
  const spoken = await speakSafetyAlert(text, settings);
  if (spoken && key) lastSpokenAtByKey.set(key, now);
  return spoken;
}
```

### Live Coach Queue And Speech Dispatch

From `src/components/LiveCoachOverlay.jsx`, the overlay speaks the plain-text version of the displayed alert and logs handled speech failures.

```javascript
const showNext = () => {
  if (visibleRef.current || queueRef.current.length === 0) return;
  visibleRef.current = true;
  const next = queueRef.current.shift();
  const normalized = typeof next === 'string' ? { text: next, tone: 'default' } : next;
  const settings = localSettings.get();
  const voiceText = plainText(normalized.text);
  const speak = normalized.voiceKey
    ? speakSafetyAlertOnce(normalized.voiceKey, voiceText, settings, normalized.voiceCooldownMs)
        .catch((err) => logError('live_coach_voice_alert_once', err, { voiceKey: normalized.voiceKey }))
    : speakSafetyAlert(voiceText, settings)
        .catch((err) => logError('live_coach_voice_alert', err));
  void speak;
  if (!dismissed) setMessage(normalized);
};
```

### Live Coach Priority Example

The overlay intentionally picks one `nextMessage` in priority order. Phone use wins over other warnings, then brake-turn/heading/speed/driving-style prompts follow.

```javascript
let nextMessage = null;
const livePhoneAlertsEnabled =
  settings.phone_use_detection_enabled !== false &&
  settings.phone_use_live_alert_enabled !== false;

if (newPhoneWindows.length > 0 && livePhoneAlertsEnabled) {
  nextMessage = {
    text: (
      <>
        <span className="block text-sm font-bold uppercase">Put your phone down</span>
        <span className="block text-xs font-medium">
          Phone activity was recorded during this drive. Keep your eyes on the road.
        </span>
      </>
    ),
    tone: 'danger',
    displayMs: PHONE_DISPLAY_MS,
    voiceKey: 'phone_use',
    voiceCooldownMs: VOICE_COOLDOWNS_MS.phone_use,
  };
} else if (recentCloseProximity) {
  nextMessage = {
    text: 'Estimated brake-turn manoeuvre alert. Review conditions when safe.',
    voiceKey: 'close_proximity',
    voiceCooldownMs: VOICE_COOLDOWNS_MS.close_proximity,
  };
} else if (settings.speed_warning_enabled !== false && latestSpeed > latestSpeedLimit + thresholds.SPEED_OVER_KMH) {
  nextMessage = {
    text: `Speed warning. ${Math.round(latestSpeed)} kilometers per hour.`,
    voiceKey: 'speeding',
    voiceCooldownMs: VOICE_COOLDOWNS_MS.speeding,
  };
}
```

### Android Plugin TTS Bridge

From `DriveSenseActivityRecognitionPlugin.java`, native speech uses Android `TextToSpeech`, device locale, rate `0.95`, and `QUEUE_FLUSH`.

```java
@PluginMethod
public void speakText(PluginCall call) {
    String text = call.getString("text", "");
    if (text == null || text.trim().isEmpty()) {
        call.reject("text is required.");
        return;
    }

    if (textToSpeech != null && textToSpeechReady) {
        speakNow(text);
        call.resolve();
        return;
    }

    textToSpeech = new TextToSpeech(getContext(), status -> {
        if (status != TextToSpeech.SUCCESS || textToSpeech == null) {
            call.reject("Android text-to-speech is unavailable.");
            return;
        }
        textToSpeech.setLanguage(Locale.getDefault());
        textToSpeech.setSpeechRate(0.95f);
        textToSpeechReady = true;
        speakNow(text);
        call.resolve();
    });
}

private void speakNow(String text) {
    if (textToSpeech == null) return;
    String utteranceId = "roadsage_" + System.currentTimeMillis();
    textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
}
```

### Native Background Phone-Use Warning

From `RoadSageAutoTrackingService.java`, the native service can speak a phone-use warning even when the React overlay is not driving the prompt.

```java
private void checkAndroidUsageAccessPhoneUse(long nowMs) {
    if (!isSettingEnabled("phone_use_detection_enabled", true) ||
        !isSettingEnabled("phone_use_live_alert_enabled", true)) return;
    if (activeStartMs <= 0L || !DriveSensePhoneUsageTracker.hasUsageAccess(this)) return;

    JSONObject usage = DriveSensePhoneUsageTracker.queryTripUsage(
        this,
        Math.max(activeStartMs, nowMs - ANDROID_USAGE_ACCESS_LOOKBACK_MS),
        nowMs
    );
    JSONArray sessions = usage.optJSONArray("events");
    if (sessions == null || sessions.length() == 0) return;

    JSONObject latest = sessions.optJSONObject(sessions.length() - 1);
    long startMs = latest.optLong("start_ms", 0L);
    long durationSeconds = latest.optLong("duration_seconds", 0L);
    if (startMs <= lastNativePhoneWindowMs || durationSeconds < 5L || lastKnownSpeedKmh < 15d) return;

    lastNativePhoneWindowMs = startMs;
    if (nowMs - lastPhoneUseNotifyMs > PHONE_NOTIFY_COOLDOWN_MS) {
        sendPhoneUseWarningNotification();
        if (isSettingEnabled("voice_alerts_enabled", true)) {
            speakNativeAlert("Put your phone down. Keep your eyes on the road.");
        }
        lastPhoneUseNotifyMs = nowMs;
    }
}
```

## Speech Backends

`speakSafetyAlert(text, settings)` is the primary helper.

1. Empty messages are ignored.
2. If `settings.voice_alerts_enabled === false`, speech is skipped.
3. If the app is running natively, Road Sage calls the Capacitor `DriveSenseActivityRecognition.speakText({ text })` bridge.
4. If native speech fails or the app is running in the browser, Road Sage falls back to `window.speechSynthesis`.
5. Web Speech utterances use rate `0.95`, volume `0.95`, cancel any queued utterance, then speak the new prompt.

Android native TTS also uses the device default locale and speech rate `0.95`. The native service shuts TTS down when the service or plugin is destroyed.

## Settings

| Setting key | Default | Meaning |
| --- | ---: | --- |
| `voice_alerts_enabled` | `true` | Master switch for spoken alerts. The Settings page exposes this as "Live voice alerts" with a Test button. |
| `live_coaching_enabled` | `true` | Enables the live coach overlay and its spoken prompts during active trips. |
| `phone_use_live_alert_enabled` | `true` | Enables immediate phone-use warnings for Android Usage Access detections. The UI syncs this with `notif_phone_use_alert_enabled`. |
| `phone_use_detection_enabled` | `true` | Must remain enabled before phone-use live alerts can run. |
| `speed_warning_enabled` | `true` | Enables live speed-warning behavior. |
| `threshold_speed_over_kmh` | `5` | Margin above the effective speed limit before a speed warning is spoken. |
| `threshold_speeding_kmh` | `100` | Fallback limit when no posted or inferred limit is available. |
| `threshold_long_drive_minutes` | `120` | Long-drive reminder threshold. |
| `danger_zone_alerts_enabled` | `true` | Enables repeated-event-area warnings. |
| `advanced_safety_detection_enabled` | `true` | Required for Dashboard heading-drift beta alerts. |
| `emergency_workflow_enabled` | `false` | Changes possible incident wording to keep a local check-in workflow active. |

Notification toggles are separate from voice alerts. For example, disabling `notif_speeding_alert_enabled` can suppress a native notification, but spoken speed prompts still depend on `speed_warning_enabled` and `voice_alerts_enabled`.

## Live Coach Prompts

`LiveCoachOverlay` runs only when there is an active trip start time and at least two route points. It checks every 15 seconds, calculates current trip stats, detects recent driving events, merges Android Usage Access phone-use evidence when available, then queues one alert at a time. Normal alerts display for 8 seconds; phone-use alerts display for 15 seconds.

The overlay uses this priority order:

| Priority | Voice key | Prompt | Conditions | Cooldown |
| ---: | --- | --- | --- | ---: |
| 1 | `phone_use` | "Put your phone down..." | New phone-use window since the last coach check, phone-use detection enabled, and live phone alerts enabled. | 120 seconds |
| 2 | `close_proximity` | "Estimated brake-turn manoeuvre alert. Review conditions when safe." | Recent `close_proximity` or legacy `near_miss` event within the last 120 seconds. | 120 seconds |
| 3 | `heading_drift_beta` | "GPS heading variation pattern recorded. Take a break if you feel tired." | Current stats report `heading_drift_beta_level === "high"`. | 10 minutes |
| 4 | `speeding` | "Speed warning..." | Latest speed exceeds the effective limit plus `threshold_speed_over_kmh`. | 60 seconds |
| 5 | `harsh_brake` | "Brake earlier and more gradually" | Harsh-brake count increased since the previous coach check. | 30 seconds |
| 6 | `stop_start_pattern` | "Repeated stop-start pattern recorded" | Stop-start or tailgate-cycle count increased. | 60 seconds |
| 7 | `rapid_accel` | "Accelerate more smoothly" | Rapid-acceleration count increased. | 30 seconds |
| 8 | `long_drive` | "Long drive reminder..." | Trip duration reaches `threshold_long_drive_minutes`. | 30 minutes |
| 9 | `idle` | "Extended idling recorded" | Idle time exceeds 300 seconds. | 5 minutes |

The overlay also schedules matching native notifications for phone use, speeding, heading-drift beta, and long-drive reminders when their notification settings allow it. Notification failures and speech failures are logged through `logError`.

## Dashboard Direct Voice Alerts

Some voice alerts are emitted outside `LiveCoachOverlay` because they are tied to Dashboard tracking state rather than the overlay queue.

| Alert | Condition | Cooldown / guard | Related settings |
| --- | --- | --- | --- |
| Heading-drift beta pattern | Active trip has at least 8 points in the last 5 minutes, at least 5 heading samples, at least 80% highway-speed points, and angular standard deviation above `threshold_heading_drift_std_degs`. | 10 minutes. | `advanced_safety_detection_enabled`, `voice_alerts_enabled` |
| Repeated-event area ahead | Current point is outside privacy zones, the trip is not a candidate trip, repeated-event-area alerts are enabled, and a stored repeated-event area is within 300 m. | 60 seconds. | `danger_zone_alerts_enabled`, `voice_alerts_enabled` |
| Dashboard speed warning | Current point is not in a candidate trip and speed exceeds the effective or fallback limit plus the configured margin. | `speakSafetyAlertOnce("speeding", ..., 60 seconds)`. | `speed_warning_enabled`, `voice_alerts_enabled` |
| Possible incident signal | Sensor fusion detects impact-like motion followed by little movement. | 5 minutes. | `voice_alerts_enabled`, `emergency_workflow_enabled` |

Repeated-event-area checks respect privacy zones before warning or speaking, so private-zone points do not trigger nearby-area speech. Possible incident prompts are local check-in prompts only; they are not crash diagnoses and do not contact emergency services.

## Android Native Phone-Use Voice Alert

`RoadSageAutoTrackingService` can speak a phone-use warning from native code while the foreground service is tracking. This path is separate from the React overlay and exists so a warning can fire from the Android tracking service.

Native phone-use speech requires:

- `phone_use_detection_enabled !== false`
- `phone_use_live_alert_enabled !== false`
- Android Usage Access permission
- an active non-candidate trip
- a Usage Access session in the last 120 seconds
- the detected app session duration is at least 5 seconds
- current speed is at least 15 km/h
- the native phone-use notification cooldown has elapsed
- `voice_alerts_enabled !== false`

The native spoken text is:

```text
Put your phone down. Keep your eyes on the road.
```

Native phone-use notifications use the Safety Alerts notification channel, high priority, vibration, and the same 120-second cooldown.

## Cooldowns And De-Duplication

`speakSafetyAlertOnce(key, text, settings, cooldownMs, now)` prevents repeated speech for keyed alerts. A key is recorded only after speech succeeds. Unkeyed alerts are allowed without cooldown tracking.

There are two cooldown layers in several paths:

- display or alert cooldowns in the caller, such as `lastDisplayedAlertRef`, repeated-event-area guards, and incident guards
- shared speech cooldowns in `src/lib/voiceAlerts.js`

This keeps the UI from queueing duplicate banners and keeps speech from repeating when multiple code paths notice the same condition.

## Notifications Versus Voice

Voice alerts and notifications are intentionally related but separate.

- Voice uses `voice_alerts_enabled`.
- Native notifications use `notifications_enabled` plus channel-specific toggles such as `notif_safety_alerts_enabled`, `notif_phone_use_alert_enabled`, `notif_speeding_alert_enabled`, and `notif_heading_drift_alert_enabled`.
- Quiet hours affect notification helpers, but the current voice helper does not check quiet hours directly.
- Dashboard and overlay paths often emit both a spoken prompt and a notification for the same safety condition when both feature sets are enabled.

## Privacy And Safety Notes

- Voice alerts run on device through Android TextToSpeech or browser Web Speech.
- Road Sage does not record microphone audio for voice alerts.
- No voice-alert text is sent to a cloud TTS provider by Road Sage.
- Repeated-event-area voice checks skip locations inside privacy zones.
- Phone-use voice alerts depend on Android Usage Access evidence where available.
- Estimated brake-turn, heading-drift beta, repeated-event-area, and possible incident prompts are advisory. They are not calibrated crash, fatigue, following-distance, or emergency outcomes.
- Possible incident prompts are local check-in prompts. Road Sage does not call emergency services or send SMS from this path.

## Diagnostics And Failure Handling

Handled voice-alert failures are reported through `logError` with contexts such as:

- `live_coach_voice_alert_once`
- `live_coach_voice_alert`
- `voice_alert_heading_drift_pattern`
- `voice_alert_repeated_event_area`
- `voice_alert_speeding`
- `voice_alert_possible_incident`

The Settings Test button calls `testVoiceAlert()`, which speaks:

```text
Road Sage voice alerts are working.
```

The UI reports either "Voice test sent." or "Speech output is unavailable in this browser/WebView."

## Tests

Current direct coverage lives in `src/lib/__tests__/voiceAlerts.test.js`.

Covered behavior:

- unkeyed alerts are allowed without cooldown tracking
- keyed alerts are throttled after a successful spoken message
- keyed alerts become eligible again once the cooldown expires

Related notification, tracking, sensor-fusion, and release-blocker tests cover the surrounding alert ecosystem, but the direct voice test file currently focuses on shared speech cooldown behavior.

## Maintenance Checklist

When adding or changing a voice alert:

1. Add or reuse a stable `voiceKey` when repeat suppression matters.
2. Choose a cooldown that matches the safety urgency and expected signal frequency.
3. Keep spoken text short and action-oriented.
4. Gate the alert with `voice_alerts_enabled` by using `speakSafetyAlert` or `speakSafetyAlertOnce`.
5. Decide whether a matching native notification is needed and wire the corresponding notification toggle.
6. Avoid speaking private locations, addresses, or raw coordinates.
7. Log handled failures with `logError` so Diagnostics can explain silent speech failures.
8. Add or update tests when the cooldown, setting gate, or trigger logic changes.
