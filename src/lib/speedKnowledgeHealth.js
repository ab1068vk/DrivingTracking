import { assessSpeedLimitEvidence } from '@/lib/speedLimitConfidence';
import { summarizeRoadMemoryIntelligence } from '@/lib/roadMemoryIntelligence';
import { summarizeSourceReliability } from '@/lib/scoring/learnedSourceReliability';

const validCoordinate = (value, min, max) => Number.isFinite(Number(value)) &&
  Number(value) >= min &&
  Number(value) <= max;

const correctionExpired = (correction, now) => {
  if (!correction?.expiresAt) return false;
  const expiresAt = new Date(correction.expiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= now;
};

const historicalCorrection = (correction = {}) => correction.historicalVersion === true ||
  correction.supersededByCorrectionId != null ||
  (Array.isArray(correction.auditTrail) && correction.auditTrail.some((entry) => (
    entry?.action === 'superseded_by_effective_version'
  )));

export function inspectSpeedKnowledgeHealth(data = {}, now = Date.now()) {
  const issues = [];
  const cells = Object.entries(data.cells || {});
  const corrections = Array.isArray(data.corrections) ? data.corrections : [];
  const candidates = Array.isArray(data.roadMemory?.candidates) ? data.roadMemory.candidates : [];
  const intelligence = summarizeRoadMemoryIntelligence(candidates);
  const roadRules = new Map();

  for (const [geohash, cell] of cells) {
    if (cell?.conflict === true) {
      issues.push({ type: 'conflict', severity: 'high', geohash, message: 'Conflicting confirmed evidence needs review.' });
    }
    const evidence = assessSpeedLimitEvidence(cell || {});
    if (evidence.stale) {
      issues.push({ type: 'stale_cell', severity: 'low', geohash, message: 'Learned evidence is stale.' });
    }
  }

  for (const correction of corrections) {
    const geohash = String(correction?.geohash || '');
    const historical = historicalCorrection(correction);
    if (correctionExpired(correction, now) && !historical) {
      issues.push({ type: 'expired_rule', severity: 'medium', geohash, message: 'Saved rule has expired and can be cleaned up.' });
    }
    const points = Array.isArray(correction?.sectionPoints) ? correction.sectionPoints : [];
    const invalidGeometry = points.length > 0 && (
      points.length < 2 ||
      points.some((point) => !validCoordinate(point?.lat, -90, 90) || !validCoordinate(point?.lng, -180, 180))
    );
    if (invalidGeometry) {
      issues.push({ type: 'invalid_geometry', severity: 'high', geohash, message: 'Saved section geometry is incomplete or invalid.' });
    }
    if (!Number.isFinite(Number(correction?.limitKmh)) || Number(correction.limitKmh) <= 0) {
      issues.push({ type: 'invalid_limit', severity: 'high', geohash, message: 'Saved rule has an invalid speed limit.' });
    }
    const road = String(correction?.roadName || '').trim().toLowerCase();
    if (road && !historical) {
      const key = `${road}|${correction?.directionMode || 'both'}`;
      const group = roadRules.get(key) || [];
      group.push(correction);
      roadRules.set(key, group);
    }
  }

  for (const candidate of candidates) {
    const points = Array.isArray(candidate?.sectionPoints) ? candidate.sectionPoints : [];
    if (points.length < 2) {
      issues.push({
        type: 'road_memory_missing_geometry',
        severity: candidate?.stage === 'operational' ? 'high' : 'medium',
        geohash: candidate?.geohash || '',
        message: 'Road Memory evidence is missing a usable corridor line.',
      });
    }
    if (candidate?.stage === 'change_review') {
      issues.push({
        type: 'possible_speed_change',
        severity: 'medium',
        geohash: candidate?.geohash || '',
        message: 'Recent drives may indicate a changed speed.',
      });
    }
  }

  for (const group of roadRules.values()) {
    const limits = [...new Set(group.map((rule) => Math.round(Number(rule.limitKmh))).filter(Number.isFinite))];
    if (group.length > 1 && limits.length > 1) {
      group.forEach((rule) => issues.push({
        type: 'road_limit_disagreement',
        severity: 'medium',
        geohash: rule.geohash,
        message: `Saved rules with this road name use different limits: ${limits.join(', ')} km/h.`,
      }));
    }
  }

  const counts = issues.reduce((result, issue) => {
    result[issue.type] = (result[issue.type] || 0) + 1;
    result[issue.severity] = (result[issue.severity] || 0) + 1;
    return result;
  }, { high: 0, medium: 0, low: 0 });

  return {
    checkedAt: new Date(now).toISOString(),
    cellCount: cells.length,
    correctionCount: corrections.length,
    roadMemoryCount: candidates.length,
    operationalRoadMemoryCount: intelligence.validatedCount,
    learningRoadMemoryCount: candidates.filter((candidate) => (
      ['learning', 'shadow'].includes(candidate?.usageStage) ||
      candidate?.stage === 'learning' || candidate?.stage === 'suggested'
    )).length,
    roadMemoryIntelligence: intelligence,
    // Measured agreement per source, from this user's own saved cells. Reported
    // only; the fixed reference profiles still drive scoring penalty weights.
    sourceReliability: summarizeSourceReliability(cells.map(([, cell]) => cell)),
    geometryCount: [
      ...corrections,
      ...candidates,
    ].filter((item) => Array.isArray(item?.sectionPoints) && item.sectionPoints.length >= 2).length,
    geometryTotal: corrections.length + candidates.length,
    issueCount: issues.length,
    healthy: issues.length === 0,
    counts,
    issues,
  };
}
