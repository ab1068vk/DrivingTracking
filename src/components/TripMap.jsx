// @ts-check
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Crosshair, Layers, Maximize2, Smartphone } from 'lucide-react';
import { escapeHtml } from '@/lib/htmlUtils';
import { speedLimitSourceLabel } from '@/lib/speedLimitDisplay';
import { buildPlaybackTimeline, injectTimestampGapMarkers, prepareMapRoutePoints } from '@/lib/mapPlaybackInsights';
import {
  buildDangerZonePopupHtml,
  buildRouteRiskSegmentPopupHtml,
  buildSpeedSegmentPopupHtml,
  routeLabelPopupPrefix,
  titleCase,
} from '@/lib/mapPopupHtml';
import { buildSpeedSegments } from '@/lib/tripInsights';
import { calculateBearing, formatDistance, formatDuration, formatSpeed, headingDiff, haversineDistance } from '@/lib/tripEngine';
import { buildMapDiagnosticsAggregate } from '@/lib/mapDiagnostics';
import { HEIGHTENED_PRIVACY_MODE_KEY } from '@/lib/privacyMode';
import {
  getPrivacyZoneDisplayCircle,
  getPrivacyZones,
  isPointInPrivacyZone,
  maskEventsForPrivacy,
  maskRoutePointsForPrivacy,
} from '@/lib/privacyZones';
import MapErrorBoundary from '@/components/MapErrorBoundary';
import { useLocalSettingSelector } from '@/hooks/useLocalSettings';
import usePrivacyZonesRevision from '@/hooks/usePrivacyZonesRevision';
import { beginMeasure, measureSync } from '@/lib/performanceTriage';
import { DEFAULT_MAP_CENTER_ARRAY } from '@/lib/mapDefaults';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TILE_STYLES = {
  standard: {
    label: 'Standard',
    url: TILE_URL,
    attribution: TILE_ATTRIBUTION,
    maxZoom: 19,
  },
  detail: {
    label: 'Detail',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: `${TILE_ATTRIBUTION}, Tiles style by Humanitarian OpenStreetMap Team`,
    maxZoom: 19,
  },
};

const EVENT_COLORS = {
  harsh_brake: '#ef4444',
  rapid_acceleration: '#f59e0b',
  sharp_turn: '#3b82f6',
  speeding: '#f97316',
  idle: '#6b7280',
  heading_deviation: '#0ea5e9',
  heading_deviation_legacy: '#0ea5e9',
  aggressive_overtake: '#f97316',
  near_miss: '#dc2626',
  close_proximity: '#dc2626',
  phone_use: '#dc2626',
  possible_crash: '#991b1b',
};
const EMPTY_ROUTE_POINTS = [];
const EMPTY_ROUTES = null;
const EMPTY_EVENTS = [];
const EMPTY_DANGER_ZONES = [];
const EMPTY_ROUTE_RISK_SEGMENTS = [];

const EVENT_LABELS = {
  harsh_brake: '!',
  rapid_acceleration: '+',
  sharp_turn: '<',
  speeding: '>',
  idle: 'P',
  heading_deviation: '<>',
  heading_deviation_legacy: '<>',
  aggressive_overtake: '>>',
  near_miss: '!',
  close_proximity: '!',
  phone_use: 'P',
  possible_crash: '!!',
};

const RISK_COLORS = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
};

const selectTripMapSettings = (settings = {}) => ({
  privacy_zones: settings.privacy_zones,
  units: settings.units || 'metric',
  [HEIGHTENED_PRIVACY_MODE_KEY]: settings[HEIGHTENED_PRIVACY_MODE_KEY],
  show_privacy_circles: settings.show_privacy_circles,
});

const sameTripMapSettings = (previous, next) => (
  previous?.[HEIGHTENED_PRIVACY_MODE_KEY] === next?.[HEIGHTENED_PRIVACY_MODE_KEY] &&
  previous?.units === next?.units &&
  previous?.show_privacy_circles === next?.show_privacy_circles &&
  JSON.stringify(previous?.privacy_zones || []) === JSON.stringify(next?.privacy_zones || [])
);

const useTripMapSettings = () => useLocalSettingSelector(selectTripMapSettings, sameTripMapSettings);

const isUserSpeedLimitSource = (source) => (
  source === 'user_confirmed_posted_sign' || source === 'user_entered_estimate'
);

const speedLimitKmhFrom = (item) => {
  const limit = Number(item?.limitKmh ?? item?.speedLimitKmh ?? item?.speed_limit_kmh);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
};

const speedLimitSourceFrom = (item) => (
  item?.source ?? item?.speedLimitSource ?? item?.limitSource ?? item?.speed_limit_source ?? null
);

const hasUsableSpeedLimit = (item) => speedLimitKmhFrom(item) != null;

const speedKnowledgeTimeKey = (point) => {
  const ts = timeMs(point?.timestamp ?? point?.time ?? point?.recorded_at ?? point?.timestamp_ms ?? point?.timestampMs);
  return ts == null ? null : String(ts);
};

const speedKnowledgeCoordKey = (point) => {
  const lat = finiteCoordinate(point?.original_lat ?? point?.lat);
  const lng = finiteCoordinate(point?.original_lng ?? point?.lng);
  if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
};

const preferUserSpeedLimit = (current, next) => {
  if (!hasUsableSpeedLimit(next)) return current;
  if (!hasUsableSpeedLimit(current)) return next;
  if (isUserSpeedLimitSource(speedLimitSourceFrom(next)) && !isUserSpeedLimitSource(speedLimitSourceFrom(current))) return next;
  return current;
};

const privacyZonePopupHtml = (zone) => (
  `<b>Privacy zone</b><br>${escapeHtml(zone.label || 'Private place')}<br>${Math.round(Number(zone.source_radius_m) || 150)} m mask radius<br>This display outline is intentionally offset from the private location.`
);

const CORNERING_HEATMAP_BANDS = [
  { min: 0.40, label: 'Hard', color: '#dc2626', weight: 8 },
  { min: 0.28, label: 'Firm', color: '#f97316', weight: 7 },
  { min: 0.16, label: 'Active', color: '#eab308', weight: 6 },
  { min: 0.06, label: 'Light', color: '#22c55e', weight: 5 },
];

const phoneUseColor = (event) => {
  const level = event.confidence_level || event.severity || 'medium';
  if (level === 'high') return '#dc2626';
  if (level === 'medium') return '#ea580c';
  return '#f97316';
};

const phoneUseIconHtml = (color) => `
  <div style="width:28px;height:28px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="7" y="2" width="10" height="20" rx="2"></rect>
      <path d="M11 18h2"></path>
    </svg>
  </div>
`;

const eventMarkerHtml = (event, color) => {
  const label = EVENT_LABELS[event.type] || '!';
  const border = event.severity === 'high' || event.type === 'possible_crash' || event.type === 'near_miss' || event.type === 'close_proximity'
    ? 'rgba(220,38,38,0.34)'
    : 'rgba(15,23,42,0.18)';
  return `
    <div style="position:relative;width:30px;height:30px;display:flex;align-items:center;justify-content:center">
      <div style="position:absolute;inset:0;border-radius:999px;background:${color};opacity:.18"></div>
      <div style="width:22px;height:22px;background:${color};color:white;border:2px solid white;border-radius:999px;box-shadow:0 5px 14px ${border};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;line-height:1">${escapeHtml(label)}</div>
    </div>
  `;
};

const corneringBandForG = (lateralG) => (
  CORNERING_HEATMAP_BANDS.find((band) => lateralG >= band.min) || null
);

const formatEventTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
};

const timeMs = (value) => {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : null;
};

const ROUTE_GAP_SECONDS = 120;
const MIN_POLYLINE_ROUTE_POINTS = 3;

