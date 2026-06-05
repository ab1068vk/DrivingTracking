// Compatibility orchestration layer. New code should import from the focused
// modules under src/lib/scoring, src/lib/detection, and src/lib/gps.
export * from './gps/formatting.js';
export * from './gps/math.js';
export * from './gps/routeSummary.js';
export * from './gps/speedLimits.js';
export * from './scoring/componentScores.js';
export * from './scoring/ecoScore.js';
export * from './scoring/safetyScore.js';
export * from './scoring/smoothnessScore.js';
export * from './scoring/intersectionScore.js';
export * from './scoring/phoneUseScore.js';
export * from './detection/harshEvents.js';
export * from './detection/laneChange.js';
export * from './detection/phoneProxy.js';
export * from './detection/speedCreep.js';
export {
  analyzeFatigueProgression,
  detectDrowsyDriving,
  detectHeadingDriftBeta,
  scoreSegmentPoints,
} from '../engine/detection/headingDrift.js';
export {
  calculateOvertakeQualityScore,
  calculateRoadTypeSegmentedScores,
  detectSlipperyConditionProxy,
} from '../engine/detection/cornering.js';
export {
  detectAggressiveOvertakes,
} from '../engine/detection/overtakePattern.js';
export {
  detectCloseProximityManeuverAlerts,
  detectNearMisses,
  detectStopStartPatterns,
  detectTailgateCycles,
} from '../engine/detection/gpsTailgate.js';
export {
  simplifyRoute,
} from '../engine/route/index.js';
export {
  downloadCSV,
  generateReportSummary,
  tripsToCSV,
} from '../engine/export/index.js';
