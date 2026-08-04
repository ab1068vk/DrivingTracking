// @ts-check
// Driver-facing label and status text for the saved-road-speed workspaces,
// extracted verbatim from src/pages/SpeedLimits.jsx. Pure string formatting —
// no React, no component state.
import { speedMapSectionFlags } from '@/lib/speedLimitMapSections';
import { speedLimitSourceLabel } from '@/lib/speedLimitDisplay';
import { formatSpeedKmh } from '@/lib/unitFormatting';

export const sourceLabel = (source) => speedLimitSourceLabel(source, { short: true });

export const formatSpeedLimit = (value, units = 'metric') => formatSpeedKmh(value, units);

export const formatSourceList = (sources = []) => {
  const labels = [...new Set((sources || []).filter(Boolean).map(sourceLabel))];
  return labels.length ? labels.join(', ') : 'Unknown source';
};

export const speedSectionAttentionLabel = (section = {}) => {
  const flags = speedMapSectionFlags(section);
  if (flags.expired) return 'Expired temporary rule';
  if (flags.expiring) return 'Temporary rule expiring soon';
  if (flags.stale) return 'Stale speed evidence';
  if (flags.lowConfidence) return 'Low-confidence speed evidence';
  if (flags.missingGeometry) return 'Needs traced road line';
  if (flags.estimate) return 'Estimate ready for confirmation';
  return 'Review saved rule';
};

export const formatDate = (value) => {
  if (value == null || value === '') return 'Unknown time';
  const date = new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) && time > 0 ? date.toLocaleString() : 'Unknown time';
};

export const formatCoordinate = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(5) : '0.00000';
};

export const coordinateLabel = (source) => (
  source === 'geohash_cell_center_legacy'
    ? 'Approx cell center'
    : 'Driven route point'
);

export const directionLabel = (mode) => ({
  forward: 'Drawn direction only',
  reverse: 'Opposite direction only',
  both: 'Both directions',
}[mode] || 'Both directions');

export const timeString = (minutes, fallback = '07:00') => {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.max(0, Math.min(1439, Math.round(value)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
};

export const expiryLabel = (value) => (
  value ? `Expires ${new Date(value).toLocaleDateString()}` : 'No expiry'
);

export const validFromLabel = (value) => (
  value ? `Effective ${new Date(value).toLocaleDateString()}` : 'All recorded history'
);

export const tripLabel = (trip = {}) => {
  const title = trip.name || trip.title || trip.label;
  if (title) return title;
  // Falling back to `|| 0` here would build a valid epoch date, so a trip with
  // no timestamp at all rendered as 1970-01-01 and the id branch below was
  // unreachable. Only date-format a timestamp that actually exists.
  const startedAt = trip.start_time || trip.started_at || trip.created_at;
  const started = startedAt ? new Date(startedAt) : null;
  return started && Number.isFinite(started.getTime())
    ? started.toLocaleDateString()
    : `Trip ${String(trip.id || '').slice(0, 8)}`;
};

export const undoActionText = (action = '') => ({
  save_correction: 'add',
  update_correction: 'change',
  resolve_conflict_update: 'conflict decision',
  remove_correction: 'delete',
  resolve_conflict: 'conflict decision',
  repair_saved_speed_data: 'repair',
  restore_speed_backup: 'restore',
  restore_backup: 'restore',
  prune: 'cleanup',
}[action] || 'change');

export const statusMessageText = (value) => (
  typeof value === 'string' ? value : String(value?.message || '')
);

export const speedStatusToast = (value) => {
  const message = statusMessageText(value).trim();
  if (!message) return null;
  const lower = message.toLowerCase();
  if (
    lower.startsWith('could not') ||
    lower.startsWith('cannot') ||
    lower.startsWith('enter a valid') ||
    lower.startsWith('tap at least') ||
    lower.startsWith('this section needs') ||
    lower.startsWith('this road section needs') ||
    lower.startsWith('select ') ||
    lower.startsWith('there is no') ||
    lower.startsWith('speed-rule backup is too large') ||
    lower.startsWith('snap to route needs') ||
    lower.startsWith('no recorded route samples') ||
    lower.includes('failed')
  ) {
    return { title: 'Saved road speed issue', description: message, variant: 'destructive' };
  }
  if (
    lower.includes('matching trip scores are updating') ||
    lower.includes('affected trips could not be recalculated') ||
    lower.includes('matching trips could not be recalculated')
  ) {
    return { title: 'Saved road speed saved', description: message };
  }
  if (
    lower.startsWith('saved ') ||
    lower.startsWith('adding ') ||
    lower.startsWith('add road section') ||
    lower.startsWith('auto-snap ') ||
    lower.startsWith('choose ') ||
    lower.startsWith('saved road speeds refreshed') ||
    lower.startsWith('restored ') ||
    lower.startsWith('downloading ') ||
    lower.startsWith('exported ') ||
    lower.startsWith('change undone') ||
    lower.startsWith('conflict resolved') ||
    lower.startsWith('road section split') ||
    lower.startsWith('deleted ') ||
    lower.startsWith('confirmed ') ||
    lower.startsWith('removed expired') ||
    lower.startsWith('section snapped') ||
    lower.startsWith('snapped the line') ||
    lower.startsWith('saved snapped')
  ) {
    return { title: 'Saved road speed updated', description: message };
  }
  if (lower.startsWith('prepared a merged')) {
    return { title: 'Saved road speed ready', description: message };
  }
  return null;
};

export const mapSectionReasonText = (section = {}, addMode = false, units = 'metric') => {
  if (section.saved) {
    const source = sourceLabel(section.source);
    return `Saved local rule from ${source}; this rule is used before trip-derived map evidence.`;
  }
  if (addMode) return 'New traced road section; it will become a saved local rule after saving.';
  if (section.roadMemoryCandidate) {
    const stageText = section.canAffectScoreAndAlerts === true
      ? 'This estimate can affect scoring and alerts.'
      : section.stage === 'change_review'
        ? `Recent drives may indicate a change to ${formatSpeedLimit(section.changeDetection?.proposedLimitKmh, units)}; scoring and alerts are paused here.`
        : 'This is visible for exploration but does not affect scoring or alerts yet.';
    return `Road Memory suggests ${formatSpeedLimit(section.effectiveLimitKmh, units)}. ${section.confidenceExplanation || `${Number(section.tripCount) || 1} repeated drives at ${Math.round((Number(section.confidence) || 0) * 100)}% confidence`}. ${stageText}`;
  }
  const points = Number(section.sampleCount || section.sectionPoints?.length || 0);
  const sampleText = points > 0 ? `${points} route sample${points === 1 ? '' : 's'}` : 'recorded route evidence';
  const observedLimit = Number(section.effectiveLimitKmh ?? section.observedLimitKmh);
  if (Number.isFinite(observedLimit) && observedLimit > 0) {
    return `Observed-only trip section from ${sampleText}; save it to turn it into a local posted sign or estimate.`;
  }
  return `Unset trip section from ${sampleText}; no saved rule covers this part of the recorded route yet.`;
};
