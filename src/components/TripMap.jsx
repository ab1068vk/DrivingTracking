import { useEffect, useRef, useState } from 'react';
import { buildSpeedSegments } from '@/lib/tripInsights';
import { calculateBearing, headingDiff } from '@/lib/tripEngine';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TORONTO_CENTER = [43.6532, -79.3832];

const EVENT_COLORS = {
  harsh_brake: '#ef4444',
  rapid_acceleration: '#f59e0b',
  sharp_turn: '#3b82f6',
  speeding: '#f97316',
  idle: '#6b7280',
  lane_change: '#0ea5e9',
  aggressive_overtake: '#f97316',
  near_miss: '#dc2626',
  phone_use: '#dc2626',
};

const EVENT_LABELS = {
  harsh_brake: '!',
  rapid_acceleration: '+',
  sharp_turn: '<',
  speeding: '>',
  idle: 'P',
  lane_change: '<>',
  aggressive_overtake: '>>',
  near_miss: '!',
  phone_use: 'P',
};

const RISK_COLORS = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
};

const titleCase = (value) => String(value || '')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

const phoneUseColor = (event) => {
  const level = event.confidence_level || event.severity || 'medium';
  if (level === 'high') return '#dc2626';
  if (level === 'medium') return '#ea580c';
  return '#f97316';
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const phoneUseIconHtml = (color) => `
  <div style="width:28px;height:28px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="7" y="2" width="10" height="20" rx="2"></rect>
      <path d="M11 18h2"></path>
    </svg>
  </div>
`;

let leafletLoaded = false;
let loadPromise = null;

function loadLeaflet() {
  if (leafletLoaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve) => {
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
    document.head.appendChild(script);
  });

  return loadPromise;
}

