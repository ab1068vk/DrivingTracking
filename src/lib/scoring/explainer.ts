import type { ScoreExplanation, ScoreExplanationFactor } from '@/types';

type ScoringStage = Record<string, unknown>;

interface ExplainablePipelineContext {
  stages?: Record<string, ScoringStage>;
}

const numericField = (stage: ScoringStage | undefined, field: string): number | null => {
  const value = Number(stage?.[field]);
  return Number.isFinite(value) ? value : null;
};

const stringField = (stage: ScoringStage | undefined, field: string): string | null => {
  const value = stage?.[field];
  return typeof value === 'string' ? value : null;
};

const recordField = (stage: ScoringStage | undefined, field: string): Record<string, unknown> => {
  const value = stage?.[field];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

const roundImpact = (impact: number): number => {
  const value = Number(impact);
  return Number.isFinite(value) ? Math.round(value) : 0;
};

const scoreImpact = (score: unknown, weight: unknown = 1): number | null => {
  const value = Number(score);
  const factor = Number(weight);
  if (!Number.isFinite(value) || !Number.isFinite(factor) || factor <= 0) return null;
  return -roundImpact((100 - value) * factor);
};

const factor = (
  name: string,
  label: string,
  impact: number,
  details: Record<string, unknown> = {}
): ScoreExplanationFactor => ({
  factor: name,
  label,
  impact: roundImpact(impact),
  ...details,
});

const ranked = (items: Array<ScoreExplanationFactor | null>): ScoreExplanationFactor[] => items
  .filter((item): item is ScoreExplanationFactor => Boolean(item) && Number.isFinite(Number(item?.impact)) && Number(item?.impact) < 0)
  .sort((a, b) => a.impact - b.impact)
  .slice(0, 3);

const scoreFactor = (
  stage: ScoringStage | undefined,
  weight: unknown,
  factorName: string,
  label: string,
  scoreField = 'score'
): ScoreExplanationFactor | null => {
  const score = numericField(stage, scoreField);
  const impact = scoreImpact(score, weight);
  return impact == null ? null : factor(factorName, label, impact, { score });
};

export function explainScores(pipelineCtx: ExplainablePipelineContext = {}): ScoreExplanation {
  const stages = pipelineCtx.stages || {};
  const safetyBlend = recordField(stages.safety_blend, 'weights');
  const smoothnessBlend = recordField(stages.smoothness_blend, 'weights');
  const ecoBlend = recordField(stages.eco, 'weights');
  const overallBlend = recordField(stages.overall_blend, 'weights');

  const safety = ranked([
    stringField(stages.phone_use, 'risk') && stringField(stages.phone_use, 'risk') !== 'none'
      ? factor('phone_use', 'Phone use detected while driving', -(numericField(stages.phone_use, 'scoreDeduction') || 0), {
        risk: stringField(stages.phone_use, 'risk') || undefined,
      })
      : null,
    scoreFactor(
      stages.speed_compliance,
      safetyBlend.compliance,
      'speeding',
      'Speed limit exceeded on portions of the route'
    ),
    scoreFactor(
      stages.braking_efficiency,
      safetyBlend.braking,
      'braking_efficiency',
      'Hard or inefficient braking lowered safety'
    ),
    scoreFactor(
      stages.stop_start,
      safetyBlend.stopStart,
      'stop_start',
      'Repeated stop-start patterns lowered safety'
    ),
    scoreFactor(
      stages.lane_changing,
      stages.lane_changing?.effectiveWeight ?? safetyBlend.laneChanging,
      'lane_changing',
      'Lane-change behavior lowered safety'
    ),
    (numericField(stages.fatigue_adjustment, 'deduction') || 0) > 0
      ? factor('fatigue_risk', 'Long-drive fatigue risk lowered safety', -(numericField(stages.fatigue_adjustment, 'deduction') || 0))
      : null,
  ]);

  const smoothness = ranked([
    scoreFactor(
      stages.jerk,
      smoothnessBlend.jerk,
      'smoothness_index',
      'Abrupt acceleration changes lowered smoothness'
    ),
    scoreFactor(
      stages.svi,
      smoothnessBlend.speedVariability,
      'speed_variability',
      'Uneven speed control lowered smoothness'
    ),
    scoreFactor(
      stages.brake_onset,
      smoothnessBlend.brakeOnset,
      'brake_onset',
      'Late or abrupt brake onset lowered smoothness'
    ),
    scoreFactor(
      stages.cornering,
      smoothnessBlend.cornering,
      'cornering',
      'Cornering consistency lowered smoothness'
    ),
  ]);

  const eco = ranked([
    scoreFactor(
      stages.eco,
      ecoBlend.ecoDriving,
      'eco_driving',
      'Inefficient speed and idle patterns lowered Eco',
      'ecoDrivingScore'
    ),
    scoreFactor(
      stages.eco,
      ecoBlend.fuelBand,
      'fuel_band',
      'Limited efficient cruising lowered Eco',
      'fuelBandScore'
    ),
  ]);

  const overall = ranked([
    scoreFactor(
      stages.safety_blend,
      overallBlend.safety,
      'safety',
      'Safety score was the largest drag on the trip score'
    ),
    scoreFactor(
      stages.smoothness_blend,
      overallBlend.smoothness,
      'smoothness',
      'Smoothness score lowered the trip score'
    ),
    scoreFactor(
      stages.eco,
      overallBlend.eco,
      'eco',
      'Eco score lowered the trip score'
    ),
    scoreFactor(
      stages.intersection,
      overallBlend.intersection,
      'intersection',
      'Intersection behavior lowered the trip score'
    ),
  ]);

  return { overall, safety, smoothness, eco };
}
