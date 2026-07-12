import {
  DATA_PORTABILITY_FORMAT,
  DATA_PORTABILITY_VERSION,
  validatePortabilityExport,
} from '@/lib/dataRights';
import { osrmConsentEvidence } from '@/lib/privacyIntelligence';
import {
  NATIVE_PRIVACY_SYNC_STATUS_FAILED,
  NATIVE_PRIVACY_SYNC_STATUS_OK,
} from '@/lib/privacyZones';
import { PRIVATE_TRIP_MODE } from '@/lib/privateTripMode';

const SERVICE_FALLBACKS = Object.freeze({
  'open-meteo': {
    label: 'Open-Meteo weather',
    purpose: 'Weather context',
    expectedDisclosure: 'rounded public sample',
    safeShape: 'One privacy-filtered public point and trip date.',
  },
  overpass: {
    label: 'OpenStreetMap / Overpass',
    purpose: 'Posted speed-limit context',
    expectedDisclosure: 'privacy-filtered bounding boxes',
    safeShape: 'Public road bounds after privacy-zone checks.',
  },
  osrm: {
    label: 'OSRM route matching',
    purpose: 'Optional route snapping',
    expectedDisclosure: 'sampled public route segments',
    safeShape: 'Only after explicit consent and privacy-zone endpoint guards.',
  },
});

const countLabel = (value) => String(Math.max(0, Math.round(Number(value) || 0)));

const formatTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'source unavailable';
};

const words = (value, fallback = 'recorded item') => String(value || fallback)
  .toLowerCase()
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const statusTone = (status) => {
  if (['ok', 'configured', 'protecting', 'active', 'masked', 'blocked'].includes(status)) return 'ok';
  if (['failed', 'error', 'raw_without_consent'].includes(status)) return 'error';
  if (['warn', 'warning', 'stale', 'needs_review'].includes(status)) return 'warn';
  return 'unknown';
};

export function nativePrivacySyncRow(settings = {}) {
  const status = settings.privacy_zones_native_sync_status || '';
  const zoneCount = Number(settings.privacy_zones_native_sync_zone_count) || 0;
  if (status === NATIVE_PRIVACY_SYNC_STATUS_OK) {
    return {
      id: 'native_sync',
      label: 'Native privacy-zone sync',
      value: 'synced',
      detail: `${zoneCount} zone guard${zoneCount === 1 ? '' : 's'} delivered to native tracking.`,
      status: 'ok',
      tone: 'ok',
      updatedAt: settings.privacy_zones_native_sync_failed_at || null,
    };
  }
  if (status === NATIVE_PRIVACY_SYNC_STATUS_FAILED) {
    return {
      id: 'native_sync',
      label: 'Native privacy-zone sync',
      value: 'failed',
      detail: settings.privacy_zones_native_sync_failed_at
        ? `Native privacy-zone sync failed at ${formatTime(settings.privacy_zones_native_sync_failed_at)}.`
        : 'Native privacy-zone sync failed.',
      status: 'failed',
      tone: 'error',
      updatedAt: settings.privacy_zones_native_sync_failed_at || null,
    };
  }
  return {
    id: 'native_sync',
    label: 'Native privacy-zone sync',
    value: zoneCount ? 'pending' : 'source unavailable',
    detail: zoneCount ? 'A native sync status has not been recorded yet.' : 'No native privacy-zone sync evidence is recorded.',
    status: 'unknown',
    tone: 'unknown',
    updatedAt: null,
  };
}

export function privacyZoneDisplayRows(zones = [], drivingReadout = {}) {
  const byLabel = new Map((drivingReadout.zoneSummaries || []).map((item) => [item.label, item]));
  return (Array.isArray(zones) ? zones : []).map((zone, index) => {
    const readout = byLabel.get(zone?.label) || {};
    const protectedRecords = readout.protectedRecords != null
      ? Number(readout.protectedRecords) || 0
      : (Number(zone?.allTime?.hidden) || 0) + (Number(zone?.allTime?.events) || 0);
    const protectedWeek = readout.protectedWeek != null
      ? Number(readout.protectedWeek) || 0
      : (Number(zone?.week?.hidden) || 0) + (Number(zone?.week?.events) || 0);
    const status = readout.status || (zone?.lastActive ? 'protecting' : 'ready');
    return {
      displayId: `Zone ${index + 1}`,
      label: zone?.label || `Private zone ${index + 1}`,
      type: zone?.type === 'corridor' ? 'corridor' : 'circle',
      sensitivity: zone?.sensitivity === 'high' ? 'high' : 'standard',
      status,
      tone: statusTone(status),
      protectedRecords,
      protectedWeek,
      lastActive: readout.lastActive || zone?.lastActive || null,
      lastActiveLabel: formatTime(readout.lastActive || zone?.lastActive),
      expiresAt: zone?.expiresAt || null,
      expiresAtLabel: zone?.expiresAt ? formatTime(zone.expiresAt) : 'not scheduled',
      geometry: 'redacted',
    };
  });
}