const finiteCoordinate = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const validLatLngPoint = (point) => {
  const lat = finiteCoordinate(point?.lat);
  const lng = finiteCoordinate(point?.lng);
  if (lat == null || lng == null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { ...point, lat, lng };
};

const latLngForPoint = (point) => {
  const normalized = validLatLngPoint(point);
  return normalized ? [normalized.lat, normalized.lng] : null;
};

const hasValidLatLng = (point) => validLatLngPoint(point) != null;

const isRouteGapSegment = (prev, curr) => {
  if (!prev || !curr) return false;
  if (curr.tracking_gap === true || curr.route_gap === true) return true;
  const prevMs = timeMs(prev.timestamp ?? prev.time);
  const currMs = timeMs(curr.timestamp ?? curr.time);
  return prevMs != null && currMs != null && currMs > prevMs &&
    (currMs - prevMs) / 1000 > ROUTE_GAP_SECONDS;
};

const splitRoutePointSegments = (points = []) => {
  const segments = [];
  let current = [];

  (points || []).forEach((point) => {
    const validPoint = validLatLngPoint(point);
    if (!validPoint) return;
    if (current.length > 0 && isRouteGapSegment(current[current.length - 1], validPoint)) {
      if (current.length > 1) segments.push(current);
      current = [validPoint];
      return;
    }
    current.push(validPoint);
  });

  if (current.length > 1) segments.push(current);
  return segments;
};

const routePointSegmentsToLatLngs = (segments = []) => (
  segments.map((segment) => segment.map((point) => [point.lat, point.lng]))
);

const routeFitKey = (routes = []) => routes.map((route) => {
  const points = Array.isArray(route.route_points) ? route.route_points : [];
  const first = points[0] || {};
  const middle = points[Math.floor(points.length / 2)] || {};
  const last = points[points.length - 1] || {};
  return [
    route.id || route.label || 'route',
    route.selected ? '1' : '0',
    points.length,
    first.timestamp || first.time || '',
    last.timestamp || last.time || '',
    Number(first.lat).toFixed(5),
    Number(first.lng).toFixed(5),
    Number(middle.lat).toFixed(5),
    Number(middle.lng).toFixed(5),
    Number(last.lat).toFixed(5),
    Number(last.lng).toFixed(5),
  ].join(':');
}).join('|');

const formatSpeedRange = (min, max, units = 'metric') => {
  const low = Math.round(Number(min) || 0);
  const high = Math.round(Number(max) || 0);
  return low === high ? formatSpeed(low, units) : `${formatSpeed(low, units)}–${formatSpeed(high, units)}`;
};

const buildSpeedLimitOverlayRuns = (route, localKnowledgeForPoint) => {
  const points = Array.isArray(route?.route_points) ? route.route_points : [];
  const runs = [];
  let active = null;

  const finish = () => {
    if (active && active.positions.length >= 2) runs.push(active);
    active = null;
  };

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (isRouteGapSegment(prev, curr)) {
      finish();
      continue;
    }

    const currLocal = localKnowledgeForPoint(curr, i, points);
    const prevLocal = localKnowledgeForPoint(prev, i - 1, points);
    const userLocal = [currLocal, prevLocal].find((item) => (
      isUserSpeedLimitSource(speedLimitSourceFrom(item)) &&
      hasUsableSpeedLimit(item)
    ));
    const fallbackLocal = [currLocal, prevLocal].find(hasUsableSpeedLimit);
    const tripLimit = Number(curr.speed_limit_kmh ?? prev.speed_limit_kmh);
    const selectedLimit = userLocal || (
      Number.isFinite(tripLimit) && tripLimit > 0
        ? { limitKmh: tripLimit, source: curr.speed_limit_source || prev.speed_limit_source || 'openstreetmap' }
        : fallbackLocal
    );
    const limit = speedLimitKmhFrom(selectedLimit);
    if (!Number.isFinite(limit) || limit <= 0) {
      finish();
      continue;
    }

    const speed = Number(curr.speed_kmh ?? prev.speed_kmh) || 0;
    const overBy = speed - limit;
    const color = overBy > 10 ? '#ef4444' : overBy > 0 ? '#f97316' : '#22c55e';
    const source = speedLimitSourceFrom(selectedLimit) || curr.speed_limit_source || prev.speed_limit_source || 'openstreetmap';
    const roadName = curr.speed_limit_road_name || prev.speed_limit_road_name || 'matched road';
    const key = `${color}:${Math.round(limit)}:${source}:${roadName}`;

    if (!active || active.key !== key) {
      finish();
      active = {
        key,
        positions: [[prev.lat, prev.lng], [curr.lat, curr.lng]],
        color,
        limit,
        source,
        roadName,
        minSpeed: speed,
        maxSpeed: speed,
        minOverBy: overBy,
        maxOverBy: overBy,
        segmentCount: 1,
      };
      continue;
    }

    active.positions.push([curr.lat, curr.lng]);
    active.minSpeed = Math.min(active.minSpeed, speed);
    active.maxSpeed = Math.max(active.maxSpeed, speed);
    active.minOverBy = Math.min(active.minOverBy, overBy);
    active.maxOverBy = Math.max(active.maxOverBy, overBy);
    active.segmentCount += 1;
  }

  finish();
  return runs;
};

const speedLimitOverlayPopupHtml = (route, run, units = 'metric') => {
  const maxOver = Number(run.maxOverBy) || 0;
  const minOver = Number(run.minOverBy) || 0;
  const comparison = maxOver > 0
    ? `${formatSpeed(maxOver, units)} max over`
    : minOver < 0
      ? `${formatSpeed(Math.abs(minOver), units)} under`
      : 'At the saved limit';
  return `${routeLabelPopupPrefix(route.label)}<b>${escapeHtml(run.roadName)}</b>` +
    `<br>Speed: ${escapeHtml(formatSpeedRange(run.minSpeed, run.maxSpeed, units))}` +
    `<br>Limit: ${escapeHtml(formatSpeed(run.limit, units))}` +
    `<br>${escapeHtml(comparison)}` +
    `<br>Source: ${escapeHtml(speedLimitSourceLabel(run.source))}` +
    `<br>${escapeHtml(run.segmentCount)} merged segment${run.segmentCount === 1 ? '' : 's'}`;
};

const routeTelemetry = (points = []) => {
  const clean = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (!clean.length) {
    return { distanceKm: 0, durationSeconds: 0, avgSpeedKmh: 0, maxSpeedKmh: 0, pointCount: 0 };
  }

  let distanceKm = 0;
  splitRoutePointSegments(clean).forEach((segment) => {
    for (let i = 1; i < segment.length; i++) {
      distanceKm += haversineDistance(segment[i - 1].lat, segment[i - 1].lng, segment[i].lat, segment[i].lng);
    }
  });

  const speeds = clean.map((point) => Number(point.speed_kmh)).filter(Number.isFinite);
  const firstTime = timeMs(clean[0].timestamp);
  const lastTime = timeMs(clean[clean.length - 1].timestamp);
  return {
    distanceKm,
    durationSeconds: firstTime != null && lastTime != null && lastTime > firstTime ? Math.round((lastTime - firstTime) / 1000) : 0,
    avgSpeedKmh: speeds.length ? Math.round(speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length) : 0,
    maxSpeedKmh: speeds.length ? Math.round(Math.max(...speeds)) : 0,
    pointCount: clean.length,
  };
};

const detectStops = (points = []) => {
  /** @type {Array<Record<string, any> & { durationSeconds: number }>} */
  const stops = [];
  /** @type {Record<string, any> | null} */
  let start = null;
  /** @type {Record<string, any> | null} */
  let last = null;

  points.forEach((point) => {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
    const speed = Number(point.speed_kmh) || 0;
    if (speed <= 5) {
      start ??= point;
      last = point;
      return;
    }

    if (start && last) {
      const startTs = timeMs(start.timestamp);
      const lastTs = timeMs(last.timestamp);
      const durationSeconds = startTs != null && lastTs != null ? Math.round((lastTs - startTs) / 1000) : 0;
      if (durationSeconds >= 60) stops.push({ ...start, durationSeconds });
    }
    start = null;
    last = null;
  });

  if (start && last) {
    const startTs = timeMs(start.timestamp);
    const lastTs = timeMs(last.timestamp);
    const durationSeconds = startTs != null && lastTs != null ? Math.round((lastTs - startTs) / 1000) : 0;
    if (durationSeconds >= 60) stops.push({ ...start, durationSeconds });
  }

  return stops;
};

const clusterEvents = (events = []) => {
  const groups = new Map();
  events
    .map(validLatLngPoint)
    .filter(Boolean)
    .forEach((event) => {
      const key = `${Math.round(event.lat * 1200)},${Math.round(event.lng * 1200)}`;
      const group = groups.get(key) || { latSum: 0, lngSum: 0, events: [], typeCounts: new Map(), dominant: null };
      group.latSum += event.lat;
      group.lngSum += event.lng;
      group.events.push(event);
      const typeCount = (group.typeCounts.get(event.type) || 0) + 1;
      group.typeCounts.set(event.type, typeCount);
      if (!group.dominant || typeCount > (group.typeCounts.get(group.dominant.type) || 0)) {
        group.dominant = event;
      }
      groups.set(key, group);
    });

  return [...groups.values()].map((group) => {
    return {
      lat: group.latSum / group.events.length,
      lng: group.lngSum / group.events.length,
      events: group.events,
      count: group.events.length,
      dominant: group.dominant || group.events[0],
    };
  });
};

