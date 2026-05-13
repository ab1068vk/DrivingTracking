import { useEffect, useRef } from 'react';

/**
 * TripMap component using Leaflet + OpenStreetMap tiles (free, no API key).
 * Renders a route polyline, start/end markers, and event markers.
 *
 * Leaflet is loaded via CDN to avoid build issues. The map is destroyed
 * on unmount to prevent memory leaks.
 */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const EVENT_COLORS = {
  harsh_brake: '#ef4444',
  rapid_acceleration: '#f59e0b',
  sharp_turn: '#3b82f6',
  speeding: '#f97316',
  idle: '#6b7280',
};

let leafletLoaded = false;
let loadPromise = null;

function loadLeaflet() {
  if (leafletLoaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve) => {
    // Check if already loaded
    if (window.L) {
      leafletLoaded = true;
      resolve();
      return;
    }

    // Load CSS
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);

    // Load JS
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
  events = [],
  showCurrentLocation = false,
  currentLocation = null,
  height = '350px',
  className = '',
}) {
  const mapRef = useRef(null);
  const leafletMapRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => {
    let map = null;

    loadLeaflet().then(() => {
      if (!mapRef.current || leafletMapRef.current) return;

      // Create map
      map = window.L.map(mapRef.current, {
        zoomControl: true,
        attributionControl: true,
      });

      leafletMapRef.current = map;

      // Add OSM tiles
      window.L.tileLayer(TILE_URL, {
        attribution: TILE_ATTRIBUTION,
        maxZoom: 19,
      }).addTo(map);

      // Draw route if we have points
      if (routePoints && routePoints.length > 1) {
        const latLngs = routePoints.map(p => [p.lat, p.lng]);

        // Route polyline
        const polyline = window.L.polyline(latLngs, {
          color: '#3b82f6',
          weight: 4,
          opacity: 0.85,
          smoothFactor: 1.5,
        }).addTo(map);

        // Fit map to route
        map.fitBounds(polyline.getBounds(), { padding: [20, 20] });

        // Start marker (green)
        const startIcon = window.L.divIcon({
          html: `<div style="width:14px;height:14px;background:#22c55e;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`,
          className: '',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        });
        window.L.marker(latLngs[0], { icon: startIcon })
          .bindPopup('<b>Start</b>')
          .addTo(map);

        // End marker (red)
        const endIcon = window.L.divIcon({
          html: `<div style="width:14px;height:14px;background:#ef4444;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`,
          className: '',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        });
        window.L.marker(latLngs[latLngs.length - 1], { icon: endIcon })
          .bindPopup('<b>End</b>')
          .addTo(map);
      } else if (currentLocation) {
        map.setView([currentLocation.lat, currentLocation.lng], 15);
      } else {
        // Default view
        map.setView([51.505, -0.09], 13);
      }

      // Draw event markers
      if (events && events.length > 0) {
        events.forEach(evt => {
          if (!evt.lat || !evt.lng) return;
          const color = EVENT_COLORS[evt.type] || '#6b7280';
          const labels = {
            harsh_brake: '🛑',
            rapid_acceleration: '⚡',
            sharp_turn: '↰',
            speeding: '🚀',
            idle: '⏸',
          };
          const icon = window.L.divIcon({
            html: `<div style="width:20px;height:20px;background:${color};border:2px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;font-size:8px">${labels[evt.type] || '⚠'}</div>`,
            className: '',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });
          window.L.marker([evt.lat, evt.lng], { icon })
            .bindPopup(`<b>${evt.type?.replace('_', ' ')}</b><br>Severity: ${evt.severity}`)
            .addTo(map);
        });
      }

      // Current location
      if (showCurrentLocation && currentLocation) {
        const locIcon = window.L.divIcon({
          html: `<div style="width:16px;height:16px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 0 6px rgba(59,130,246,0.2),0 2px 6px rgba(0,0,0,0.2)"></div>`,
          className: '',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });
        window.L.marker([currentLocation.lat, currentLocation.lng], { icon: locIcon })
          .bindPopup('<b>You are here</b>')
          .addTo(map);
      }
    });

    return () => {
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }
    };
  }, []);

  // Update current location marker
  useEffect(() => {
    if (!leafletMapRef.current || !showCurrentLocation || !currentLocation) return;
    leafletMapRef.current.panTo([currentLocation.lat, currentLocation.lng]);
  }, [currentLocation]);

  return (
    <div
      ref={mapRef}
      className={`map-container ${className}`}
      style={{ height, width: '100%', zIndex: 0 }}
    />
  );
}