import { useEffect, useMemo, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import MapErrorBoundary from '@/components/MapErrorBoundary';

const validPoint = (point) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
};

const distanceM = (a, b) => {
  const toRadians = (value) => value * Math.PI / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
};

const corridorCoveragePoints = (points, radiusM) => {
  if (points.length < 2) return points;
  const coverage = [points[0]];
  const spacingM = Math.max(20, radiusM * 0.6);
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const steps = Math.min(80, Math.max(1, Math.ceil(distanceM(start, end) / spacingM)));
    for (let step = 1; step <= steps; step++) {
      const ratio = step / steps;
      coverage.push({
        lat: start.lat + (end.lat - start.lat) * ratio,
        lng: start.lng + (end.lng - start.lng) * ratio,
      });
    }
  }
  return coverage.slice(0, 800);
};

function PrivacyZonePreviewMapContent({ type = 'circle', location = null, waypoints = [], distanceM = 150 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  const [leaflet, setLeaflet] = useState(null);
  const normalizedLocation = useMemo(() => validPoint(location), [location]);
  const normalizedWaypoints = useMemo(
    () => (Array.isArray(waypoints) ? waypoints.map(validPoint).filter(Boolean) : []),
    [waypoints]
  );
  const safeDistanceM = Math.max(1, Number(distanceM) || 150);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let cancelled = false;
    import('leaflet').then((module) => {
      if (!cancelled) setLeaflet(module.default || module);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!leaflet || !containerRef.current || mapRef.current) return undefined;
    const map = leaflet.map(containerRef.current, {
      attributionControl: false,
      zoomControl: true,
      scrollWheelZoom: false,
    });
    mapRef.current = map;
    layersRef.current = leaflet.layerGroup().addTo(map);
    map.setView([43.6532, -79.3832], 13, { animate: false });
    window.setTimeout(() => map.invalidateSize(false), 0);
    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
    };
  }, [leaflet]);

  useEffect(() => {
    const L = leaflet;
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!L || !map || !layers) return;
    layers.clearLayers();
    const bounds = L.latLngBounds([]);

    if (type === 'corridor') {
      const positions = normalizedWaypoints.map((point) => [point.lat, point.lng]);
      if (positions.length >= 2) {
        corridorCoveragePoints(normalizedWaypoints, safeDistanceM).forEach((point) => {
          L.circle([point.lat, point.lng], {
            radius: safeDistanceM,
            stroke: false,
            fillColor: '#3b82f6',
            fillOpacity: 0.16,
            interactive: false,
          }).addTo(layers);
        });
        L.polyline(positions, {
          color: '#1d4ed8',
          weight: 3,
          opacity: 0.95,
          dashArray: '8 7',
        }).addTo(layers);
      }
      normalizedWaypoints.forEach((point, index) => {
        L.circleMarker([point.lat, point.lng], {
          radius: index === 0 || index === normalizedWaypoints.length - 1 ? 7 : 5,
          color: '#ffffff',
          weight: 2,
          fillColor: '#1d4ed8',
          fillOpacity: 1,
        })
          .bindTooltip(index === 0 ? 'Start' : index === normalizedWaypoints.length - 1 ? 'End' : `Point ${index + 1}`)
          .addTo(layers);
        bounds.extend([point.lat, point.lng]);
      });
    } else if (normalizedLocation) {
      L.circle([normalizedLocation.lat, normalizedLocation.lng], {
        radius: safeDistanceM,
        color: '#1d4ed8',
        fillColor: '#3b82f6',
        fillOpacity: 0.2,
        weight: 3,
      }).addTo(layers);
      L.circleMarker([normalizedLocation.lat, normalizedLocation.lng], {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: '#1d4ed8',
        fillOpacity: 1,
      }).bindTooltip('Zone center').addTo(layers);
      bounds.extend([normalizedLocation.lat, normalizedLocation.lng]);
    }

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(type === 'corridor' ? 0.3 : 1.25), {
        animate: false,
        maxZoom: 16,
        padding: [24, 24],
      });
    }
    window.setTimeout(() => map.invalidateSize(false), 0);
  }, [leaflet, normalizedLocation, normalizedWaypoints, safeDistanceM, type]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-slate-100 dark:bg-slate-950">
      <div
        ref={containerRef}
        className="h-72 w-full bg-[linear-gradient(to_right,rgba(100,116,139,0.12)_1px,transparent_1px),linear-gradient(to_bottom,rgba(100,116,139,0.12)_1px,transparent_1px)] bg-[size:24px_24px]"
        aria-label="Local privacy zone geometry preview"
      />
      {!leaflet && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-semibold text-muted-foreground">
          Preparing local preview...
        </div>
      )}
      <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-background/90 px-2 py-1 text-[10px] font-semibold text-muted-foreground shadow-sm">
        Local geometry preview - no street tiles or geocoder
      </div>
    </div>
  );
}

export default function PrivacyZonePreviewMap(props) {
  const resetKey = `${props.type}:${props.location?.lat || ''}:${props.location?.lng || ''}:${props.waypoints?.length || 0}:${props.distanceM || ''}`;
  return (
    <MapErrorBoundary
      context="privacy_zone_preview_map"
      title="Preview unavailable"
      message="The zone can still be reviewed using the description below."
      resetKey={resetKey}
      height="18rem"
    >
      <PrivacyZonePreviewMapContent {...props} />
    </MapErrorBoundary>
  );
}
