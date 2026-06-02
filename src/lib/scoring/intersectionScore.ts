// NOTE: resolveEffectiveSpeedLimitForIndex reads only local route-point context.
// No external request is made here. Posted speed-limit fields are populated
// earlier by src/lib/speedLimitSource.js, whose fetch contract uses geographic
// bounding boxes rather than raw route coordinates.
export {
  analyzeIntersectionBehavior,
  calculateSpeedLimitCompliance,
  getInferredLimitForPoint,
  resolveEffectiveSpeedLimitForIndex,
} from '../../engine/detection/cornering.js';
export {
  intersectionScoringPoints,
  sanitizePrivateIntersectionStats,
} from '../../engine/scoring/pipeline.js';
