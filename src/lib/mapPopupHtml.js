import { escapeHtml } from '@/lib/htmlUtils';

export const titleCase = (value) => String(value || '')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

export const routeLabelPopupPrefix = (label) => (
  label ? `<b>${escapeHtml(label)}</b><br>` : ''
);

export const buildSpeedSegmentPopupHtml = ({ routeLabel = null, label = 'Segment', speedKmh = 0, speedLimitKmh } = {}) => {
  const limit = Number(speedLimitKmh);
  return `${routeLabelPopupPrefix(routeLabel)}${escapeHtml(label)}: ${escapeHtml(Math.round(Number(speedKmh) || 0))} km/h${speedLimitKmh != null && Number.isFinite(limit) ? `<br>Limit: ${escapeHtml(Math.round(limit))} km/h` : ''}`;
};

export const buildRouteRiskSegmentPopupHtml = (segment = {}) => {
  const tripCount = Number(segment.tripCount) || 0;
  const totalEvents = Number(segment.totalEvents) || 0;
  const perPass = tripCount ? totalEvents / tripCount : 0;

  return [
    `<b>${escapeHtml(titleCase(segment.riskLevel))} risk segment</b>`,
    `Seen across ${escapeHtml(tripCount)} trips`,
    `Total events: ${escapeHtml(totalEvents)}`,
    `Avg ${escapeHtml(perPass.toFixed(1))} events per pass`,
    `Most common: ${escapeHtml(titleCase(segment.dominantEventType || 'none'))}`,
  ].join('<br>');
};

export const buildDangerZonePopupHtml = (zone = {}) => {
  const eventCount = Number(zone.eventCount) || 0;
  const radius = Math.round(Number(zone.radiusM) || 100);
  const lastSeenDate = zone.lastSeen ? new Date(zone.lastSeen) : null;
  const lastSeen = lastSeenDate && Number.isFinite(lastSeenDate.getTime())
    ? lastSeenDate.toLocaleDateString()
    : 'Unknown';

  return [
    `<b>${escapeHtml(titleCase(zone.riskLevel))} danger zone</b>`,
    `${escapeHtml(eventCount)} repeated events`,
    `Dominant event: ${escapeHtml(titleCase(zone.dominantType || 'risk event'))}`,
    `Radius: ${escapeHtml(radius)} m`,
    `Last seen: ${escapeHtml(lastSeen)}`,
  ].join('<br>');
};
