const roundImpact = (impact) => {
  const value = Number(impact);
  return Number.isFinite(value) ? Math.round(value) : 0;
};

const scoreImpact = (score, weight = 1) => {
  const value = Number(score);
  const factor = Number(weight);
  if (!Number.isFinite(value) || !Number.isFinite(factor) || factor <= 0) return null;
  return -roundImpact((100 - value) * factor);
};

const factor = (name, label, impact, details = {}) => ({
  factor: name,
  label,
  impact: roundImpact(impact),
  ...details,
});

const ranked = (items) => items
  .filter((item) => item && Number.isFinite(Number(item.impact)) && Number(item.impact) < 0)
  .sort((a, b) => a.impact - b.impact)
  .slice(0, 3);

export function explainScores(pipelineCtx = {}) {
  const stages = pipelineCtx.stages || {};
  const safetyBlend = stages.safety_blend?.weights || {};
  const smoothnessBlend = stages.smoothness_blend?.weights || {};
  const ecoBlend = stages.eco?.weights || {};
  const overallBlend = stages.overall_blend?.weights || {};

  const safety = ranked([
    stages.phone_use?.risk && stages.phone_use.risk !== 'none'
      ? factor('phone_use', 'Phone use detected while driving', -(stages.phone_use.scoreDeduction || 0), {
        risk: stages.phone_use.risk,
      })
      : null,
    scoreImpact(stages.speed_compliance?.score, safetyBlend.compliance) == null ? null : factor(
      'speeding',
      'Speed limit exceeded on portions of the route',
      scoreImpact(stages.speed_compliance.score, safetyBlend.compliance),
      { score: stages.speed_compliance.score }
    ),
    scoreImpact(stages.braking_efficiency?.score, safetyBlend.braking) == null ? null : factor(
      'braking_efficiency',
      'Hard or inefficient braking lowered safety',
      scoreImpact(stages.braking_efficiency.score, safetyBlend.braking),
      { score: stages.braking_efficiency.score }
    ),
    scoreImpact(stages.stop_start?.score, safetyBlend.stopStart) == null ? null : factor(
      'stop_start',
      'Repeated stop-start patterns lowered safety',
      scoreImpact(stages.stop_start.score, safetyBlend.stopStart),
      { score: stages.stop_start.score }
    ),
    scoreImpact(stages.lane_changing?.score, stages.lane_changing?.effectiveWeight ?? safetyBlend.laneChanging) == null ? null : factor(
      'lane_changing',
      'Lane-change behavior lowered safety',
      scoreImpact(stages.lane_changing.score, stages.lane_changing?.effectiveWeight ?? safetyBlend.laneChanging),
      { score: stages.lane_changing.score }
    ),
    stages.fatigue_adjustment?.deduction > 0
      ? factor('fatigue_risk', 'Long-drive fatigue risk lowered safety', -stages.fatigue_adjustment.deduction)
      : null,
  ]);

  const smoothness = ranked([
    scoreImpact(stages.jerk?.score, smoothnessBlend.jerk) == null ? null : factor(
      'smoothness_index',
      'Abrupt acceleration changes lowered smoothness',
      scoreImpact(stages.jerk.score, smoothnessBlend.jerk),
      { score: stages.jerk.score }
    ),
    scoreImpact(stages.svi?.score, smoothnessBlend.speedVariability) == null ? null : factor(
      'speed_variability',
      'Uneven speed control lowered smoothness',
      scoreImpact(stages.svi.score, smoothnessBlend.speedVariability),
      { score: stages.svi.score }
    ),
    scoreImpact(stages.brake_onset?.score, smoothnessBlend.brakeOnset) == null ? null : factor(
      'brake_onset',
      'Late or abrupt brake onset lowered smoothness',
      scoreImpact(stages.brake_onset.score, smoothnessBlend.brakeOnset),
      { score: stages.brake_onset.score }
    ),
    scoreImpact(stages.cornering?.score, smoothnessBlend.cornering) == null ? null : factor(
      'cornering',
      'Cornering consistency lowered smoothness',
      scoreImpact(stages.cornering.score, smoothnessBlend.cornering),
      { score: stages.cornering.score }
    ),
  ]);

  const eco = ranked([
    scoreImpact(stages.eco?.ecoDrivingScore, ecoBlend.ecoDriving) == null ? null : factor(
      'eco_driving',
      'Inefficient speed and idle patterns lowered Eco',
      scoreImpact(stages.eco.ecoDrivingScore, ecoBlend.ecoDriving),
      { score: stages.eco.ecoDrivingScore }
    ),
    scoreImpact(stages.eco?.fuelBandScore, ecoBlend.fuelBand) == null ? null : factor(
      'fuel_band',
      'Limited efficient cruising lowered Eco',
      scoreImpact(stages.eco.fuelBandScore, ecoBlend.fuelBand),
      { score: stages.eco.fuelBandScore }
    ),
  ]);

  const overall = ranked([
    scoreImpact(stages.safety_blend?.score, overallBlend.safety) == null ? null : factor(
      'safety',
      'Safety score was the largest drag on the trip score',
      scoreImpact(stages.safety_blend.score, overallBlend.safety),
      { score: stages.safety_blend.score }
    ),
    scoreImpact(stages.smoothness_blend?.score, overallBlend.smoothness) == null ? null : factor(
      'smoothness',
      'Smoothness score lowered the trip score',
      scoreImpact(stages.smoothness_blend.score, overallBlend.smoothness),
      { score: stages.smoothness_blend.score }
    ),
    scoreImpact(stages.eco?.score, overallBlend.eco) == null ? null : factor(
      'eco',
      'Eco score lowered the trip score',
      scoreImpact(stages.eco.score, overallBlend.eco),
      { score: stages.eco.score }
    ),
    scoreImpact(stages.intersection?.score, overallBlend.intersection) == null ? null : factor(
      'intersection',
      'Intersection behavior lowered the trip score',
      scoreImpact(stages.intersection.score, overallBlend.intersection),
      { score: stages.intersection.score }
    ),
  ]);

  return { overall, safety, smoothness, eco };
}