const clusterPopupHtml = (events = []) => `
  <div style="min-width:210px">
    <b>${events.length} nearby events</b>
    <div style="margin-top:6px;display:grid;gap:5px">
      ${events.slice(0, 6).map((event) => `<div><span style="color:#64748b">${escapeHtml(formatEventTime(event.timestamp) || '')}</span> ${escapeHtml(titleCase(event.type))}</div>`).join('')}
      ${events.length > 6 ? `<div style="color:#64748b">+ ${events.length - 6} more</div>` : ''}
    </div>
  </div>
`;

const eventPopupHtml = (event, units = 'metric') => {
  const label = titleCase(event.type || 'event');
  const speedLimitValue = event.speed_limit_kmh ?? event.inferred_zone_kmh;
  const speedLimitSource = event.speed_limit_source || event.source || null;
  const speedLimitLabel = Number.isFinite(Number(speedLimitValue))
    ? `${formatSpeed(Number(speedLimitValue), units)}${speedLimitSource === 'inferred' ? ' inferred estimate' : ''}`
    : null;
  const rows = [
    ['Severity', titleCase(event.severity || event.confidence_level || 'medium')],
    ['Time', formatEventTime(event.timestamp)],
    ['Speed', Number.isFinite(Number(event.speed_kmh)) ? formatSpeed(Number(event.speed_kmh), units) : null],
    ['Limit', speedLimitLabel],
    ['Over by', Number.isFinite(Number(event.speed_kmh)) && Number.isFinite(Number(speedLimitValue))
      ? formatSpeed(Math.max(0, Number(event.speed_kmh) - Number(speedLimitValue)), units)
      : null],
    ['Duration', Number.isFinite(Number(event.durationS ?? event.duration_seconds ?? event.value)) && (event.type === 'phone_use' || event.type === 'idle' || event.duration_seconds != null)
      ? `${Math.round(Number(event.durationS ?? event.duration_seconds ?? event.value))}s`
      : null],
    ['Source', speedLimitSource === 'inferred' ? 'GPS-inferred estimate' : speedLimitSource],
    ['Confidence', event.zone_confidence || event.confidence_level || null],
    ['Signals', Array.isArray(event.signals_triggered) && event.signals_triggered.length ? event.signals_triggered.join(', ') : null],
  ].filter(([, value]) => value != null && value !== '');

  return `
    <div style="min-width:190px">
      <b>${escapeHtml(label)}</b>
      <div style="margin-top:6px;display:grid;gap:3px">
        ${rows.map(([key, value]) => `<div><span style="color:#64748b">${escapeHtml(key)}:</span> ${escapeHtml(value)}</div>`).join('')}
      </div>
    </div>
  `;
};

let leafletLoaded = false;
let loadPromise = null;
let leafletDomGuardsInstalled = false;

function installLeafletDomGuards(leaflet) {
  if (leafletDomGuardsInstalled || !leaflet?.DomUtil) return;
  const { DomUtil } = leaflet;
  const originalAddClass = DomUtil.addClass;
  const originalRemoveClass = DomUtil.removeClass;
  const originalHasClass = DomUtil.hasClass;

  DomUtil.addClass = (element, name) => {
    if (!element?.classList) return undefined;
    return originalAddClass(element, name);
  };
  DomUtil.removeClass = (element, name) => {
    if (!element?.classList) return undefined;
    return originalRemoveClass(element, name);
  };
  DomUtil.hasClass = (element, name) => {
    if (!element?.classList) return false;
    return originalHasClass(element, name);
  };
  leafletDomGuardsInstalled = true;
}

function loadLeaflet() {
  if (typeof window !== 'undefined' && !window.L) window.L = L;
  if (typeof window !== 'undefined') installLeafletDomGuards(window.L || L);
  if (leafletLoaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve) => {
    window.L = window.L || L;
    installLeafletDomGuards(window.L);
    leafletLoaded = true;
    resolve();
  });

  return loadPromise;
}

const safeLeafletCall = (callback) => {
  try {
    return callback();
  } catch {
    return null;
  }
};

const stopLeafletMap = (map) => {
  safeLeafletCall(() => map?.stop?.());
  safeLeafletCall(() => map?.closePopup?.());
  safeLeafletCall(() => map?.closeTooltip?.());
};

const safeMapSetView = (map, center, zoom, options = {}) => safeLeafletCall(() => (
  map?.setView?.(center, zoom, { animate: false, ...options })
));

const safeMapFitBounds = (map, bounds, options = {}) => measureSync('TripMap.fitBounds', () => {
  if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return null;
  return safeLeafletCall(() => map?.fitBounds?.(bounds, { animate: false, ...options }));
});

const safeMapPanTo = (map, center, zoom = 15) => safeLeafletCall(() => {
  if (!map?._loaded) return map?.setView?.(center, zoom, { animate: false });
  return map.panTo(center, { animate: false });
});

export default function TripMap(props) {
  const resetKey = Array.isArray(props.routes)
    ? props.routes.map((route) => `${route.id || route.label || 'route'}:${route.selected ? '1' : '0'}:${route.route_points?.length || 0}`).join('|')
    : routeFitKey([{ id: 'selected', route_points: props.routePoints || [], selected: true }]);

  return (
    <MapErrorBoundary
      context="trip_map"
      title="Map unavailable"
      message="Something went wrong while drawing this route. Trip details and controls are still available."
      resetKey={resetKey}
      height={props.height || '350px'}
    >
      <TripMapContent {...props} />
    </MapErrorBoundary>
  );
}