export function buildMaskingRows(intelligence = {}) {
  const driving = intelligence.drivingReadout || {};
  const zoneSummary = intelligence.zoneSummary || {};
  const validation = validatePortabilityExport({
    format: DATA_PORTABILITY_FORMAT,
    version: DATA_PORTABILITY_VERSION,
    generatedAt: new Date(0).toISOString(),
    trips: [],
    settings: {},
    privacyZones: [],
    scoreHistory: [],
  });
  return [
    {
      id: 'route_samples',
      label: 'Hidden route samples',
      value: countLabel(driving.protectedPointCount),
      detail: `${countLabel(driving.rawPointInsideZoneCount)} retained local sample${Number(driving.rawPointInsideZoneCount) === 1 ? '' : 's'} still matched configured zones.`,
      status: Number(driving.rawPointInsideZoneCount) > 0 ? 'needs_review' : 'masked',
      tone: Number(driving.rawPointInsideZoneCount) > 0 ? 'warn' : 'ok',
    },
    {
      id: 'suppressed_events',
      label: 'Suppressed events',
      value: countLabel(driving.protectedEventCount),
      detail: 'Events inside privacy zones are represented as redacted telemetry, not raw coordinates.',
      status: 'masked',
      tone: 'ok',
    },
    {
      id: 'zone_activity',
      label: 'Configured zones',
      value: countLabel(zoneSummary.zoneCount),
      detail: `${countLabel(zoneSummary.pointsWeek)} route sample${Number(zoneSummary.pointsWeek) === 1 ? '' : 's'} and ${countLabel(zoneSummary.eventsWeek)} event${Number(zoneSummary.eventsWeek) === 1 ? '' : 's'} masked this week.`,
      status: zoneSummary.zoneCount ? 'configured' : 'source_unavailable',
      tone: zoneSummary.zoneCount ? 'ok' : 'unknown',
    },
    {
      id: 'portability_export',
      label: 'Route/export masking',
      value: validation.valid ? 'schema verified' : 'schema unavailable',
      detail: `${DATA_PORTABILITY_FORMAT} v${DATA_PORTABILITY_VERSION} uses privacy-zone placeholders and export-masked trip geometry.`,
      status: validation.valid ? 'masked' : 'source_unavailable',
      tone: validation.valid ? 'ok' : 'unknown',
    },
    {
      id: 'private_trip_mode',
      label: 'Private-trip summary-only mode',
      value: PRIVATE_TRIP_MODE,
      detail: 'Private trips can save distance, duration, speed summary, and zero GPS samples stored.',
      status: 'configured',
      tone: 'ok',
    },
  ];
}

