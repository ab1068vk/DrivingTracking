import { describe, expect, it } from 'vitest';
import { SPEED_ALERT_MIN_CONFIDENCE } from '@/lib/appConstants';
import {
  confidenceForSource,
  meetsAlertConfidenceFloor,
  speedAlertPolicy,
  speedPenaltyWeightForConfidence,
  visualAlertMarginKmh,
  voiceAlertMarginKmh,
} from '@/lib/speed/speedConfidencePolicy';
import { assessSpeedLimitEvidence } from '@/lib/speedLimitConfidence';

const TIERS = ['POSTED', 'MAP_ESTIMATED', 'LEARNED_LOCAL', 'REGION_DEFAULT', 'GPS_INFERRED', 'UNKNOWN'];

const speakingSettings = {
  voice_alerts_enabled: true,
  speak_posted_speed_warnings: true,
  speak_estimated_speed_checks: true,
};

describe('voice margin is never tighter than the visual margin', () => {
  it('holds for every tier, confidence and margin setting', () => {
    for (const tier of TIERS) {
      for (let confidence = 0; confidence <= 1.0001; confidence += 0.05) {
        for (const baseMargin of [0, 3, 5, 10, 20]) {
          for (const estimatedVoiceMargin of [0, 1, 5, 12, 25, '', null]) {
            for (const inferredVoiceMargin of [0, 2, 12, 30, '', undefined]) {
              const policy = speedAlertPolicy({ tier, confidence }, {
                ...speakingSettings,
                threshold_speed_over_kmh: baseMargin,
                estimated_voice_margin_kmh: estimatedVoiceMargin,
                inferred_voice_margin_kmh: inferredVoiceMargin,
              });
              expect(policy.voiceMarginKmh).toBeGreaterThanOrEqual(policy.visualMarginKmh);
            }
          }
        }
      }
    }
  });

  it('fixes the specific GPS_INFERRED inversion', () => {
    // GPS_INFERRED confidence 0.35 -> visual margin 5 + 15 = 20, while the
    // estimated voice margin setting was a flat 12. The app spoke at +12 but
    // refused to display until +20.
    const visual = visualAlertMarginKmh(0.35, 5);
    expect(visual).toBe(20);
    expect(voiceAlertMarginKmh('GPS_INFERRED', { estimated_voice_margin_kmh: 12 }, visual)).toBe(20);
  });
});

describe('inferred_voice_margin_kmh', () => {
  it('is read for the GPS_INFERRED tier instead of being declared and ignored', () => {
    const visual = 20;
    expect(voiceAlertMarginKmh('GPS_INFERRED', {
      estimated_voice_margin_kmh: 12,
      inferred_voice_margin_kmh: 30,
    }, visual)).toBe(30);
  });

  it('falls back to the estimated margin when unset', () => {
    expect(voiceAlertMarginKmh('GPS_INFERRED', { estimated_voice_margin_kmh: 25 }, 20)).toBe(25);
  });

  it('does not apply to the estimated tiers', () => {
    expect(voiceAlertMarginKmh('LEARNED_LOCAL', {
      estimated_voice_margin_kmh: 12,
      inferred_voice_margin_kmh: 30,
    }, 8)).toBe(12);
  });
});

describe('alert confidence floor', () => {
  it('matches the floor the native service applies', () => {
    expect(SPEED_ALERT_MIN_CONFIDENCE).toBe(0.55);
    expect(meetsAlertConfidenceFloor(0.55)).toBe(true);
    expect(meetsAlertConfidenceFloor(0.54)).toBe(false);
    expect(meetsAlertConfidenceFloor(null)).toBe(false);
  });

  it('blocks speech for a low-confidence guess even when estimate speech is on', () => {
    const policy = speedAlertPolicy({ tier: 'GPS_INFERRED', confidence: 0.35 }, speakingSettings);
    expect(policy.meetsConfidenceFloor).toBe(false);
    expect(policy.voiceAllowed).toBe(false);
  });

  it('still allows speech for a corroborated learned limit', () => {
    const policy = speedAlertPolicy({ tier: 'LEARNED_LOCAL', confidence: 0.7 }, speakingSettings);
    expect(policy.voiceAllowed).toBe(true);
  });

  it('is overridable per settings', () => {
    const policy = speedAlertPolicy({ tier: 'GPS_INFERRED', confidence: 0.35 }, {
      ...speakingSettings,
      speed_alert_min_confidence: 0.3,
    });
    expect(policy.voiceAllowed).toBe(true);
  });
});

describe('penalty weight', () => {
  it('is monotonic in confidence', () => {
    let previous = -1;
    for (let confidence = 0; confidence <= 1.0001; confidence += 0.01) {
      const weight = speedPenaltyWeightForConfidence(confidence);
      expect(weight).toBeGreaterThanOrEqual(previous);
      previous = weight;
    }
  });

  it('charges nothing for a limit below the scoring floor', () => {
    expect(speedPenaltyWeightForConfidence(0.29)).toBe(0);
    expect(speedPenaltyWeightForConfidence(NaN)).toBe(0);
  });

  it('reads a resolved confidence in preference to the source profile', () => {
    // A stale or conflicted learned limit resolves lower than its profile default.
    expect(confidenceForSource('learned_local')).toBe(0.65);
    expect(confidenceForSource('learned_local', 0.31)).toBe(0.31);
    expect(speedPenaltyWeightForConfidence(confidenceForSource('learned_local', 0.31))).toBe(0.5);
    // A source without its own accumulated evidence keeps the profile value.
    expect(confidenceForSource('openstreetmap', 0.2)).toBe(0.9);
  });
});

describe('corroboration bonus requires agreement', () => {
  const learnedCell = { source: 'learned_local', confidence: 0.6, lastUpdatedAt: new Date().toISOString() };

  it('is granted when the evidence agrees', () => {
    const evidence = assessSpeedLimitEvidence({ ...learnedCell, evidenceCount: 4 });
    expect(evidence.confidence).toBeCloseTo(0.65, 5);
    expect(evidence.agreeingEvidenceCount).toBe(4);
  });

  it('is withheld when the evidence conflicts', () => {
    // The learner used to increment evidenceCount on the disagreement branch, so
    // contradicting a saved limit three times raised its confidence by 0.05.
    const evidence = assessSpeedLimitEvidence({ ...learnedCell, evidenceCount: 4, conflict: true });
    expect(evidence.agreeingEvidenceCount).toBe(0);
    expect(evidence.confidence).toBeCloseTo(0.38, 5);
  });

  it('is withheld when the agreement ratio is too low', () => {
    const evidence = assessSpeedLimitEvidence({
      ...learnedCell,
      evidenceCount: 9,
      agreeingEvidenceCount: 4,
      agreementRatio: 0.44,
    });
    expect(evidence.confidence).toBeCloseTo(0.6, 5);
    expect(evidence.agreementRatio).toBe(0.44);
  });

  it('is granted on a high agreement ratio', () => {
    const evidence = assessSpeedLimitEvidence({
      ...learnedCell,
      evidenceCount: 9,
      agreeingEvidenceCount: 8,
      agreementRatio: 0.89,
    });
    expect(evidence.confidence).toBeCloseTo(0.65, 5);
  });
});
