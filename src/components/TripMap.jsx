import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Crosshair, Layers, Maximize2 } from 'lucide-react';
import { escapeHtml } from '@/lib/htmlUtils';
import { buildPlaybackTimeline, prepareMapRoutePoints } from '@/lib/mapPlaybackInsights';
import {
  buildDangerZonePopupHtml,
  buildRouteRiskSegmentPopupHtml,
  buildSpeedSegmentPopupHtml,
  routeLabelPopupPrefix,
  titleCase,
} from '@/lib/mapPopupHtml';
import { buildSpeedSegments } from '@/lib/tripInsights';
import { calculateBearing, formatDistance, formatDuration, headingDiff, haversineDistance } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { getPrivacyZones, isPointInPrivacyZone, maskEventsForPrivacy, maskRoutePointsForPrivacy } from '@/lib/privacyZones';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TORONTO_CENTER = [43.6532, -79.3832];
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

const privacyZonePopupHtml = (zone) => (
  `<b>Privacy zone</b><br>${escapeHtml(zone.label || 'Private place')}<br>${Math.round(Number(zone.radius_m) || 150)} m radius<br>Route coordinates inside this circle are hidden.`
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

const routeTelemetry = (points = []) => {
  const clean = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (!clean.length) {
    return { distanceKm: 0, durationSeconds: 0, avgSpeedKmh: 0, maxSpeedKmh: 0, pointCount: 0 };
  }

  let distanceKm = 0;
  for (let i = 1; i < clean.length; i++) {
    distanceKm += haversineDistance(clean[i - 1].lat, clean[i - 1].lng, clean[i].lat, clean[i].lng);
  }

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
    .filter((event) => Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lng)))
    .forEach((event) => {
      const key = `${Math.round(Number(event.lat) * 1200)},${Math.round(Number(event.lng) * 1200)}`;
      const group = groups.get(key) || { latSum: 0, lngSum: 0, events: [] };
      group.latSum += Number(event.lat);
      group.lngSum += Number(event.lng);
      group.events.push(event);
      groups.set(key, group);
    });

  return [...groups.values()].map((group) => {
    const dominant = group.events.reduce((best, event) => (
      group.events.filter((item) => item.type === event.type).length >
      group.events.filter((item) => item.type === best.type).length ? event : best
    ), group.events[0]);
    return {
      lat: group.latSum / group.events.length,
      lng: group.lngSum / group.events.length,
      events: group.events,
      count: group.events.length,
      dominant,
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

const eventPopupHtml = (event) => {
  const label = titleCase(event.type || 'event');
  const speedLimitValue = event.speed_limit_kmh ?? event.inferred_zone_kmh;
  const speedLimitSource = event.speed_limit_source || event.source || null;
  const speedLimitLabel = Number.isFinite(Number(speedLimitValue))
    ? `${Math.round(Number(speedLimitValue))} km/h${speedLimitSource === 'inferred' ? ' inferred estimate' : ''}`
    : null;
  const rows = [
    ['Severity', titleCase(event.severity || event.confidence_level || 'medium')],
    ['Time', formatEventTime(event.timestamp)],
    ['Speed', Number.isFinite(Number(event.speed_kmh)) ? `${Math.round(Number(event.speed_kmh))} km/h` : null],
    ['Limit', speedLimitLabel],
    ['Over by', Number.isFinite(Number(event.speed_kmh)) && Number.isFinite(Number(speedLimitValue))
      ? `${Math.max(0, Math.round(Number(event.speed_kmh) - Number(speedLimitValue)))} km/h`
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

function loadLeaflet() {
  if (typeof window !== 'undefined' && !window.L) window.L = L;
  if (leafletLoaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    if (window.L) {
      leafletLoaded = true;
      resolve();
      return;
    }

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => {
      leafletLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error('Leaflet could not be loaded'));
    document.head.appendChild(script);
  });

  return loadPromise;
}

export default function TripMap(props) {
  const resetKey = Array.isArray(props.routes)
    ? props.routes.map((route) => `${route.id || route.label || 'route'}:${route.selected ? '1' : '0'}:${route.route_points?.length || 0}`).join('|')
    : `${props.routePoints?.length || 0}:${props.currentLocation?.timestamp || ''}`;

  return (
    <SectionErrorBoundary
      context="trip_map"
      title="Map unavailable"
      message="Something went wrong while drawing this route. Reload to try again."
      resetKey={resetKey}
    >
      <TripMapContent {...props} />
    </SectionErrorBoundary>
  );
}

function TripMapContent({
  routePoints = [],
  routes = null,
  events = [],
  showCurrentLocation = false,
  currentLocation = null,
  parkedLocation = null,
  showCorneringHeatmap = false,
  showDangerZones = false,
  dangerZones = [],
  showRouteRisk = false,
  routeRiskSegments = [],
  showSpeedLimits = false,
  rawPointCount = null,
  smoothRoute = true,
  height = '350px',
  className = '',
}) {
  const mapRef = useRef(null);
  const leafletMapRef = useRef(null);
  const layersRef = useRef(null);
  const tileLayerRef = useRef(null);
  const lastBoundsRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [tileStyle, setTileStyle] = useState('standard');
  const [tileErrorCount, setTileErrorCount] = useState(0);
  const [showInsights, setShowInsights] = useState(true);
  const [selectedSegment, setSelectedSegment] = useState(null);

  const selectedRoute = useMemo(() => {
    const routeSets = Array.isArray(routes)
      ? routes
      : [{ id: 'selected', route_points: routePoints, selected: true }];
    return routeSets.find((route) => route.selected) || routeSets[0] || {};
  }, [routePoints, routes]);
  const selectedRoutePoints = useMemo(
    () => prepareMapRoutePoints(selectedRoute.route_points || [], { maxPoints: null, smooth: smoothRoute }),
    [selectedRoute, smoothRoute]
  );
  const telemetry = useMemo(() => routeTelemetry(selectedRoutePoints), [selectedRoutePoints]);
  const recordedPointCount = Number(
    rawPointCount ?? selectedRoute.rawPointCount ?? selectedRoute.route_points_raw_count
  ) || selectedRoutePoints.length;
  const stopCount = useMemo(() => detectStops(selectedRoutePoints).length, [selectedRoutePoints]);
  const hasRoute = telemetry.pointCount > 1;

  useEffect(() => {
    setSelectedSegment(null);
  }, [selectedRoutePoints]);

  useEffect(() => {
    let cancelled = false;

    loadLeaflet().then(() => {
      if (cancelled || !mapRef.current || leafletMapRef.current) return;

      const map = window.L.map(mapRef.current, {
        zoomControl: true,
        attributionControl: true,
      });

      leafletMapRef.current = map;

      const tileConfig = TILE_STYLES.standard;
      tileLayerRef.current = window.L.tileLayer(tileConfig.url, {
        attribution: tileConfig.attribution,
        maxZoom: tileConfig.maxZoom,
      })
        .on('tileerror', () => setTileErrorCount((count) => count + 1))
        .addTo(map);

      layersRef.current = window.L.layerGroup().addTo(map);
      map.setView(TORONTO_CENTER, 12);
      setReady(true);
      setTimeout(() => map.invalidateSize(), 0);
    }).catch(() => {
      if (!cancelled) setMapFailed(true);
    });

    return () => {
      cancelled = true;
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
        layersRef.current = null;
        tileLayerRef.current = null;
        lastBoundsRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const map = leafletMapRef.current;
    if (!ready || !map || !window.L || !tileLayerRef.current) return;

    const tileConfig = TILE_STYLES[tileStyle] || TILE_STYLES.standard;
    setTileErrorCount(0);
    map.removeLayer(tileLayerRef.current);
    tileLayerRef.current = window.L.tileLayer(tileConfig.url, {
      attribution: tileConfig.attribution,
      maxZoom: tileConfig.maxZoom,
    })
      .on('tileerror', () => setTileErrorCount((count) => count + 1))
      .addTo(map);
  }, [ready, tileStyle]);

  useEffect(() => {
    if (tileErrorCount >= 4) setMapFailed(true);
  }, [tileErrorCount]);

  useEffect(() => {
    const map = leafletMapRef.current;
    const layers = layersRef.current;
    if (!ready || !map || !layers || !window.L) return;

    layers.clearLayers();

    const privacySettings = localSettings.get();
    const routeSets = Array.isArray(routes)
      ? routes
      : [{ id: 'selected', route_points: routePoints, color: '#3b82f6', selected: true }];
    const visiblePrivacyZones = getPrivacyZones(privacySettings);
    const validRoutes = routeSets
      .map((route) => {
        const maskedPoints = maskRoutePointsForPrivacy(route.route_points || [], privacySettings);
        return {
          ...route,
          color: route.color || (route.selected ? '#3b82f6' : '#64748b'),
          opacity: route.opacity ?? (route.selected ? 0.9 : 0.45),
          route_points: prepareMapRoutePoints(maskedPoints, {
            maxPoints: route.selected ? 900 : 450,
            smooth: smoothRoute,
          }),
        };
      })
      .filter((route) => route.route_points.length > 1);
    const mapEvents = maskEventsForPrivacy(events || [], privacySettings);
    const isPrivatePoint = (point) => Boolean(isPointInPrivacyZone(point, visiblePrivacyZones));
    const segmentTouchesPrivacy = (segment) => {
      const midpoint = segment?.from && segment?.to
        ? {
          lat: (Number(segment.from.lat) + Number(segment.to.lat)) / 2,
          lng: (Number(segment.from.lng) + Number(segment.to.lng)) / 2,
        }
        : null;
      return [segment?.from, segment?.to, midpoint].some((point) => point && isPrivatePoint(point));
    };
    const safeCurrentLocation = currentLocation && !isPrivatePoint(currentLocation) ? currentLocation : null;
    const safeParkedLocation = parkedLocation && !isPrivatePoint(parkedLocation) ? parkedLocation : null;
    const drawPrivacyZones = (bounds = null) => {
      visiblePrivacyZones.forEach((zone) => {
        const radius = Math.max(50, Math.min(1000, Number(zone.radius_m) || 150));
        const circle = window.L.circle([Number(zone.lat), Number(zone.lng)], {
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

      validRoutes.forEach((route) => {
        const latLngs = route.route_points.map(p => [p.lat, p.lng]);
        latLngs.forEach((latLng) => bounds.extend(latLng));

        const timeline = route.selected || !Array.isArray(routes)
          ? buildPlaybackTimeline(route.route_points, mapEvents)
          : null;
        const speedSegments = timeline?.segments?.length
          ? timeline.segments
          : route.selected || !Array.isArray(routes)
            ? buildSpeedSegments(route.route_points)
            : [];

        if (showCorneringHeatmap && route.selected && route.route_points.length > 2) {
          window.L.polyline(latLngs, {
            color: '#0f172a',
            weight: 7,
            opacity: 0.16,
            smoothFactor: 1.5,
            lineCap: 'round',
            lineJoin: 'round',
          }).addTo(layers);

          for (let i = 1; i < route.route_points.length - 1; i++) {
            const prev = route.route_points[i - 1];
            const curr = route.route_points[i];
            const next = route.route_points[i + 1];
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
          window.L.polyline(latLngs, {
            color: '#0f172a',
            weight: route.selected ? 9 : 6,
            opacity: route.selected ? 0.18 : 0.10,
            smoothFactor: 1.5,
            lineCap: 'round',
            lineJoin: 'round',
          }).addTo(layers);
          speedSegments.forEach((segment) => {
            const from = segment.from;
            const to = segment.to;
            const color = segment.color || segment.band?.color;
            const label = segment.band?.label || segment.label || 'Segment';
            const speedKmh = segment.speedKmh ?? segment.speed_kmh ?? 0;
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
                speedLimitKmh: segment.speedLimitKmh,
              }))
              .on('click', () => {
                if (segment.band) setSelectedSegment(segment);
              })
              .addTo(layers);
          });
          if (showSpeedLimits && route.selected) {
            for (let i = 1; i < route.route_points.length; i++) {
              const prev = route.route_points[i - 1];
              const curr = route.route_points[i];
              const limit = Number(curr.speed_limit_kmh ?? prev.speed_limit_kmh);
              if (!Number.isFinite(limit) || limit <= 0) continue;
              const speed = Number(curr.speed_kmh ?? prev.speed_kmh) || 0;
              const overBy = speed - limit;
              const color = overBy > 10 ? '#ef4444' : overBy > 0 ? '#f97316' : '#22c55e';
              const source = curr.speed_limit_source || prev.speed_limit_source || 'openstreetmap';
              const roadName = curr.speed_limit_road_name || prev.speed_limit_road_name || 'matched road';
              window.L.polyline(
                [[prev.lat, prev.lng], [curr.lat, curr.lng]],
                {
                  color,
                  weight: route.selected ? 8 : 5,
                  opacity: 0.48,
                  smoothFactor: 1.5,
                  lineCap: 'round',
                  lineJoin: 'round',
                }
              )
                .bindPopup(`${routeLabelPopupPrefix(route.label)}${escapeHtml(roadName)}<br>Limit: ${escapeHtml(Math.round(limit))} km/h (${escapeHtml(source)})<br>Speed: ${escapeHtml(Math.round(speed))} km/h`)
                .addTo(layers);
            }
          }
        } else {
          window.L.polyline(latLngs, {
            color: route.color,
            weight: route.selected ? 6 : 4,
            opacity: route.opacity,
            smoothFactor: 1.5,
            lineCap: 'round',
            lineJoin: 'round',
          })
            .bindPopup(route.label ? `<b>${escapeHtml(route.label)}</b>` : 'Trip route')
            .addTo(layers);
        }
      });

      drawPrivacyZones(bounds);

      lastBoundsRef.current = bounds;
      map.fitBounds(bounds, { padding: [20, 20] });

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
    } else if (visiblePrivacyZones.length > 0) {
      const bounds = window.L.latLngBounds([]);
      drawPrivacyZones(bounds);
      lastBoundsRef.current = bounds;
      map.fitBounds(bounds, { padding: [20, 20] });
    } else if (safeCurrentLocation) {
      map.setView([safeCurrentLocation.lat, safeCurrentLocation.lng], 15);
    } else {
      map.setView(TORONTO_CENTER, 12);
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
          .bindPopup(isCluster ? clusterPopupHtml(cluster.events) : eventPopupHtml(evt))
          .addTo(layers);
      });
    }

    if (showRouteRisk && Array.isArray(routeRiskSegments)) {
      routeRiskSegments
        .filter((segment) => segment.riskLevel !== 'low' && !segmentTouchesPrivacy(segment))
        .forEach((segment) => {
          const color = segment.riskLevel === 'high' ? '#ef4444' : '#f97316';
          window.L.polyline(
            [[segment.from.lat, segment.from.lng], [segment.to.lat, segment.to.lng]],
            { color, weight: 5, opacity: 0.55, smoothFactor: 1.5 }
          )
            .bindPopup(buildRouteRiskSegmentPopupHtml(segment))
            .addTo(layers);
        });
    }

    if (showDangerZones && Array.isArray(dangerZones)) {
      dangerZones.filter((zone) => !isPrivatePoint(zone)).forEach((zone) => {
        if (!Number.isFinite(Number(zone.lat)) || !Number.isFinite(Number(zone.lng))) return;
        const color = RISK_COLORS[zone.riskLevel] || RISK_COLORS.low;
        window.L.circle([zone.lat, zone.lng], {
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
    if (safeParkedLocation?.lat && safeParkedLocation?.lng) {
      const parkedIcon = window.L.divIcon({
        html: '<div style="width:22px;height:22px;background:#f97316;border:3px solid white;border-radius:50%;box-shadow:0 0 0 8px rgba(249,115,22,0.24),0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:white;font-size:12px;font-weight:700">P</div>',
        className: '',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      window.L.marker([safeParkedLocation.lat, safeParkedLocation.lng], { icon: parkedIcon })
        .bindPopup(`<b>Parked here</b><br>${escapeHtml(safeParkedLocation.address || `${safeParkedLocation.lat.toFixed(5)}, ${safeParkedLocation.lng.toFixed(5)}`)}`)
        .addTo(layers);
    }
  }, [ready, routePoints, routes, events, showCurrentLocation, currentLocation, parkedLocation, showCorneringHeatmap, showDangerZones, dangerZones, showRouteRisk, routeRiskSegments, showSpeedLimits, smoothRoute]);

  useEffect(() => {
    if (!leafletMapRef.current || !showCurrentLocation || !currentLocation) return;
    if (isPointInPrivacyZone(currentLocation, getPrivacyZones(localSettings.get()))) return;
    leafletMapRef.current.panTo([currentLocation.lat, currentLocation.lng]);
  }, [currentLocation, showCurrentLocation]);

  useEffect(() => {
    if (!leafletMapRef.current || !parkedLocation?.lat || !parkedLocation?.lng) return;
    if (isPointInPrivacyZone(parkedLocation, getPrivacyZones(localSettings.get()))) return;
    leafletMapRef.current.setView([parkedLocation.lat, parkedLocation.lng], 17);
  }, [parkedLocation]);

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
      leafletMapRef.current.fitBounds(lastBoundsRef.current, { padding: [24, 24] });
    }
  };

  const handleCenterLive = () => {
    if (leafletMapRef.current && currentLocation) {
      leafletMapRef.current.setView([currentLocation.lat, currentLocation.lng], 16);
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
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card/95 shadow backdrop-blur transition-colors hover:bg-card disabled:opacity-45"
        >
          <Maximize2 className="h-4 w-4 text-primary" />
        </button>
        <button
          type="button"
          onClick={() => setTileStyle((style) => (style === 'standard' ? 'detail' : 'standard'))}
          title={`Map style: ${TILE_STYLES[tileStyle].label}`}
          aria-label="Toggle map style"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card/95 shadow backdrop-blur transition-colors hover:bg-card"
        >
          <Layers className="h-4 w-4 text-muted-foreground" />
        </button>
        {currentLocation && (
          <button
            type="button"
            onClick={handleCenterLive}
            title="Center current location"
            aria-label="Center current location"
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card/95 shadow backdrop-blur transition-colors hover:bg-card"
          >
            <Crosshair className="h-4 w-4 text-blue-500" />
          </button>
        )}
      </div>
      {selectedSegment && (
        <div className="absolute left-3 top-3 z-10 w-[min(340px,calc(100%-5.5rem))] rounded-2xl border border-border bg-card/95 p-3 text-xs shadow backdrop-blur">
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
              <div className="font-semibold">{Math.round(selectedSegment.speedKmh)} km/h</div>
            </div>
            <div>
              <div className="text-muted-foreground">Limit</div>
              <div className="font-semibold">{selectedSegment.speedLimitKmh ? `${Math.round(selectedSegment.speedLimitKmh)} km/h` : '-'}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Length</div>
              <div className="font-semibold">{formatDistance(selectedSegment.distanceKm)}</div>
            </div>
          </div>
          {(selectedSegment.roadName || selectedSegment.overLimitKmh > 0) && (
            <div className="mt-2 rounded-xl bg-secondary/60 px-3 py-2 text-muted-foreground">
              {selectedSegment.roadName || 'Matched route segment'}
              {selectedSegment.overLimitKmh > 0 ? ` - ${Math.round(selectedSegment.overLimitKmh)} km/h over` : ''}
            </div>
          )}
        </div>
      )}
      {showInsights && hasRoute && (
        <button
          type="button"
          onClick={() => setShowInsights(false)}
          className="absolute bottom-3 left-3 right-3 z-10 rounded-2xl border border-border bg-card/95 p-3 text-left shadow backdrop-blur sm:left-3 sm:right-auto sm:w-[min(360px,calc(100%-1.5rem))]"
          aria-label="Hide map trip summary"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">Route diagnostics</div>
            <div className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{TILE_STYLES[tileStyle].label}</div>
          </div>
          <div className="grid grid-cols-4 gap-2 text-center">
            <div>
              <div className="font-grotesk text-lg font-bold">{formatDistance(telemetry.distanceKm)}</div>
              <div className="text-[10px] text-muted-foreground">Distance</div>
            </div>
            <div>
              <div className="font-grotesk text-lg font-bold">{telemetry.maxSpeedKmh}</div>
              <div className="text-[10px] text-muted-foreground">Max km/h</div>
            </div>
            <div>
              <div className="font-grotesk text-lg font-bold">{events.length}</div>
              <div className="text-[10px] text-muted-foreground">Events</div>
            </div>
            <div>
              <div className="font-grotesk text-lg font-bold">{stopCount}</div>
              <div className="text-[10px] text-muted-foreground">Stops</div>
            </div>
          </div>
          {telemetry.durationSeconds > 0 && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
              <span>{formatDuration(telemetry.durationSeconds)}</span>
              <span>{telemetry.avgSpeedKmh} km/h avg</span>
              <span>{recordedPointCount} GPS</span>
              {recordedPointCount !== telemetry.pointCount && <span>{telemetry.pointCount} map pts</span>}
            </div>
          )}
        </button>
      )}
      {!showInsights && hasRoute && (
        <button
          type="button"
          onClick={() => setShowInsights(true)}
          className="absolute bottom-3 left-3 z-10 rounded-xl border border-border bg-card/95 px-3 py-2 text-xs font-semibold text-muted-foreground shadow backdrop-blur"
        >
          Route diagnostics
        </button>
      )}
    </div>
  );
}

function OfflineRoutePreview({ routePoints = [], routes = null, events = [], height = '350px', className = '' }) {
  const settings = localSettings.get();
  const routeSets = Array.isArray(routes)
    ? routes
    : [{ id: 'selected', route_points: routePoints, color: '#3b82f6', selected: true }];
  const maskedRoutes = routeSets.map((route) => ({
    ...route,
    route_points: prepareMapRoutePoints(
      maskRoutePointsForPrivacy(route.route_points || [], settings),
      { maxPoints: route.selected ? 900 : 450 }
    ),
  })).filter((route) => route.route_points.length > 1);
  const allPoints = maskedRoutes.flatMap((route) => route.route_points);
  const visiblePrivacyZones = getPrivacyZones(settings);
  const validPrivacyZones = visiblePrivacyZones
    .map((zone) => ({
      ...zone,
      lat: Number(zone.lat),
      lng: Number(zone.lng),
      radius_m: Math.max(50, Math.min(1000, Number(zone.radius_m) || 150)),
    }))
    .filter((zone) => Number.isFinite(zone.lat) && Number.isFinite(zone.lng));
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
    .filter((event) => Number.isFinite(event.lat) && Number.isFinite(event.lng));

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
        {maskedRoutes.map((route) => (
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
          return <circle key={`${event.timestamp}-${index}`} cx={cx} cy={cy} r="1.4" fill={EVENT_COLORS[event.type] || '#ef4444'} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-xl bg-background/85 px-3 py-2 text-xs font-medium text-muted-foreground shadow-sm">
        Offline route preview - map tiles unavailable
      </div>
    </div>
  );
}
