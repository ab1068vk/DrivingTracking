// src/lib/voiceProfileGate.js
// Decides whether a voice alert should play given the user's profile settings.
// All checks are local: time comes from the device clock, no network.

import { isVoiceAlertEnabled } from '@/lib/voiceAlerts';
import { ALERT_PRIORITY } from '@/lib/voiceAlertMessages';

function parseTime(value = '00:00') {
  const [rawHour = '0', rawMinute = '0'] = String(value ?? '00:00').split(':');
  const hour = Math.max(0, Math.min(23, parseInt(rawHour, 10) || 0));
  const minute = Math.max(0, Math.min(59, parseInt(rawMinute, 10) || 0));
  return [hour, minute];
}

function isWithinQuietHours(settings = {}, now = Date.now()) {
  const [startHour, startMinute] = parseTime(settings.voice_quiet_hours_start ?? '22:00');
  const [endHour, endMinute] = parseTime(settings.voice_quiet_hours_end ?? '06:00');
  const date = new Date(now);
  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  if (startMinutes === endMinutes) return false;
  return startMinutes <= endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Returns true when the alert should play, false when profile settings block it.
 */
export function isAlertAllowedByProfile(key, settings = {}, now = Date.now()) {
  if (!isVoiceAlertEnabled(settings)) return false;

  const alertPriority = ALERT_PRIORITY[key] ?? 1;
  const minSeverity = Number(settings.voice_alerts_min_severity ?? 1);
  if (alertPriority < minSeverity) return false;

  if (
    settings.voice_quiet_hours_enabled === true &&
    alertPriority < 3 &&
    isWithinQuietHours(settings, now)
  ) {
    return false;
  }

  return true;
}
