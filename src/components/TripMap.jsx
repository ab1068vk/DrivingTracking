import { useEffect, useRef, useState } from 'react';
import { buildSpeedSegments } from '@/lib/tripInsights';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TORONTO_CENTER = [43.6532, -79.3832];

const EVENT_COLORS = {
  harsh_brake: '#ef4444',
  rapid_acceleration: '#f59e0b',
  sharp_turn: '#3b82f6',
  speeding: '#f97316',
  idle: '#6b7280',
};

const EVENT_LABELS = {
  harsh_brake: '!',
  rapid_acceleration: '+',
  sharp_turn: '<',
  speeding: '>',
  idle: 'P',
};

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

        if (speedSegments.length > 0) {
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

      const endIcon = window.L.divIcon({
        html: '<div style="width:14px;height:14px;background:#ef4444;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>',
        className: '',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      window.L.marker(latLngs[latLngs.length - 1], { icon: endIcon })
        .bindPopup('<b>End</b>')
        .addTo(layers);
    } else if (currentLocation) {
      map.setView([currentLocation.lat, currentLocation.lng], 15);
    } else {
      map.setView(TORONTO_CENTER, 12);
    }

    if (events && events.length > 0) {
      events.forEach(evt => {
        if (!evt.lat || !evt.lng) return;
        const color = EVENT_COLORS[evt.type] || '#6b7280';
        const icon = window.L.divIcon({
          html: `<div style="width:20px;height:20px;background:${color};color:white;border:2px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${EVENT_LABELS[evt.type] || '!'}</div>`,
          className: '',
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        });
        window.L.marker([evt.lat, evt.lng], { icon })
          .bindPopup(`<b>${evt.type?.replace('_', ' ')}</b><br>Severity: ${evt.severity}`)
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
  }, [ready, routePoints, routes, events, showCurrentLocation, currentLocation, parkedLocation]);

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
