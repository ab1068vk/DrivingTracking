import { describe, expect, it } from 'vitest';
import {
  CAPTURE_FIDELITY_HIGH,
  CAPTURE_FIDELITY_OPTIONS,
  CAPTURE_FIDELITY_STANDARD,
  CAPTURE_FIDELITY_VALUES,
  DEFAULT_CAPTURE_FIDELITY,
  captureFidelityConsentDetail,
  captureFidelityLabel,
  captureFidelityProfile,
  estimateMotionBytesPerTrip,
  formatMotionStorageEstimate,
  normalizeCaptureFidelity,
} from '@/lib/captureFidelity';
import {
  CAPTURE_FIDELITY_HIGH_SAMPLE_BUDGET,
  CAPTURE_FIDELITY_STANDARD_SAMPLE_BUDGET,
} from '@/lib/appConstants';

describe('captureFidelity', () => {
  it('defaults to standard, which is how every install already recorded', () => {
    expect(DEFAULT_CAPTURE_FIDELITY).toBe(CAPTURE_FIDELITY_STANDARD);
    expect(captureFidelityProfile(DEFAULT_CAPTURE_FIDELITY).sampleBudget)
      .toBe(CAPTURE_FIDELITY_STANDARD_SAMPLE_BUDGET);
  });

  it('normalizes unknown, blank, and mis-cased values to standard', () => {
    expect(normalizeCaptureFidelity('HIGH')).toBe(CAPTURE_FIDELITY_HIGH);
    expect(normalizeCaptureFidelity(' high ')).toBe(CAPTURE_FIDELITY_HIGH);
    expect(normalizeCaptureFidelity('ultra')).toBe(CAPTURE_FIDELITY_STANDARD);
    expect(normalizeCaptureFidelity('')).toBe(CAPTURE_FIDELITY_STANDARD);
    expect(normalizeCaptureFidelity(null)).toBe(CAPTURE_FIDELITY_STANDARD);
    expect(normalizeCaptureFidelity(undefined)).toBe(CAPTURE_FIDELITY_STANDARD);
    expect(normalizeCaptureFidelity(42)).toBe(CAPTURE_FIDELITY_STANDARD);
  });

  it('gives high fidelity a larger budget and event windows', () => {
    const high = captureFidelityProfile(CAPTURE_FIDELITY_HIGH);
    const standard = captureFidelityProfile(CAPTURE_FIDELITY_STANDARD);

    expect(high.sampleBudget).toBe(CAPTURE_FIDELITY_HIGH_SAMPLE_BUDGET);
    expect(high.sampleBudget).toBeGreaterThan(standard.sampleBudget);
    expect(high.eventWindowsEnabled).toBe(true);
    expect(standard.eventWindowsEnabled).toBe(false);
  });

  it('keeps the sampling interval identical across fidelities', () => {
    // Only how much is kept changes. The IMU registration rate and the GPS
    // cadence are the same either way, which is what keeps trips comparable.
    expect(captureFidelityProfile(CAPTURE_FIDELITY_HIGH).sampleMinIntervalMs)
      .toBe(captureFidelityProfile(CAPTURE_FIDELITY_STANDARD).sampleMinIntervalMs);
  });

  it('estimates storage proportionally to the budget', () => {
    expect(estimateMotionBytesPerTrip(CAPTURE_FIDELITY_HIGH))
      .toBe(estimateMotionBytesPerTrip(CAPTURE_FIDELITY_STANDARD) * 3);
    expect(formatMotionStorageEstimate(CAPTURE_FIDELITY_STANDARD)).toMatch(/MB per long trip$/);
  });

  it('states both the benefit and the storage cost in consent copy', () => {
    const detail = captureFidelityConsentDetail(CAPTURE_FIDELITY_HIGH);

    expect(detail).toContain('MB per long trip');
    expect(detail).toContain('battery use are unchanged');
  });

  it('offers exactly the supported values as selectable options', () => {
    expect(CAPTURE_FIDELITY_OPTIONS.map((option) => option.value)).toEqual([...CAPTURE_FIDELITY_VALUES]);
    CAPTURE_FIDELITY_OPTIONS.forEach((option) => {
      expect(option.label).toBe(captureFidelityLabel(option.value));
      expect(option.detail.length).toBeGreaterThan(0);
    });
  });
});
