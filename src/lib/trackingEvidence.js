import {
  DATA_SOURCE_LABELS,
  METRIC_REGISTRY,
  formatDataSourceLabel,
} from '@/lib/metricRegistry';
import { SCORING_VERSION } from '@/lib/tripEngine';

const UNAVAILABLE = 'unavailable';
const APPROXIMATE_NOTE_PATTERN = /provisional|proxy|estimate|estimated|approximate|not calibrated|depends/i;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const countArray = (value) => (Array.isArray(value) ? value.length : null);

const formatCount = (value) => {
  const number = finiteNumber(value);
  return number == null ? UNAVAILABLE : String(Math.max(0, Math.round(number)));
};

const formatValue = (value, suffix = '') => {
  if (value == null || value === '') return UNAVAILABLE;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return UNAVAILABLE;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`;
  }
  return String(value);
};

const normalizeEvidenceLevel = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return UNAVAILABLE;
  if (['high', 'medium', 'low', 'developing', 'unavailable'].includes(text)) return text;
  return text.replace(/_/g, ' ');
};

const routePoints = (trip = {}) => (Array.isArray(trip.route_points) ? trip.route_points : []);

const routePointCount = (trip = {}) => {
  const retained = countArray(trip.route_points);
  if (retained != null) return retained;
  return finiteNumber(trip.route_point_count ?? trip.route_points_count ?? trip.route_points_retained);
};

const routeRawCount = (trip = {}) => (
  hasOwn(trip, 'route_points_raw_count')
    ? finiteNumber(trip.route_points_raw_count)
    : finiteNumber(trip.raw_gps_point_count ?? trip.gps_point_count_raw)
);

const routeMapCount = (trip = {}) => (
  hasOwn(trip, 'route_points_map_count')
    ? finiteNumber(trip.route_points_map_count)
    : routePointCount(trip)
);

const gpsGapCount = (trip = {}) => {
  if (hasOwn(trip, 'gps_gap_count')) return finiteNumber(trip.gps_gap_count);
  const points = routePoints(trip);
  if (!points.length) return null;
  const explicit = points.filter((point) => (
    point?.route_gap === true ||
    point?.gps_gap === true ||
    point?.privacy_gap === true ||
    point?.masked_for_privacy === true
  )).length;
  let timeGaps = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = new Date(points[index - 1]?.timestamp || 0).getTime();
    const current = new Date(points[index]?.timestamp || 0).getTime();
    if (Number.isFinite(previous) && Number.isFinite(current) && current - previous > 120_000) {
      timeGaps += 1;
    }
  }
  return explicit + timeGaps;
};

const routeSamplesForMetric = (metricKey, trip = {}) => {
  if (/obd/i.test(metricKey)) return countObdPowertrainSamples(trip);
  if (/phone_use|distraction/.test(metricKey)) return finiteNumber(trip.phone_use_window_count);
  if (/event|brake|accel|corner|stop_start|close_proximity|merge|speeding/.test(metricKey)) {
    return countArray(trip.driving_events);
  }
  return routePointCount(trip);
};

const scoreKeyForMetric = (metricKey) => {
  if (metricKey === 'score_overall') return 'overall';
  if (metricKey === 'score_safety') return 'safety';
  if (metricKey === 'score_smoothness') return 'smoothness';
  if (metricKey === 'score_eco') return 'eco';
  return metricKey.replace(/_score$/, '');
};

const componentForMetric = (trip = {}, metricKey) => {
  const scores = trip.component_scores || {};
  const direct = scores[metricKey];
  if (direct) return direct;
  const compactKey = scoreKeyForMetric(metricKey);
  return scores[compactKey] || null;
};

const metricValue = (trip = {}, metricKey, component = null) => {
  if (component && hasOwn(component, 'value')) return component.value;
  if (hasOwn(trip, metricKey)) return trip[metricKey];
  if (metricKey === 'score_overall') return trip.score_overall ?? trip.overall_score ?? trip.score;
  return null;
};

const metricDataSources = (metric = {}, component = null) => {
  const componentSources = Array.isArray(component?.dataSource)
    ? component.dataSource
    : Array.isArray(component?.dataSources)
      ? component.dataSources
      : [];
  const sources = componentSources.length ? componentSources : metric.dataSources || [];
  return sources.map((source) => ({
    key: source,
    label: formatDataSourceLabel(source),
  }));
};

const provenanceConfidence = (trip = {}, metricKey, component = null) => {
  if (component?.evidence) return normalizeEvidenceLevel(component.evidence);
  const provenance = trip.score_provenance?.components || {};
  const compactKey = scoreKeyForMetric(metricKey);
  return normalizeEvidenceLevel(
    provenance[metricKey] ??
    provenance[compactKey] ??
    trip[`${metricKey}_confidence`] ??
    trip[`score_${compactKey}_confidence`] ??
    trip.score_confidence_label
  );
};

export function countObdPowertrainSamples(trip = {}) {
  if (hasOwn(trip, 'obd_powertrain_sample_count')) {
    return finiteNumber(trip.obd_powertrain_sample_count);
  }
  const points = routePoints(trip);
  if (!points.length) return null;
  return points.filter((point) => (
    point?.obd_rpm != null ||
    point?.obd_throttle_pct != null ||
    point?.obd_speed_kmh != null
  )).length;
}

export function buildMetricEvidenceRows(trip = {}) {
  const componentKeys = Object.keys(trip.component_scores || {});
  const baseKeys = [
    'score_overall',
    'score_safety',
    'score_smoothness',
    'score_eco',
    'distance_km',
    'duration_seconds',
    'avg_speed_kmh',
    'avg_running_speed_kmh',
    'max_speed_kmh',
    'phone_use_score',
    'obd_powertrain_sample_count',
  ];
  const keys = Array.from(new Set([
    ...baseKeys,
    ...componentKeys,
    ...Object.keys(METRIC_REGISTRY).filter((key) => hasOwn(trip, key)),
  ])).filter((key) => METRIC_REGISTRY[key] || componentForMetric(trip, key) || hasOwn(trip, key));

  return keys.map((metricKey) => {
    const metric = METRIC_REGISTRY[metricKey] || {
      label: metricKey.replace(/_/g, ' '),
      description: 'Metric recorded with trip data.',
      dataSources: [],
      calibrationNote: '',
    };
    const component = componentForMetric(trip, metricKey);
    const value = metricValue(trip, metricKey, component);
    const dataSources = metricDataSources(metric, component);
    const calibrationNote = component?.calibrationNote || component?.note || metric.calibrationNote || '';
    const sampleCount = component?.sampleCount ?? component?.sample_count ?? routeSamplesForMetric(metricKey, trip);
    return {
      id: `metric-${metricKey}`,
      kind: 'metric',
      metricKey,
      label: metric.label,
      value: formatValue(value),
      rawValue: value ?? null,
      available: value != null && value !== '',
      confidence: provenanceConfidence(trip, metricKey, component),
      sampleCount: formatCount(sampleCount),
      sampleCountRaw: sampleCount ?? null,
      dataSources,
      dataSourceLabel: dataSources.length ? dataSources.map((source) => source.label).join(', ') : UNAVAILABLE,
      description: metric.description || 'Metric recorded with trip data.',
      calibrationNote: calibrationNote || UNAVAILABLE,
      provisional: APPROXIMATE_NOTE_PATTERN.test(calibrationNote || metric.description || ''),
      provenance: trip.score_provenance?.scoring_version || trip.scoring_version || UNAVAILABLE,
    };
  });
}

export function buildSourceEvidenceRows(trip = {}, settings = {}) {
  const speedLimitContext = trip.speed_limit_context || {};
  const mapMatchingContext = trip.map_matching_context || {};
  const weatherContext = trip.weather_context || {};
  const phoneSummary = trip.phone_use_summary || {};
  const obdSampleCount = countObdPowertrainSamples(trip);
  const routeRetained = routePointCount(trip);
  const routeRaw = routeRawCount(trip);
  const routeMap = routeMapCount(trip);
  const gaps = gpsGapCount(trip);
  const usageEvidence = trip.phone_use_score_status === 'android_usage_access' ||
    phoneSummary.source === 'android_usage_access' ||
    (trip.phone_use_events || []).some((event) => event?.source === 'android_usage_access');
  const gpsProxy = (trip.phone_use_events || []).some((event) => event?.source === 'gps_proxy' || event?.diagnostic_only);
  const sensorFusion = settings.sensor_fusion_enabled === false
    ? 'disabled'
    : trip.sensor_fusion_summary?.available === true || trip.motion_sample_count > 0
      ? 'available'
      : UNAVAILABLE;

  return [
    {
      id: 'route-retained-points',
      kind: 'source',
      label: 'Route points retained',
      value: formatCount(routeRetained),
      confidence: routeRetained == null ? UNAVAILABLE : 'recorded',
      sampleCount: formatCount(routeRetained),
      dataSourceLabel: DATA_SOURCE_LABELS.gps,
      detail: 'Retained route samples available to map, playback, and metric views.',
    },
    {
      id: 'route-raw-map-points',
      kind: 'source',
      label: 'Raw vs map/playback points',
      value: `raw ${formatCount(routeRaw)} / map ${formatCount(routeMap)}`,
      confidence: routeRaw == null && routeMap == null ? UNAVAILABLE : 'recorded',
      sampleCount: formatCount(routeMap),
      dataSourceLabel: DATA_SOURCE_LABELS.gps,
      detail: 'Raw count is unavailable unless the trip stored raw retention metadata.',
    },
    {
      id: 'gps-gaps',
      kind: 'source',
      label: 'GPS gaps',
      value: formatCount(gaps),
      confidence: gaps == null ? UNAVAILABLE : 'recorded',
      sampleCount: formatCount(routeRetained),
      dataSourceLabel: DATA_SOURCE_LABELS.gps,
      detail: 'Explicit route gaps plus timestamp gaps over two minutes.',
    },
    {
      id: 'map-matching',
      kind: 'source',
      label: 'Map matching status',
      value: formatValue(mapMatchingContext.status || trip.map_matching_status),
      confidence: mapMatchingContext.status ? 'recorded' : UNAVAILABLE,
      sampleCount: formatCount(mapMatchingContext.point_count ?? mapMatchingContext.matched_point_count),
      dataSourceLabel: 'OSRM route matching',
      detail: mapMatchingContext.error || mapMatchingContext.provider || 'Map matching context is unavailable.',
    },
    {
      id: 'speed-limit-context',
      kind: 'source',
      label: 'Speed lookup status',
      value: formatValue(speedLimitContext.status),
      confidence: speedLimitContext.status ? 'recorded' : UNAVAILABLE,
      sampleCount: formatCount(speedLimitContext.sample_count ?? speedLimitContext.matched_point_count),
      dataSourceLabel: formatDataSourceLabel(speedLimitContext.source || 'speed_limit_osm'),
      detail: speedLimitContext.error || (speedLimitContext.coverage != null ? `${speedLimitContext.coverage}% coverage` : 'Speed-limit context unavailable.'),
    },
    {
      id: 'weather-context',
      kind: 'source',
      label: 'Weather lookup status',
      value: formatValue(weatherContext.status || weatherContext.source || weatherContext.provider),
      confidence: weatherContext.status || weatherContext.provider ? 'recorded' : UNAVAILABLE,
      sampleCount: weatherContext.status || weatherContext.provider ? '1' : UNAVAILABLE,
      dataSourceLabel: formatDataSourceLabel('open_meteo_weather'),
      detail: weatherContext.condition || weatherContext.error || weatherContext.status || 'Weather context unavailable.',
    },
    {
      id: 'phone-use-provenance',
      kind: 'source',
      label: 'Android Usage Access state',
      value: usageEvidence ? 'available' : gpsProxy ? 'GPS proxy diagnostics only' : UNAVAILABLE,
      confidence: usageEvidence ? 'recorded' : gpsProxy ? 'diagnostic' : UNAVAILABLE,
      sampleCount: formatCount(trip.phone_use_window_count ?? phoneSummary.windowCount),
      dataSourceLabel: usageEvidence ? formatDataSourceLabel('android_usage_access') : gpsProxy ? formatDataSourceLabel('gps_proxy') : UNAVAILABLE,
      detail: usageEvidence
        ? 'Confirmed Android Usage Access evidence recorded.'
        : gpsProxy
          ? 'GPS proxy evidence is diagnostic and not scored as Usage Access evidence.'
          : 'Usage Access evidence unavailable.',
    },
    {
      id: 'obd-powertrain',
      kind: 'source',
      label: 'OBD powertrain samples',
      value: formatCount(obdSampleCount),
      confidence: obdSampleCount == null ? UNAVAILABLE : 'recorded',
      sampleCount: formatCount(obdSampleCount),
      dataSourceLabel: formatDataSourceLabel('obd_bluetooth'),
      detail: 'Samples with OBD speed, RPM, or throttle evidence.',
    },
    {
      id: 'sensor-fusion',
      kind: 'source',
      label: 'Sensor fusion availability',
      value: sensorFusion,
      confidence: sensorFusion === UNAVAILABLE ? UNAVAILABLE : 'recorded',
      sampleCount: formatCount(trip.motion_sample_count ?? trip.sensor_fusion_summary?.sampleCount),
      dataSourceLabel: formatDataSourceLabel('device_motion_imu'),
      detail: settings.sensor_fusion_enabled === false
        ? 'Sensor fusion disabled in settings.'
        : trip.sensor_fusion_summary?.evidenceSource || 'Sensor fusion evidence unavailable.',
    },
  ];
}

export function buildProvenanceRows(trip = {}) {
  const provenance = trip.score_provenance || {};
  return [
    {
      id: 'scoring-version',
      label: 'Scoring version',
      value: provenance.scoring_version || trip.scoring_version || SCORING_VERSION || UNAVAILABLE,
      detail: provenance.computed_at ? `Computed ${provenance.computed_at}` : 'Computed timestamp unavailable.',
    },
    {
      id: 'score-components',
      label: 'Component confidence',
      value: provenance.components ? Object.keys(provenance.components).length : UNAVAILABLE,
      detail: provenance.components
        ? Object.entries(provenance.components).map(([key, value]) => `${key}: ${value}`).join(', ')
        : 'Component confidence unavailable.',
    },
    {
      id: 'constants-snapshot',
      label: 'Scoring constants snapshot',
      value: provenance.constants_snapshot ? Object.keys(provenance.constants_snapshot).length : UNAVAILABLE,
      detail: provenance.constants_snapshot ? 'Scoring constants snapshot recorded.' : 'Scoring constants snapshot unavailable.',
    },
  ];
}

export function buildTrackingEvidenceConsoleData({
  trip = null,
  settings = {},
} = {}) {
  const selectedTrip = trip || {};
  const metricRows = trip ? buildMetricEvidenceRows(selectedTrip) : [];
  const sourceRows = trip ? buildSourceEvidenceRows(selectedTrip, settings) : [];
  const provenanceRows = trip ? buildProvenanceRows(selectedTrip) : [];
  const unavailableCount = [...metricRows, ...sourceRows].filter((row) => row.confidence === UNAVAILABLE || row.value === UNAVAILABLE).length;
  const provisionalCount = metricRows.filter((row) => row.provisional).length;
  return {
    tripId: selectedTrip.id || '',
    metricRows,
    sourceRows,
    provenanceRows,
    summary: {
      metricCount: metricRows.length,
      sourceCount: sourceRows.length,
      unavailableCount,
      provisionalCount,
      scoringVersion: provenanceRows[0]?.value || UNAVAILABLE,
    },
  };
}
