/**
 * Motion-capture fidelity: the JS mirror of CaptureFidelityProfile.java.
 *
 * This is deliberately its own setting rather than a behaviour of
 * `experience_mode`. experience_mode is a *presentation* contract; if a cosmetic
 * toggle silently changed what lands on disk, trips recorded in coaching mode
 * and tracking mode would stop being comparable — score trends, trend series,
 * and compare/replay would all quietly go apples-to-oranges with no cause the
 * user could see. Extra storage also deserves its own consent moment, and a
 * coaching user who wants better crash and lane-change evidence should not be
 * locked out of it by an aesthetic preference.
 *
 * GPS cadence is identical under every fidelity. GPS dominates battery, 1 Hz
 * buys almost nothing over 0.5 Hz at the consumer-GPS noise floor, and changing
 * it is exactly what would break cross-setting comparability.
 */

import {
  CAPTURE_FIDELITY_HIGH_SAMPLE_BUDGET,
  CAPTURE_FIDELITY_STANDARD_SAMPLE_BUDGET,
} from '@/lib/appConstants';

export const CAPTURE_FIDELITY_STANDARD = 'standard';
export const CAPTURE_FIDELITY_HIGH = 'high';
export const CAPTURE_FIDELITY_VALUES = Object.freeze([CAPTURE_FIDELITY_STANDARD, CAPTURE_FIDELITY_HIGH]);
export const DEFAULT_CAPTURE_FIDELITY = CAPTURE_FIDELITY_STANDARD;

/** Rough on-disk cost of one stored motion sample, measured from real trip JSON. */
export const MOTION_SAMPLE_BYTES_ESTIMATE = 200;

const PROFILES = Object.freeze({
  [CAPTURE_FIDELITY_STANDARD]: Object.freeze({
    id: CAPTURE_FIDELITY_STANDARD,
    label: 'Standard motion capture',
    sampleBudget: CAPTURE_FIDELITY_STANDARD_SAMPLE_BUDGET,
    sampleMinIntervalMs: 100,
    eventWindowsEnabled: false,
    summary: 'Keeps roughly 10 motion samples per second, thinning older stretches on long drives.',
  }),
  [CAPTURE_FIDELITY_HIGH]: Object.freeze({
    id: CAPTURE_FIDELITY_HIGH,
    label: 'High motion capture',
    sampleBudget: CAPTURE_FIDELITY_HIGH_SAMPLE_BUDGET,
    sampleMinIntervalMs: 100,
    eventWindowsEnabled: true,
    summary: 'Keeps three times the motion history and adds full-rate bursts around harsh events and possible impacts.',
  }),
});

export function normalizeCaptureFidelity(value) {
  const id = String(value || '').trim().toLowerCase();
  return CAPTURE_FIDELITY_VALUES.includes(id) ? id : DEFAULT_CAPTURE_FIDELITY;
}

export function captureFidelityProfile(value) {
  return PROFILES[normalizeCaptureFidelity(value)];
}

export function captureFidelityLabel(value) {
  return captureFidelityProfile(value).label;
}

/** Worst-case stored motion bytes for one trip at this fidelity. */
export function estimateMotionBytesPerTrip(value) {
  return captureFidelityProfile(value).sampleBudget * MOTION_SAMPLE_BYTES_ESTIMATE;
}

export function formatMotionStorageEstimate(value) {
  const megabytes = estimateMotionBytesPerTrip(value) / (1024 * 1024);
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB per long trip`;
}

export const CAPTURE_FIDELITY_CONSENT_COPY =
  'Also record higher-fidelity motion data. Uses more storage; no additional GPS battery cost.';

/**
 * The consequence sentence shown alongside the toggle. Honest about both sides:
 * what it buys and what it costs.
 */
export function captureFidelityConsentDetail(value) {
  const profile = captureFidelityProfile(value);
  return `${profile.summary} About ${formatMotionStorageEstimate(profile.id)}. GPS rate and battery use are unchanged.`;
}

export const CAPTURE_FIDELITY_OPTIONS = CAPTURE_FIDELITY_VALUES.map((id) => ({
  value: id,
  label: PROFILES[id].label,
  detail: captureFidelityConsentDetail(id),
}));