export default function TripMap({
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
  height = '350px',
  className = '',
}) {
  const mapRef = useRef(null);
  const leafletMapRef = useRef(null);
  const layersRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    loadLeaflet().then(() => {
      if (cancelled || !mapRef.current || leafletMapRef.current) return;

      const map = window.L.map(mapRef.current, {
        zoomControl: true,
        attributionControl: true,
      });

      leafletMapRef.current = map;

      window.L.tileLayer(TILE_URL, {
        attribution: TILE_ATTRIBUTION,
        maxZoom: 19,
      }).addTo(map);

      layersRef.current = window.L.layerGroup().addTo(map);
      map.setView(TORONTO_CENTER, 12);
      setReady(true);
      setTimeout(() => map.invalidateSize(), 0);
    });

    return () => {
      cancelled = true;
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
        layersRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const map = leafletMapRef.current;
    const layers = layersRef.current;
    if (!ready || !map || !layers || !window.L) return;

    layers.clearLayers();

    const routeSets = Array.isArray(routes)
      ? routes
      : [{ id: 'selected', route_points: routePoints, color: '#3b82f6', selected: true }];
    const validRoutes = routeSets
      .map((route) => ({
        ...route,
        color: route.color || (route.selected ? '#3b82f6' : '#64748b'),
        opacity: route.opacity ?? (route.selected ? 0.9 : 0.45),
        route_points: (route.route_points || []).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)),
      }))
      .filter((route) => route.route_points.length > 1);

    if (validRoutes.length > 0) {
      const bounds = window.L.latLngBounds([]);

      validRoutes.forEach((route) => {
        const latLngs = route.route_points.map(p => [p.lat, p.lng]);
        latLngs.forEach((latLng) => bounds.extend(latLng));

        const speedSegments = route.selected || !Array.isArray(routes)
          ? buildSpeedSegments(route.route_points)
          : [];

        if (showCorneringHeatmap && route.selected && route.route_points.length > 2) {
          for (let i = 1; i < route.route_points.length - 1; i++) {
            const prev = route.route_points[i - 1];
            const curr = route.route_points[i];
            const next = route.route_points[i + 1];
            const dtPrev = (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000;
            const dtNext = (new Date(next.timestamp).getTime() - new Date(curr.timestamp).getTime()) / 1000;
            if (dtPrev <= 0 || dtNext <= 0 || dtPrev > 15 || dtNext > 15) continue;
            const h1 = calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
            const h2 = calculateBearing(curr.lat, curr.lng, next.lat, next.lng);
            const speed = Number(curr.speed_kmh) || Number(next.speed_kmh) || 0;
            const lateralG = ((speed / 3.6) * ((headingDiff(h1, h2) * Math.PI / 180) / Math.max(1.5, (dtPrev + dtNext) / 2))) / 9.81;
            const color = lateralG >= 0.4 ? '#ef4444' : lateralG >= 0.2 ? '#f59e0b' : '#22c55e';
            window.L.polyline(
              [[curr.lat, curr.lng], [next.lat, next.lng]],
              {
                color,
                weight: route.selected ? 6 : 3,
                opacity: route.opacity,
                smoothFactor: 1.5,
              }
            )
              .bindPopup(`${route.label ? `<b>${route.label}</b><br>` : ''}Cornering: ${lateralG.toFixed(2)}g`)
              .addTo(layers);
          }
        } else if (speedSegments.length > 0) {
          speedSegments.forEach((segment) => {
            window.L.polyline(
              [[segment.from.lat, segment.from.lng], [segment.to.lat, segment.to.lng]],
              {
                color: segment.color,
                weight: route.selected ? 5 : 3,
                opacity: route.opacity,
                smoothFactor: 1.5,
              }
            )
              .bindPopup(`${route.label ? `<b>${route.label}</b><br>` : ''}${segment.label}: ${Math.round(segment.speed_kmh)} km/h`)
              .addTo(layers);
          });
        } else {
          window.L.polyline(latLngs, {
            color: route.color,
            weight: route.selected ? 5 : 3,
            opacity: route.opacity,
            smoothFactor: 1.5,
          })
            .bindPopup(route.label ? `<b>${route.label}</b>` : 'Trip route')
            .addTo(layers);
        }
      });

      map.fitBounds(bounds, { padding: [20, 20] });

      const primaryRoute = validRoutes.find((route) => route.selected) || validRoutes[0];
      const latLngs = primaryRoute.route_points.map(p => [p.lat, p.lng]);

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
    } else if (currentLocation) {
      map.setView([currentLocation.lat, currentLocation.lng], 15);
    } else {
      map.setView(TORONTO_CENTER, 12);
    }

    if (events && events.length > 0) {
      events.forEach(evt => {
        if (!evt.lat || !evt.lng) return;
        const isPhoneUse = evt.type === 'phone_use';
        const color = isPhoneUse ? phoneUseColor(evt) : (EVENT_COLORS[evt.type] || '#6b7280');
        const icon = window.L.divIcon({
          html: isPhoneUse
            ? phoneUseIconHtml(color)
            : `<div style="width:20px;height:20px;background:${color};color:white;border:2px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${EVENT_LABELS[evt.type] || '!'}</div>`,
          className: '',
          iconSize: isPhoneUse ? [28, 28] : [20, 20],
          iconAnchor: isPhoneUse ? [14, 14] : [10, 10],
        });
        const phonePopup = `<b>Possible Phone Use</b><br>Duration: ${Math.round(evt.durationS ?? evt.duration_seconds ?? 0)}s - Speed: ${Math.round(evt.speed_kmh || 0)} km/h<br>Confidence: ${escapeHtml(evt.confidence_level || 'medium')}<br>Signals: ${escapeHtml((evt.signals_triggered || []).join(', ') || 'combined GPS signals')}`;
        window.L.marker([evt.lat, evt.lng], { icon })
          .bindPopup(isPhoneUse ? phonePopup : `<b>${evt.type?.replace('_', ' ')}</b><br>Severity: ${evt.severity}`)
          .addTo(layers);
      });
    }

    if (showRouteRisk && Array.isArray(routeRiskSegments)) {
      routeRiskSegments
        .filter((segment) => segment.riskLevel !== 'low')
        .forEach((segment) => {
          const color = segment.riskLevel === 'high' ? '#ef4444' : '#f97316';
          const perPass = segment.tripCount ? segment.totalEvents / segment.tripCount : 0;
          window.L.polyline(
            [[segment.from.lat, segment.from.lng], [segment.to.lat, segment.to.lng]],
            { color, weight: 5, opacity: 0.55, smoothFactor: 1.5 }
          )
            .bindPopup(`<b>${titleCase(segment.riskLevel)} risk segment</b><br>Seen across ${segment.tripCount} trips<br>Avg ${perPass.toFixed(1)} events per pass<br>Most common: ${titleCase(segment.dominantEventType || 'none')}`)
            .addTo(layers);
        });
    }

    if (showDangerZones && Array.isArray(dangerZones)) {
      dangerZones.forEach((zone) => {
        if (!Number.isFinite(Number(zone.lat)) || !Number.isFinite(Number(zone.lng))) return;
        const color = RISK_COLORS[zone.riskLevel] || RISK_COLORS.low;
        const lastSeen = zone.lastSeen ? new Date(zone.lastSeen).toLocaleDateString() : 'Unknown';
        window.L.circle([zone.lat, zone.lng], {
          radius: zone.radiusM || 100,
          color,
          fillColor: color,
          fillOpacity: 0.18,
          weight: 1.5,
          opacity: 0.6,
        })
          .bindPopup(`<b>${titleCase(zone.riskLevel)} danger zone</b><br>${zone.eventCount || 0} events<br>${titleCase(zone.dominantType || 'risk event')}<br>Last seen: ${lastSeen}`)
          .addTo(layers);
      });
    }

    if (showCurrentLocation && currentLocation) {
      const locIcon = window.L.divIcon({
        html: '<div style="width:16px;height:16px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 0 6px rgba(59,130,246,0.2),0 2px 6px rgba(0,0,0,0.2)"></div>',
        className: '',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      window.L.marker([currentLocation.lat, currentLocation.lng], { icon: locIcon })
        .bindPopup('<b>You are here</b>')
        .addTo(layers);
    }
    if (parkedLocation?.lat && parkedLocation?.lng) {
      const parkedIcon = window.L.divIcon({
        html: '<div style="width:22px;height:22px;background:#f97316;border:3px solid white;border-radius:50%;box-shadow:0 0 0 8px rgba(249,115,22,0.24),0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:white;font-size:12px;font-weight:700">P</div>',
        className: '',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      window.L.marker([parkedLocation.lat, parkedLocation.lng], { icon: parkedIcon })
        .bindPopup(`<b>Parked here</b><br>${parkedLocation.address || `${parkedLocation.lat.toFixed(5)}, ${parkedLocation.lng.toFixed(5)}`}`)
        .addTo(layers);
    }
  }, [ready, routePoints, routes, events, showCurrentLocation, currentLocation, parkedLocation, showCorneringHeatmap, showDangerZones, dangerZones, showRouteRisk, routeRiskSegments]);

  useEffect(() => {
    if (!leafletMapRef.current || !showCurrentLocation || !currentLocation) return;
    leafletMapRef.current.panTo([currentLocation.lat, currentLocation.lng]);
  }, [currentLocation, showCurrentLocation]);

  useEffect(() => {
    if (!leafletMapRef.current || !parkedLocation?.lat || !parkedLocation?.lng) return;
    leafletMapRef.current.setView([parkedLocation.lat, parkedLocation.lng], 17);
  }, [parkedLocation]);

  return (
    <div
      ref={mapRef}
      className={`map-container ${className}`}
      style={{ height, width: '100%', zIndex: 0 }}
    />
  );
}
