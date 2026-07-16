import { escapeHtml } from '@/lib/htmlUtils';
import { formatSpeed } from '@/lib/tripEngine';

export const titleCase = (value) => String(value || '')
  .replace(/^near_miss$/, 'legacy_brake_turn_alert')
  .replace(/^close_proximity$/, 'brake_turn_alert')
  .replace(/^tailgate_cycle$/, 'legacy_stop_start_pattern')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

export const routeLabelPopupPrefix = (label) => (
  label ? `<b>${escapeHtml(label)}</b><br>` : ''
);

/**
 * @param {{routeLabel?:string|null,label?:string,speedKmh?:number,speedLimitKmh?:number|null,units?:string}} options
 */
export const buildSpeedSegmentPopupHtml = ({ routeLabel = null, label = 'Segment', speedKmh = 0, speedLimitKmh, units = 'metric' } = {}) => {
  const limit = Number(speedLimitKmh);
  return `${routeLabelPopupPrefix(routeLabel)}${escapeHtml(label)}: ${escapeHtml(formatSpeed(Number(speedKmh) || 0, units))}${speedLimitKmh != null && Number.isFinite(limit) ? `<br>Limit: ${escapeHtml(formatSpeed(limit, units))}` : ''}`;
};

export const buildRouteRiskSegmentPopupHtml = (segment = {}) => {
  const tripCount = Number(segment.tripCount) || 0;
  const totalEvents = Number(segment.totalEvents) || 0;
  const perPass = tripCount ? totalEvents / tripCount : 0;

  return [
    `<b>${escapeHtml(titleCase(segment.riskLevel))} repeated-event segment</b>`,
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
    `<b>${escapeHtml(titleCase(zone.riskLevel))} repeated driving-event area</b>`,
    `${escapeHtml(eventCount)} repeated events`,
    `Dominant event: ${escapeHtml(titleCase(zone.dominantType || 'risk event'))}`,
    `Radius: ${escapeHtml(radius)} m`,
    `Last seen: ${escapeHtml(lastSeen)}`,
  ].join('<br>');
};