function TripMapContent({
  routePoints = EMPTY_ROUTE_POINTS,
  routes = EMPTY_ROUTES,
  diagnosticTrips = undefined,
  events = EMPTY_EVENTS,
  showCurrentLocation = false,
  currentLocation = null,
  parkedLocation = null,
  parkedLocationDraggable = false,
  onParkedLocationMove = null,
  showPrivacyZones = true,
  showCorneringHeatmap = false,
  showDangerZones = false,
  dangerZones = EMPTY_DANGER_ZONES,
  showRouteRisk = false,
  routeRiskSegments = EMPTY_ROUTE_RISK_SEGMENTS,
  showSpeedLimits = false,
  showIncompleteRouteWarning = true,
  showRouteSummary = true,
  speedLimitKnowledgeResults = EMPTY_ROUTE_POINTS,
  rawPointCount = null,
  smoothRoute = true,
  height = '350px',
  className = '',
  onEventSelect = null,
  focusPoint = null,
}) {
  const mapRef = useRef(null);
  const leafletMapRef = useRef(null);
  const layersRef = useRef(null);
  const tileLayerRef = useRef(null);
  const onEventSelectRef = useRef(onEventSelect);
  const onParkedLocationMoveRef = useRef(onParkedLocationMove);
  const focusLayerRef = useRef(null);
  const lastBoundsRef = useRef(null);
  const lastFitRouteKeyRef = useRef('');
  const tileErrorCountRef = useRef(0);
  const tileFailureReportedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [tileStyle, setTileStyle] = useState('standard');
  const [showInsights, setShowInsights] = useState(true);
  const [selectedSegment, setSelectedSegment] = useState(null);
  const settings = useTripMapSettings();
  const units = settings.units || 'metric';
  const heightenedPrivacy = settings?.[HEIGHTENED_PRIVACY_MODE_KEY] === true;
  const privacyZonesRevision = usePrivacyZonesRevision();
  onEventSelectRef.current = onEventSelect;
  onParkedLocationMoveRef.current = onParkedLocationMove;

  useEffect(() => {
    const map = leafletMapRef.current;
    if (!ready || !map) return undefined;
    if (focusLayerRef.current) {
      safeLeafletCall(() => focusLayerRef.current.remove());
      focusLayerRef.current = null;
    }
    const point = validLatLngPoint(focusPoint);
    if (!point || point.masked_for_privacy === true || point.privacy_gap === true || point.privacy_boundary === true) return undefined;
    const layer = L.circleMarker([point.lat, point.lng], {
      radius: 9,
      color: '#1d4ed8',
      fillColor: '#ffffff',
      fillOpacity: 0.95,
      weight: 3,
      pane: 'markerPane',
    }).addTo(map);
    focusLayerRef.current = layer;
    safeMapPanTo(map, [point.lat, point.lng]);
    return () => {
      safeLeafletCall(() => layer.remove());
      if (focusLayerRef.current === layer) focusLayerRef.current = null;
    };
  }, [focusPoint, ready]);

  const resetTileFailureTracking = useCallback(() => {
    tileErrorCountRef.current = 0;
    tileFailureReportedRef.current = false;
  }, []);

  const handleTileError = useCallback(() => {
    tileErrorCountRef.current += 1;
    if (tileFailureReportedRef.current || tileErrorCountRef.current < 4) return;
    tileFailureReportedRef.current = true;
    setMapFailed(true);
  }, []);

  const selectedRoute = useMemo(() => {
    const routeSets = Array.isArray(routes)
      ? routes
      : [{ id: 'selected', route_points: routePoints, selected: true }];
    return routeSets.find((route) => route.selected) || routeSets[0] || {};
  }, [routePoints, routes]);
  const mapInputKey = useMemo(() => {
    const routeSets = Array.isArray(routes)
      ? routes
      : [{ id: 'selected', route_points: routePoints, selected: true }];
    return routeFitKey(routeSets);
  }, [routePoints, routes]);
  const selectedRoutePoints = useMemo(
    () => {
      const points = prepareMapRoutePoints(selectedRoute.route_points || [], {
        maxPoints: 900,
        smooth: smoothRoute,
      });
      return injectTimestampGapMarkers(points);
    },
    [selectedRoute, smoothRoute]
  );
  const telemetry = useMemo(() => routeTelemetry(selectedRoutePoints), [selectedRoutePoints]);
  const overviewDiagnostics = useMemo(() => (
    Array.isArray(diagnosticTrips) ? buildMapDiagnosticsAggregate(diagnosticTrips) : null
  ), [diagnosticTrips]);
  const diagnostics = overviewDiagnostics
    ? {
      distanceKm: overviewDiagnostics.distance_km,
      durationSeconds: overviewDiagnostics.duration_seconds,
      avgSpeedKmh: overviewDiagnostics.avg_speed_kmh,
      maxSpeedKmh: overviewDiagnostics.max_speed_kmh,
    }
    : telemetry;
  const recordedPointCount = overviewDiagnostics
    ? overviewDiagnostics.route_points_raw_count
    : Number(rawPointCount ?? selectedRoute.rawPointCount ?? selectedRoute.route_points_raw_count) || selectedRoutePoints.length;
  const detectedStopCount = useMemo(() => detectStops(selectedRoutePoints).length, [selectedRoutePoints]);
  const stopCount = overviewDiagnostics?.traffic_stop_count ?? detectedStopCount;
  const diagnosticEventCount = overviewDiagnostics?.driving_events_count ?? events.length;
  const phoneEventCount = useMemo(
    () => (events || []).filter((event) => event?.type === 'phone_use' && event?.source === 'android_usage_access').length,
    [events]
  );
  const hasRoute = telemetry.pointCount > 1;
  const routeIncomplete = hasRoute && telemetry.pointCount < MIN_POLYLINE_ROUTE_POINTS;

  useEffect(() => {
    setSelectedSegment(null);
    resetTileFailureTracking();
    lastFitRouteKeyRef.current = '';
  }, [mapInputKey, resetTileFailureTracking]);

  useEffect(() => {
    if (mapFailed) return undefined;

    let cancelled = false;
    let invalidateTimer = null;

    loadLeaflet().then(() => {
      if (cancelled || !mapRef.current || leafletMapRef.current) return;

      try {
        const map = window.L.map(mapRef.current, {
          zoomControl: true,
          attributionControl: true,
          fadeAnimation: false,
          markerZoomAnimation: false,
          zoomAnimation: false,
        });

        leafletMapRef.current = map;
        safeMapSetView(map, DEFAULT_MAP_CENTER_ARRAY, 12);

        resetTileFailureTracking();

        layersRef.current = window.L.layerGroup().addTo(map);
        setReady(true);
        invalidateTimer = window.setTimeout(() => {
          invalidateTimer = null;
          if (leafletMapRef.current === map) safeLeafletCall(() => map.invalidateSize({ animate: false }));
        }, 0);
      } catch (error) {
        console.error('Trip map failed to initialize', error);
        if (!cancelled) setMapFailed((failed) => failed || true);
        stopLeafletMap(leafletMapRef.current);
        safeLeafletCall(() => layersRef.current?.clearLayers?.());
        safeLeafletCall(() => tileLayerRef.current?.off?.('tileerror', handleTileError));
        safeLeafletCall(() => tileLayerRef.current?.remove?.());
        safeLeafletCall(() => leafletMapRef.current?.remove?.());
        leafletMapRef.current = null;
        layersRef.current = null;
        tileLayerRef.current = null;
      }
    }).catch(() => {
      if (!cancelled) setMapFailed((failed) => failed || true);
    });

    return () => {
      cancelled = true;
      if (invalidateTimer) window.clearTimeout(invalidateTimer);
      if (leafletMapRef.current) {
        stopLeafletMap(leafletMapRef.current);
        safeLeafletCall(() => layersRef.current?.clearLayers?.());
        safeLeafletCall(() => tileLayerRef.current?.off?.('tileerror', handleTileError));
        safeLeafletCall(() => tileLayerRef.current?.remove?.());
        safeLeafletCall(() => leafletMapRef.current.remove());
        leafletMapRef.current = null;
        layersRef.current = null;
        tileLayerRef.current = null;
        lastBoundsRef.current = null;
        lastFitRouteKeyRef.current = '';
      }
    };
  }, [handleTileError, mapFailed, resetTileFailureTracking]);

  useEffect(() => {
    if (mapFailed) setReady(false);
  }, [mapFailed]);

  useEffect(() => {
    const map = leafletMapRef.current;
    if (mapFailed || !ready || !map || !window.L) return;

    resetTileFailureTracking();
    stopLeafletMap(map);
    safeLeafletCall(() => tileLayerRef.current?.off?.('tileerror', handleTileError));
    safeLeafletCall(() => tileLayerRef.current && map.removeLayer(tileLayerRef.current));
    tileLayerRef.current = null;
    if (heightenedPrivacy) return;

    const tileConfig = TILE_STYLES[tileStyle] || TILE_STYLES.standard;
    tileLayerRef.current = window.L.tileLayer(tileConfig.url, {
      attribution: tileConfig.attribution,
      maxZoom: tileConfig.maxZoom,
    })
      .on('tileerror', handleTileError)
      .addTo(map);
  }, [handleTileError, heightenedPrivacy, mapFailed, ready, resetTileFailureTracking, tileStyle]);

  useEffect(() => {
    const map = leafletMapRef.current;
    const layers = layersRef.current;
    if (mapFailed || !ready || !map || !layers || !window.L) return;
    const endDraw = beginMeasure('TripMap.layerDraw');

    try {
      stopLeafletMap(map);
      safeLeafletCall(() => layers.clearLayers());

    const routeSets = Array.isArray(routes)
      ? routes
      : [{ id: 'selected', route_points: routePoints, color: '#3b82f6', selected: true }];
    const hasSelectedRoute = routeSets.some((route) => route.selected);
    const selectedRawRoute = routeSets.find((route) => route.selected) || routeSets[0] || {};
    const selectedRawPoints = Array.isArray(selectedRawRoute.route_points) ? selectedRawRoute.route_points : [];
    const localKnowledgeByTime = new Map();
    const localKnowledgeByCoord = new Map();
    selectedRawPoints.forEach((point, index) => {
      const knowledge = speedLimitKnowledgeResults[index];
      if (!hasUsableSpeedLimit(knowledge)) return;
      const timeKey = speedKnowledgeTimeKey(point);
      if (timeKey) {
        localKnowledgeByTime.set(timeKey, preferUserSpeedLimit(localKnowledgeByTime.get(timeKey), knowledge));
      }
      const coordKey = speedKnowledgeCoordKey(point);
      if (coordKey) {
        localKnowledgeByCoord.set(coordKey, preferUserSpeedLimit(localKnowledgeByCoord.get(coordKey), knowledge));
      }
    });
    const localKnowledgeForPoint = (point, index, visualPoints = []) => {
      const timeKey = speedKnowledgeTimeKey(point);
      if (timeKey && localKnowledgeByTime.has(timeKey)) return localKnowledgeByTime.get(timeKey);
      const coordKey = speedKnowledgeCoordKey(point);
      if (coordKey && localKnowledgeByCoord.has(coordKey)) return localKnowledgeByCoord.get(coordKey);
      return selectedRawPoints.length === visualPoints.length ? speedLimitKnowledgeResults[index] || null : null;
    };
    const privacySettings = settings;
    const privacyDisplayReferences = [
      ...routeSets.flatMap((route) => route.route_points || []),
      currentLocation,
      parkedLocation,
    ];
    const displayPrivacyZones = showPrivacyZones && privacySettings.show_privacy_circles === true
      ? getPrivacyZones(privacySettings)
        .map((zone) => getPrivacyZoneDisplayCircle(zone, undefined, privacyDisplayReferences))
        .filter(hasValidLatLng)
      : [];
    const visiblePrivacyZones = getPrivacyZones(privacySettings);
    const validRoutes = routeSets
      .map((route) => {
        const maskedPoints = maskRoutePointsForPrivacy(route.route_points || [], privacySettings);
        const visualPoints = prepareMapRoutePoints(maskedPoints, {
          maxPoints: route.selected ? 900 : 260,
          smooth: smoothRoute,
        });
        const routeVisualPoints = injectTimestampGapMarkers(visualPoints)
          .map(validLatLngPoint)
          .filter(Boolean);
        return {
          ...route,
          color: route.color || (route.selected ? '#3b82f6' : '#64748b'),
          opacity: route.opacity ?? (route.selected ? 0.9 : hasSelectedRoute ? 0.36 : 0.42),
          route_points: routeVisualPoints,
        };
      })
      .filter((route) => route.route_points.length > 1);
    // Use Leaflet's default SVG renderer here. A short-lived canvas renderer can
    // keep a queued redraw after its layer group is cleared, which floods logs
    // with `_ctx.save` / `_ctx.clearRect` errors on the overview map.
    const mapEvents = maskEventsForPrivacy(events || [], privacySettings);
    const isPrivatePoint = (point) => Boolean(isPointInPrivacyZone(point, visiblePrivacyZones));
    const segmentTouchesPrivacy = (segment) => {
      const fromPoint = validLatLngPoint(segment?.from);
      const toPoint = validLatLngPoint(segment?.to);
      const midpoint = fromPoint && toPoint
        ? {
          lat: (fromPoint.lat + toPoint.lat) / 2,
          lng: (fromPoint.lng + toPoint.lng) / 2,
        }
        : null;
      return [fromPoint, toPoint, midpoint].some((point) => point && isPrivatePoint(point));
    };
    const normalizedCurrentLocation = validLatLngPoint(currentLocation);
    const normalizedParkedLocation = validLatLngPoint(parkedLocation);
    const safeCurrentLocation = normalizedCurrentLocation && !isPrivatePoint(normalizedCurrentLocation) ? normalizedCurrentLocation : null;
    const safeParkedLocation = normalizedParkedLocation && !isPrivatePoint(normalizedParkedLocation) ? normalizedParkedLocation : null;
    const speedLimitInfoForSegment = (segment, route) => {
      const routeSegmentPoints = Array.isArray(route?.route_points) ? route.route_points : [];
      const from = segment?.from;
      const to = segment?.to;
      const fromIndex = Number.isInteger(segment?.fromIndex) ? segment.fromIndex : routeSegmentPoints.indexOf(from);
      const toIndex = Number.isInteger(segment?.toIndex) ? segment.toIndex : routeSegmentPoints.indexOf(to);
      const fromLocal = route?.selected && fromIndex >= 0
        ? localKnowledgeForPoint(from, fromIndex, routeSegmentPoints)
        : null;
      const toLocal = route?.selected && toIndex >= 0
        ? localKnowledgeForPoint(to, toIndex, routeSegmentPoints)
        : null;
      const localItems = [toLocal, fromLocal];
      const userLocal = localItems.find((item) => (
        isUserSpeedLimitSource(speedLimitSourceFrom(item)) &&
        hasUsableSpeedLimit(item)
      ));
      const fallbackLocal = localItems.find(hasUsableSpeedLimit);
      const segmentLimit = speedLimitKmhFrom(segment);
      const pointLimit = speedLimitKmhFrom(to) ?? speedLimitKmhFrom(from);
      const routeLimit = segmentLimit ?? pointLimit;
      const selected = userLocal || (
        routeLimit != null
          ? {
            limitKmh: routeLimit,
            source: segment?.speedLimitSource || speedLimitSourceFrom(to) || speedLimitSourceFrom(from),
          }
          : fallbackLocal
      );
      const limitKmh = speedLimitKmhFrom(selected);
      if (limitKmh == null) return null;
      return {
        limitKmh,
        source: speedLimitSourceFrom(selected) || segment?.speedLimitSource || speedLimitSourceFrom(to) || speedLimitSourceFrom(from),
        roadName: segment?.roadName || to?.speed_limit_road_name || from?.speed_limit_road_name || null,
      };
    };
    const drawPrivacyZones = (bounds = null) => {
      displayPrivacyZones.forEach((zone) => {
        const latLng = latLngForPoint(zone);
        if (!latLng) return;
        const radius = Number.isFinite(Number(zone.radius_m)) && Number(zone.radius_m) > 0
          ? Number(zone.radius_m)
          : 150;
        const circle = window.L.circle(latLng, {
          radius,
          color: '#2563eb',
          fillColor: '#3b82f6',
          fillOpacity: 0.08,
          opacity: 0.72,
          weight: 2,
          dashArray: '8 6',
        })
          .bindPopup(privacyZonePopupHtml(zone))
          .addTo(layers);
        bounds?.extend(circle.getBounds());
      });
    };

    if (validRoutes.length > 0) {
      const bounds = window.L.latLngBounds([]);
      const endPolylineLoop = beginMeasure('TripMap.polylineCreationLoop', {
        routeCount: validRoutes.length,
        routePointCount: validRoutes.reduce((sum, route) => sum + route.route_points.length, 0),
      });

      validRoutes.forEach((route) => {
        const pointSegments = splitRoutePointSegments(route.route_points);
        const latLngSegments = routePointSegmentsToLatLngs(pointSegments);
        const latLngs = route.route_points.map(p => [p.lat, p.lng]);
        latLngs.forEach((latLng) => bounds.extend(latLng));
        if (route.route_points.length < MIN_POLYLINE_ROUTE_POINTS) return;
        const renderDetailedSegments = route.selected || !Array.isArray(routes);
        if (!renderDetailedSegments) {
          window.L.polyline(latLngSegments, {
            color: route.color,
            weight: 3,
            opacity: route.opacity,
            smoothFactor: 2,
            lineCap: 'round',
            lineJoin: 'round',
          })
            .bindPopup(route.label ? `<b>${escapeHtml(route.label)}</b>` : 'Trip route')
            .addTo(layers);
          return;
        }

        const timeline = buildPlaybackTimeline(route.route_points, mapEvents);
        const speedSegments = timeline
          ? timeline.segments || []
          : buildSpeedSegments(route.route_points);

        if (showCorneringHeatmap && route.selected && route.route_points.length > 2) {
          latLngSegments.forEach((segmentLatLngs) => {
            window.L.polyline(segmentLatLngs, {
              color: '#0f172a',
              weight: 7,
              opacity: 0.16,
              smoothFactor: 1.5,
              lineCap: 'round',
              lineJoin: 'round',
            }).addTo(layers);
          });

          for (let i = 1; i < route.route_points.length - 1; i++) {
            const prev = route.route_points[i - 1];
            const curr = route.route_points[i];
            const next = route.route_points[i + 1];
            if (isRouteGapSegment(prev, curr) || isRouteGapSegment(curr, next)) continue;
            const dtPrev = (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000;
            const dtNext = (new Date(next.timestamp).getTime() - new Date(curr.timestamp).getTime()) / 1000;
            if (dtPrev <= 0 || dtNext <= 0 || dtPrev > 15 || dtNext > 15) continue;
            const h1 = calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
            const h2 = calculateBearing(curr.lat, curr.lng, next.lat, next.lng);
            const headingChange = headingDiff(h1, h2);
            const speedCandidates = [prev.speed_kmh, curr.speed_kmh, next.speed_kmh]
              .map(Number)
              .filter(Number.isFinite);
            const speed = speedCandidates.length
              ? speedCandidates.reduce((sum, value) => sum + value, 0) / speedCandidates.length
              : 0;
            if (speed < 15 || headingChange < 1.5) continue;
            const lateralG = ((speed / 3.6) * ((headingChange * Math.PI / 180) / Math.max(1.5, (dtPrev + dtNext) / 2))) / 9.81;
            const band = corneringBandForG(lateralG);
            if (!band) continue;
            const intensityWeight = band.weight + Math.min(5, Math.max(0, (lateralG - band.min) * 10));
            window.L.polyline(
              [[prev.lat, prev.lng], [curr.lat, curr.lng], [next.lat, next.lng]],
              {
                color: band.color,
                weight: intensityWeight,
                opacity: Math.max(route.opacity, 0.72),
                smoothFactor: 1.5,
                lineCap: 'round',
                lineJoin: 'round',
              }
            ).addTo(layers);
            if (lateralG >= 0.28) {
              window.L.circleMarker([curr.lat, curr.lng], {
                radius: Math.min(14, 4 + lateralG * 12),
                color: band.color,
                fillColor: band.color,
                fillOpacity: 0.20,
                opacity: 0.34,
                weight: 1,
                interactive: false,
              }).addTo(layers);
            }
          }
        } else if (speedSegments.length > 0) {
          latLngSegments.forEach((segmentLatLngs) => {
            window.L.polyline(segmentLatLngs, {
              color: '#0f172a',
              weight: route.selected ? 9 : 6,
              opacity: route.selected ? 0.18 : 0.10,
              smoothFactor: 1.5,
              lineCap: 'round',
              lineJoin: 'round',
            }).addTo(layers);
          });
          speedSegments.forEach((segment) => {
            const from = segment.from;
            const to = segment.to;
            const label = segment.band?.label || segment.label || 'Segment';
            const speedKmh = segment.speedKmh ?? segment.speed_kmh ?? 0;
            const speedLimitInfo = speedLimitInfoForSegment(segment, route);
            const speedLimitKmh = speedLimitInfo?.limitKmh ?? null;
            const overLimitKmh = speedLimitKmh != null ? Math.max(0, Number(speedKmh) - speedLimitKmh) : (segment.overLimitKmh || 0);
            const displaySegment = {
              ...segment,
              speedKmh,
              speedLimitKmh,
              overLimitKmh,
              speedLimitSource: speedLimitInfo?.source || segment.speedLimitSource || null,
              roadName: speedLimitInfo?.roadName || segment.roadName || null,
            };
            const color = segment.speedBandColor || segment.color || segment.band?.color || route.color;
            window.L.polyline(
              [[from.lat, from.lng], [to.lat, to.lng]],
              {
                color,
                weight: route.selected ? 6 : 4,
                opacity: route.opacity,
                smoothFactor: 1.5,
                lineCap: 'round',
                lineJoin: 'round',
              }
            )
              .bindPopup(buildSpeedSegmentPopupHtml({
                routeLabel: route.label,
                label,
                speedKmh,
                speedLimitKmh,
              }))
              .on('click', () => {
                if (segment.band) setSelectedSegment(displaySegment);
              })
              .addTo(layers);
          });
          if (showSpeedLimits && route.selected) {
            buildSpeedLimitOverlayRuns(route, localKnowledgeForPoint).forEach((run) => {
              window.L.polyline(
                run.positions,
                {
                  color: run.color,
                  weight: route.selected ? 8 : 5,
                  opacity: 0.48,
                  smoothFactor: 1.5,
                  lineCap: 'round',
                  lineJoin: 'round',
                }
              )
                .bindPopup(speedLimitOverlayPopupHtml(route, run, units))
                .addTo(layers);
            });
          }
        } else {
          latLngSegments.forEach((segmentLatLngs) => {
            window.L.polyline(segmentLatLngs, {
              color: route.color,
              weight: route.selected ? 6 : 4,
              opacity: route.opacity,
              smoothFactor: 1.5,
              lineCap: 'round',
              lineJoin: 'round',
            })
              .bindPopup(route.label ? `<b>${escapeHtml(route.label)}</b>` : 'Trip route')
              .addTo(layers);
          });
        }
      });

      endPolylineLoop({ outcome: 'success' });
      drawPrivacyZones(bounds);

      lastBoundsRef.current = bounds;
      const nextFitKey = routeFitKey(validRoutes);
      if (nextFitKey && lastFitRouteKeyRef.current !== nextFitKey) {
        safeMapFitBounds(map, bounds, { padding: [20, 20] });
        lastFitRouteKeyRef.current = nextFitKey;
      }

      const primaryRoute = validRoutes.find((route) => route.selected) || validRoutes[0];
      const latLngs = primaryRoute.route_points.map(p => [p.lat, p.lng]);
      const primaryStops = detectStops(primaryRoute.route_points);

      primaryStops.slice(0, 12).forEach((stop, index) => {
        window.L.circleMarker([stop.lat, stop.lng], {
          radius: 8,
          color: '#0f172a',
          fillColor: '#f8fafc',
          fillOpacity: 0.92,
          weight: 2,
        })
          .bindPopup(`<b>Stop ${index + 1}</b><br>${formatDuration(stop.durationSeconds)}`)
          .addTo(layers);
      });

      const startIcon = window.L.divIcon({
        html: '<div style="width:14px;height:14px;background:#22c55e;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>',
        className: '',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      window.L.marker(latLngs[0], { icon: startIcon })
        .bindPopup('<b>Start</b>')
        .addTo(layers);

      const endPoint = primaryRoute.route_points[primaryRoute.route_points.length - 1];
      const endedStopped = Number(endPoint?.speed_kmh || 0) < 5;
      const endIcon = window.L.divIcon({
        html: endedStopped
          ? '<div style="width:22px;height:22px;background:#f97316;border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.28);display:flex;align-items:center;justify-content:center;color:white;font-size:12px;font-weight:700">P</div>'
          : '<div style="width:14px;height:14px;background:#ef4444;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>',
        className: '',
        iconSize: endedStopped ? [22, 22] : [14, 14],
        iconAnchor: endedStopped ? [11, 11] : [7, 7],
      });
      window.L.marker(latLngs[latLngs.length - 1], { icon: endIcon })
        .bindPopup(endedStopped ? '<b>Parked / trip ended</b>' : '<b>End</b>')
        .addTo(layers);
    } else if (safeParkedLocation) {
      const bounds = window.L.latLngBounds([
        [safeParkedLocation.lat, safeParkedLocation.lng],
      ]);
      drawPrivacyZones();
      lastBoundsRef.current = bounds;
      safeMapSetView(map, [safeParkedLocation.lat, safeParkedLocation.lng], 17);
    } else if (displayPrivacyZones.length > 0) {
      const bounds = window.L.latLngBounds([]);
      drawPrivacyZones(bounds);
      lastBoundsRef.current = bounds;
      safeMapFitBounds(map, bounds, { padding: [20, 20] });
    } else if (safeCurrentLocation) {
      safeMapSetView(map, [safeCurrentLocation.lat, safeCurrentLocation.lng], 15);
    } else {
      safeMapSetView(map, DEFAULT_MAP_CENTER_ARRAY, 12);
    }

    if (mapEvents && mapEvents.length > 0) {
      clusterEvents(mapEvents).forEach((cluster) => {
        const evt = cluster.dominant;
        const isPhoneUse = evt.type === 'phone_use';
        const color = isPhoneUse ? phoneUseColor(evt) : (EVENT_COLORS[evt.type] || '#6b7280');
        const isCluster = cluster.count > 1;
        const icon = window.L.divIcon({
          html: isCluster
            ? `<div style="position:relative;width:34px;height:34px;display:flex;align-items:center;justify-content:center"><div style="position:absolute;inset:0;border-radius:999px;background:${color};opacity:.18"></div><div style="width:28px;height:28px;background:${color};color:white;border:2px solid white;border-radius:50%;box-shadow:0 5px 16px rgba(15,23,42,0.28);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800">${cluster.count}</div></div>`
            : isPhoneUse
            ? phoneUseIconHtml(color)
            : eventMarkerHtml(evt, color),
          className: '',
          iconSize: isCluster ? [34, 34] : isPhoneUse ? [28, 28] : [30, 30],
          iconAnchor: isCluster ? [17, 17] : isPhoneUse ? [14, 14] : [15, 15],
        });
        window.L.marker([cluster.lat, cluster.lng], { icon })
          .bindPopup(isCluster ? clusterPopupHtml(cluster.events) : eventPopupHtml(evt, units))
          .on('click', () => {
            if (typeof onEventSelectRef.current === 'function') {
              onEventSelectRef.current(isCluster ? cluster.events[0] : evt, {
                clusterCount: cluster.count,
                events: cluster.events,
              });
            }
          })
          .addTo(layers);
      });
    }

    if (showRouteRisk && Array.isArray(routeRiskSegments)) {
      routeRiskSegments
        .filter((segment) => (
          segment.riskLevel !== 'low' &&
          validLatLngPoint(segment?.from) &&
          validLatLngPoint(segment?.to) &&
          !segmentTouchesPrivacy(segment)
        ))
        .forEach((segment) => {
          const fromLatLng = latLngForPoint(segment.from);
          const toLatLng = latLngForPoint(segment.to);
          if (!fromLatLng || !toLatLng) return;
          const color = segment.riskLevel === 'high' ? '#ef4444' : '#f97316';
          window.L.polyline(
            [fromLatLng, toLatLng],
            { color, weight: 5, opacity: 0.55, smoothFactor: 1.5 }
          )
            .bindPopup(buildRouteRiskSegmentPopupHtml(segment))
            .addTo(layers);
        });
    }

    if (showDangerZones && Array.isArray(dangerZones)) {
      dangerZones.filter((zone) => !isPrivatePoint(zone)).forEach((zone) => {
        const latLng = latLngForPoint(zone);
        if (!latLng) return;
        const color = RISK_COLORS[zone.riskLevel] || RISK_COLORS.low;
        window.L.circle(latLng, {
          radius: zone.radiusM || 100,
          color,
          fillColor: color,
          fillOpacity: 0.18,
          weight: 1.5,
          opacity: 0.6,
        })
          .bindPopup(buildDangerZonePopupHtml(zone))
          .addTo(layers);
      });
    }

    if (showCurrentLocation && safeCurrentLocation) {
      const locIcon = window.L.divIcon({
        html: '<div style="width:16px;height:16px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 0 6px rgba(59,130,246,0.2),0 2px 6px rgba(0,0,0,0.2)"></div>',
        className: '',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      window.L.marker([safeCurrentLocation.lat, safeCurrentLocation.lng], { icon: locIcon })
        .bindPopup('<b>You are here</b>')
        .addTo(layers);
    }
    if (safeParkedLocation) {
      const parkedIcon = window.L.divIcon({
        html: '<div style="width:22px;height:22px;background:#f97316;border:3px solid white;border-radius:50%;box-shadow:0 0 0 8px rgba(249,115,22,0.24),0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:white;font-size:12px;font-weight:700">P</div>',
        className: '',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      const parkedMarker = window.L.marker(
        [safeParkedLocation.lat, safeParkedLocation.lng],
        { icon: parkedIcon, draggable: parkedLocationDraggable === true }
      )
        .bindPopup(`<b>Parked here</b><br>${escapeHtml(safeParkedLocation.address || `${safeParkedLocation.lat.toFixed(5)}, ${safeParkedLocation.lng.toFixed(5)}`)}`)
        .addTo(layers);
      if (parkedLocationDraggable === true) {
        parkedMarker.on('dragend', (event) => {
          const next = event.target?.getLatLng?.();
          if (Number.isFinite(next?.lat) && Number.isFinite(next?.lng)) {
            onParkedLocationMoveRef.current?.({ lat: next.lat, lng: next.lng });
          }
        });
      }
    }
    } catch (error) {
      console.error('Trip map drawing failed', error);
      safeLeafletCall(() => layers.clearLayers());
      setMapFailed((failed) => failed || true);
    } finally {
      endDraw({ outcome: 'complete' });
    }
  }, [mapFailed, ready, routePoints, routes, events, showCurrentLocation, currentLocation, parkedLocation, parkedLocationDraggable, showPrivacyZones, showCorneringHeatmap, showDangerZones, dangerZones, showRouteRisk, routeRiskSegments, showSpeedLimits, speedLimitKnowledgeResults, smoothRoute, settings, privacyZonesRevision]);

  useEffect(() => {
    const safeCurrentLocation = validLatLngPoint(currentLocation);
    if (!leafletMapRef.current || !showCurrentLocation || !safeCurrentLocation) return;
    if (isPointInPrivacyZone(safeCurrentLocation, getPrivacyZones(settings))) return;
    const map = leafletMapRef.current;
    stopLeafletMap(map);
    safeMapPanTo(map, [safeCurrentLocation.lat, safeCurrentLocation.lng], 15);
  }, [currentLocation, showCurrentLocation, settings]);

  useEffect(() => {
    const safeParkedLocation = validLatLngPoint(parkedLocation);
    if (!leafletMapRef.current || !safeParkedLocation) return;
    if (isPointInPrivacyZone(safeParkedLocation, getPrivacyZones(settings))) return;
    const map = leafletMapRef.current;
    stopLeafletMap(map);
    safeMapSetView(map, [safeParkedLocation.lat, safeParkedLocation.lng], 17);
  }, [parkedLocation, settings]);

  if (mapFailed) {
    return (
      <OfflineRoutePreview
        routePoints={routePoints}
        routes={routes}
        events={events}
        height={height}
        className={className}
      />
    );
  }

  const handleFitRoute = () => {
    if (leafletMapRef.current && lastBoundsRef.current) {
      const map = leafletMapRef.current;
      stopLeafletMap(map);
      safeMapFitBounds(map, lastBoundsRef.current, { padding: [24, 24] });
    }
  };

  const handleCenterLive = () => {
    const safeCurrentLocation = validLatLngPoint(currentLocation);
    if (leafletMapRef.current && safeCurrentLocation) {
      const map = leafletMapRef.current;
      stopLeafletMap(map);
      safeMapSetView(map, [safeCurrentLocation.lat, safeCurrentLocation.lng], 16);
    }
  };

  return (
    <div className={`relative ${className}`} style={{ height, width: '100%' }}>
      <div
        ref={mapRef}
        className="map-container h-full w-full"
        style={{ height: '100%', width: '100%', zIndex: 0 }}
      />
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-2">
        <button
          type="button"
          onClick={handleFitRoute}
          disabled={!hasRoute}
          title="Fit route"
          aria-label="Fit route"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card shadow transition-colors hover:bg-secondary disabled:opacity-45"
        >
          <Maximize2 className="h-4 w-4 text-primary" />
        </button>
        <button
          type="button"
          onClick={() => setTileStyle((style) => (style === 'standard' ? 'detail' : 'standard'))}
          disabled={heightenedPrivacy}
          title={heightenedPrivacy ? 'Map tiles disabled by heightened privacy' : `Map style: ${TILE_STYLES[tileStyle].label}`}
          aria-label="Toggle map style"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card shadow transition-colors hover:bg-secondary disabled:opacity-45"
        >
          <Layers className="h-4 w-4 text-muted-foreground" />
        </button>
        {currentLocation && (
          <button
            type="button"
            onClick={handleCenterLive}
            title="Center current location"
            aria-label="Center current location"
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card shadow transition-colors hover:bg-secondary"
          >
            <Crosshair className="h-4 w-4 text-blue-500" />
          </button>
        )}
      </div>
      {selectedSegment && (
        <div className="absolute left-3 top-3 z-10 w-[min(340px,calc(100%-5.5rem))] rounded-2xl border border-border bg-card p-3 text-xs shadow">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-semibold">Segment inspector</div>
            <button
              type="button"
              onClick={() => setSelectedSegment(null)}
              className="rounded-lg bg-secondary px-2 py-1 text-[11px] font-semibold text-muted-foreground"
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="text-muted-foreground">Speed</div>
              <div className="font-semibold">{formatSpeed(selectedSegment.speedKmh, units)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Limit</div>
              <div className="font-semibold">{selectedSegment.speedLimitKmh ? formatSpeed(selectedSegment.speedLimitKmh, units) : '-'}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Length</div>
              <div className="font-semibold">{formatDistance(selectedSegment.distanceKm, units)}</div>
            </div>
          </div>
          {(selectedSegment.roadName || selectedSegment.overLimitKmh > 0) && (
            <div className="mt-2 rounded-xl bg-secondary/60 px-3 py-2 text-muted-foreground">
              {selectedSegment.roadName || 'Matched route segment'}
              {selectedSegment.overLimitKmh > 0 ? ` - ${formatSpeed(selectedSegment.overLimitKmh, units)} over` : ''}
            </div>
          )}
        </div>
      )}
      {showIncompleteRouteWarning && routeIncomplete && (
        <div className="absolute left-3 top-3 z-10 w-[min(360px,calc(100%-5.5rem))] rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 shadow dark:border-amber-800/50 dark:bg-amber-950 dark:text-amber-100">
          <div className="font-semibold">Incomplete GPS route</div>
          <div className="mt-1">
            Only {telemetry.pointCount} usable GPS point{telemetry.pointCount === 1 ? '' : 's'} were saved, so the map is showing markers instead of drawing a straight-line route.
          </div>
        </div>
      )}
      {showRouteSummary && showInsights && hasRoute && (
        <button
          type="button"
          onClick={() => setShowInsights(false)}
          className="absolute bottom-3 left-3 right-3 z-10 rounded-2xl border border-border bg-card p-3 text-left shadow sm:left-3 sm:right-auto sm:w-[min(360px,calc(100%-1.5rem))]"
          aria-label="Hide map trip summary"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Route diagnostics</div>
            <div className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {Array.isArray(diagnosticTrips)
                ? `${diagnosticTrips.length} route${diagnosticTrips.length === 1 ? '' : 's'}`
                : heightenedPrivacy ? 'Local overlays' : TILE_STYLES[tileStyle].label}
            </div>
          </div>
          {heightenedPrivacy && (
            <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
              Heightened privacy is hiding street-map tiles. Route overlays stay local on this device.
            </div>
          )}
          <div className="grid grid-cols-4 gap-2 text-center">
            <div>
              <div className="font-grotesk text-lg font-bold">{formatDistance(diagnostics.distanceKm, units)}</div>
              <div className="text-[10px] text-muted-foreground">Distance</div>
            </div>
            <div>
              <div className="font-grotesk text-lg font-bold">{formatSpeed(diagnostics.maxSpeedKmh, units)}</div>
              <div className="text-[10px] text-muted-foreground">Maximum speed</div>
            </div>
            <div>
              <div className="font-grotesk text-lg font-bold">{diagnosticEventCount}</div>
              <div className="text-[10px] text-muted-foreground">Events</div>
            </div>
            <div>
              <div className="font-grotesk text-lg font-bold">{stopCount}</div>
              <div className="text-[10px] text-muted-foreground">Stops</div>
            </div>
          </div>
          {diagnostics.durationSeconds > 0 && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
              <span>{formatDuration(diagnostics.durationSeconds)}</span>
              <span>{formatSpeed(diagnostics.avgSpeedKmh, units)} average including stops</span>
              <span>{recordedPointCount} GPS</span>
              {!overviewDiagnostics && recordedPointCount !== telemetry.pointCount && <span>{telemetry.pointCount} map pts</span>}
            </div>
          )}
          {phoneEventCount > 0 && (
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:bg-red-950/30 dark:text-red-300">
              <Smartphone className="h-3.5 w-3.5" />
              {phoneEventCount} foreground-activity marker{phoneEventCount === 1 ? '' : 's'} shown on the route
            </div>
          )}
        </button>
      )}
      {showRouteSummary && !showInsights && hasRoute && (
        <button
          type="button"
          onClick={() => setShowInsights(true)}
          className="absolute bottom-3 left-3 z-10 rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground shadow"
        >
          Route diagnostics
        </button>
      )}
      {heightenedPrivacy && (!hasRoute || !showInsights) && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 max-w-[min(20rem,calc(100%-1.5rem))] rounded-xl border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs font-semibold text-amber-950 shadow dark:border-amber-900/60 dark:bg-amber-950/90 dark:text-amber-100">
          Heightened privacy: street-map tiles are hidden; only local overlays are shown.
        </div>
      )}
    </div>
  );
}

function OfflineRoutePreview({
  routePoints = EMPTY_ROUTE_POINTS,
  routes = EMPTY_ROUTES,
  events = EMPTY_EVENTS,
  height = '350px',
  className = '',
}) {
  const settings = useTripMapSettings();
  usePrivacyZonesRevision();
  const showPrivacyCircles = settings.show_privacy_circles === true;
  const routeSets = Array.isArray(routes)
    ? routes
    : [{ id: 'selected', route_points: routePoints, color: '#3b82f6', selected: true }];
  const privacyDisplayReferences = routeSets.flatMap((route) => route.route_points || []);
  const maskedRoutes = routeSets.map((route) => ({
    ...route,
    route_points: injectTimestampGapMarkers(prepareMapRoutePoints(
      maskRoutePointsForPrivacy(route.route_points || [], settings),
      { maxPoints: route.selected ? 900 : 450 }
    )).map(validLatLngPoint).filter(Boolean),
  })).filter((route) => route.route_points.length > 1);
  const allPoints = maskedRoutes.flatMap((route) => route.route_points);
  const validPrivacyZones = (showPrivacyCircles ? getPrivacyZones(settings) : [])
    .map((zone) => getPrivacyZoneDisplayCircle(zone, undefined, privacyDisplayReferences))
    .map(validLatLngPoint)
    .filter(Boolean);
  const zoneBounds = validPrivacyZones.flatMap((zone) => {
    const latDelta = zone.radius_m / 111320;
    const lngDelta = zone.radius_m / (111320 * Math.max(0.2, Math.cos(zone.lat * Math.PI / 180)));
    return [
      { lat: zone.lat - latDelta, lng: zone.lng },
      { lat: zone.lat + latDelta, lng: zone.lng },
      { lat: zone.lat, lng: zone.lng - lngDelta },
      { lat: zone.lat, lng: zone.lng + lngDelta },
    ];
  });
  const referencePoints = [...allPoints, ...zoneBounds];
  const safeEvents = maskEventsForPrivacy(events, settings)
    .map(validLatLngPoint)
    .filter(Boolean);

  if (!referencePoints.length) {
    return (
      <div className={`map-container relative flex items-center justify-center bg-secondary/40 text-sm text-muted-foreground ${className}`} style={{ height }}>
        Offline route preview unavailable.
      </div>
    );
  }

  const minLat = Math.min(...referencePoints.map((point) => point.lat));
  const maxLat = Math.max(...referencePoints.map((point) => point.lat));
  const minLng = Math.min(...referencePoints.map((point) => point.lng));
  const maxLng = Math.max(...referencePoints.map((point) => point.lng));
  const scalePoint = (point) => {
    const x = ((point.lng - minLng) / Math.max(0.00001, maxLng - minLng)) * 92 + 4;
    const y = 96 - (((point.lat - minLat) / Math.max(0.00001, maxLat - minLat)) * 92 + 4);
    return { x, y };
  };
  const scale = (point) => {
    const { x, y } = scalePoint(point);
    return `${x},${y}`;
  };
  const zoneEllipse = (zone) => {
    const center = scalePoint(zone);
    const latDelta = zone.radius_m / 111320;
    const lngDelta = zone.radius_m / (111320 * Math.max(0.2, Math.cos(zone.lat * Math.PI / 180)));
    const latEdge = scalePoint({ lat: zone.lat + latDelta, lng: zone.lng });
    const lngEdge = scalePoint({ lat: zone.lat, lng: zone.lng + lngDelta });
    return {
      cx: center.x,
      cy: center.y,
      rx: Math.max(1, Math.abs(lngEdge.x - center.x)),
      ry: Math.max(1, Math.abs(latEdge.y - center.y)),
    };
  };

  return (
    <div className={`map-container relative bg-secondary/40 ${className}`} style={{ height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <rect width="100" height="100" fill="hsl(var(--secondary))" opacity="0.45" />
        {validPrivacyZones.map((zone) => {
          const ellipse = zoneEllipse(zone);
          return (
            <ellipse
              key={zone.id || `${zone.lat}-${zone.lng}`}
              cx={ellipse.cx}
              cy={ellipse.cy}
              rx={ellipse.rx}
              ry={ellipse.ry}
              fill="#3b82f6"
              fillOpacity="0.08"
              stroke="#2563eb"
              strokeDasharray="3 2"
              strokeWidth="1.2"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {maskedRoutes.filter((route) => route.route_points.length >= MIN_POLYLINE_ROUTE_POINTS).map((route) => (
          <polyline
            key={route.id || route.label || route.color}
            points={route.route_points.map(scale).join(' ')}
            fill="none"
            stroke={route.color || (route.selected ? '#3b82f6' : '#64748b')}
            strokeWidth={route.selected ? 1.8 : 1.1}
            opacity={route.opacity ?? 0.9}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {safeEvents.slice(0, 40).map((event, index) => {
          const [cx, cy] = scale(event).split(',').map(Number);
          if (event.type === 'phone_use') {
            return (
              <g key={`${event.timestamp}-${index}`}>
                <circle cx={cx} cy={cy} r="3.2" fill={phoneUseColor(event)} stroke="white" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
                <rect x={cx - 0.9} y={cy - 1.7} width="1.8" height="3.4" rx="0.35" fill="none" stroke="white" strokeWidth="0.55" vectorEffect="non-scaling-stroke" />
              </g>
            );
          }
          return <circle key={`${event.timestamp}-${index}`} cx={cx} cy={cy} r="1.4" fill={EVENT_COLORS[event.type] || '#ef4444'} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-xl bg-background/85 px-3 py-2 text-xs font-medium text-muted-foreground shadow-sm">
        Offline route preview - map tiles unavailable
      </div>
    </div>
  );
}