export function buildOutboundRows(intelligence = {}, settings = {}) {
  const readout = intelligence.transmissions?.outboundReadout || {};
  const summaries = Array.isArray(readout.serviceSummaries) ? readout.serviceSummaries : [];
  const byService = new Map(summaries.map((item) => [item.service, item]));
  return Object.entries(SERVICE_FALLBACKS).map(([service, fallback]) => {
    const summary = byService.get(service) || {};
    const enabled = summary.enabled ?? (
      service === 'open-meteo'
        ? settings.weather_context_enabled !== false
        : service === 'overpass'
          ? settings.speed_limit_lookup_enabled !== false
          : settings.map_matching_enabled !== false && Boolean(settings.osrm_map_matching_url)
    );
    const blocked = Number(summary.blockedCount) || 0;
    const rawWithoutConsent = service === 'osrm' ? Number(readout.rawWithoutConsentCount) || 0 : Number(summary.rawWithoutConsentCount) || 0;
    const status = !enabled
      ? 'blocked'
      : rawWithoutConsent
        ? 'raw_without_consent'
        : blocked
          ? 'blocked'
          : summary.retainedCount
            ? 'recorded'
            : 'source_unavailable';
    const consentEvidence = service === 'osrm'
      ? osrmConsentEvidence({
        enabled,
        outdated: Boolean(settings.osrm_consent_invalidated_reason),
        unguarded: settings.osrm_block_near_any_zone !== true,
      })
      : enabled ? 'Consent gate not required for this privacy-filtered source' : 'Service disabled by local settings';
    return {
      id: service,
      label: summary.label || fallback.label,
      purpose: summary.usefulFor || fallback.purpose,
      enabled,
      expectedDisclosure: summary.expectedDisclosure || fallback.expectedDisclosure,
      safeShape: summary.safeShape || fallback.safeShape,
      retainedCount: Number(summary.retainedCount) || 0,
      protectedCount: Number(summary.protectedCount) || 0,
      blockedCount: blocked,
      rawCount: Number(summary.rawCount) || 0,
      unverifiedCount: Number(summary.unverifiedCount) || 0,
      latestAt: summary.latestAt || null,
      latestAtLabel: formatTime(summary.latestAt),
      status,
      tone: statusTone(status),
      consentEvidence,
      verdict: summary.verdict || (enabled ? 'No retained evidence yet' : 'Blocked by setting'),
    };
  });
}

export function buildAuditRows(intelligence = {}) {
  const audit = intelligence.auditSummary || {};
  return (Array.isArray(audit.operations) ? audit.operations : []).map((item, index) => ({
    id: `audit-${index}`,
    operation: words(item.operation, 'Privacy operation'),
    count: Number(item.count) || 0,
    detail: 'App-recorded privacy evidence. This is not an external security audit.',
    status: 'recorded',
    tone: 'ok',
  }));
}

export function buildTrackingPrivacyConsoleData({
  intelligence = {},
  settings = {},
} = {}) {
  const nativeSync = nativePrivacySyncRow(settings);
  const zoneRows = privacyZoneDisplayRows(intelligence.zones, intelligence.drivingReadout);
  const maskingRows = buildMaskingRows(intelligence);
  const outboundRows = buildOutboundRows(intelligence, settings);
  const auditRows = buildAuditRows(intelligence);
  const outboundReadout = intelligence.transmissions?.outboundReadout || {};
  const chainResult = intelligence.chainResult || {};
  const topRows = [
    { id: 'zones', label: 'Configured zones', value: countLabel(zoneRows.length), tone: zoneRows.length ? 'ok' : 'unknown' },
    { id: 'hidden', label: 'Hidden route samples', value: countLabel(intelligence.drivingReadout?.protectedPointCount), tone: 'ok' },
    { id: 'events', label: 'Suppressed events', value: countLabel(intelligence.drivingReadout?.protectedEventCount), tone: 'ok' },
    { id: 'native', label: 'Native sync', value: nativeSync.value, tone: nativeSync.tone },
    { id: 'outbound', label: 'Outbound road data', value: outboundReadout.headline || 'source unavailable', tone: outboundReadout.tone || 'unknown' },
    { id: 'audit', label: 'Audit chain', value: chainResult.valid === false ? 'verification unavailable' : 'app evidence recorded', tone: chainResult.valid === false ? 'error' : 'ok' },
  ];
  return {
    generatedAt: intelligence.generatedAt || Date.now(),
    topRows,
    zoneRows,
    maskingRows,
    outboundRows,
    auditRows,
    nativeSync,
    auditSummary: {
      todayTotal: Number(intelligence.auditSummary?.todayTotal) || 0,
      weekTotal: Number(intelligence.auditSummary?.weekTotal) || 0,
      latestAt: intelligence.auditSummary?.latestAt || null,
      latestAtLabel: formatTime(intelligence.auditSummary?.latestAt),
      signatureCoverage: Number(intelligence.auditSummary?.signatureCoverage) || 0,
      chainValid: chainResult.valid !== false,
    },
    privateTripMode: {
      mode: PRIVATE_TRIP_MODE,
      label: 'Private-trip summary-only mode',
      detail: 'Summary-only private trips retain trip totals and store zero route coordinates.',
    },
  };
}
