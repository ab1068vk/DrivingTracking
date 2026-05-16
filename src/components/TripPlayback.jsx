import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, SkipBack, Gauge } from 'lucide-react';
import { buildSpeedSegments } from '@/lib/tripInsights';
import { formatSpeed } from '@/lib/tripEngine';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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
  if (leafletLoaded || window.L) { leafletLoaded = true; return Promise.resolve(); }
  if (loadPromise) return loadPromise;
  loadPromise = new Promise(resolve => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => { leafletLoaded = true; resolve(); };
    document.head.appendChild(script);
  });
  return loadPromise;
}

const SPEEDS = [1, 2, 4, 8];

export default function TripPlayback({ trip, secondaryTrip = null, height = '380px' }) {
  const mapRef = useRef(null);
  const leafletMapRef = useRef(null);
  const markerRef = useRef(null);
  const secondaryMarkerRef = useRef(null);
  const progressLayersRef = useRef(null);
  const animRef = useRef(null);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [currentEvent, setCurrentEvent] = useState(null);

  const points = trip?.route_points || [];
  const secondaryPoints = secondaryTrip?.route_points || [];
  const events = trip?.driving_events || [];
  const totalPoints = points.length;
  const speedSegments = useMemo(() => buildSpeedSegments(points), [points]);
  const secondarySegments = useMemo(() => buildSpeedSegments(secondaryPoints), [secondaryPoints]);

  useEffect(() => {
    setCurrentIdx(0);
    setPlaying(false);
    setCurrentEvent(null);
  }, [trip?.id, secondaryTrip?.id]);

  useEffect(() => {
    loadLeaflet().then(() => {
      if (!mapRef.current || leafletMapRef.current) return;
      const map = window.L.map(mapRef.current, { zoomControl: true, attributionControl: true });
      leafletMapRef.current = map;
      window.L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);

      if (points.length > 1) {
        const latLngs = points.map(p => [p.lat, p.lng]);

        speedSegments.forEach((segment) => {
          window.L.polyline(
            [[segment.from.lat, segment.from.lng], [segment.to.lat, segment.to.lng]],
            { color: segment.color, weight: 4, opacity: 0.45 }
          )
            .bindPopup(`${segment.label}: ${Math.round(segment.speed_kmh)} km/h`)
            .addTo(map);
        });

        if (secondaryPoints.length > 1) {
          secondarySegments.forEach((segment) => {
            window.L.polyline(
              [[segment.from.lat, segment.from.lng], [segment.to.lat, segment.to.lng]],
              { color: '#f97316', weight: 4, opacity: 0.35, dashArray: '6 6' }
            )
              .bindPopup(`Comparison: ${Math.round(segment.speed_kmh)} km/h`)
              .addTo(map);
          });
          secondaryPoints.forEach((point) => {
            if (Number.isFinite(point.lat) && Number.isFinite(point.lng)) latLngs.push([point.lat, point.lng]);
          });
        }

        progressLayersRef.current = window.L.layerGroup().addTo(map);

        events.forEach(evt => {
          if (!evt.lat || !evt.lng) return;
          const color = EVENT_COLORS[evt.type] || '#6b7280';
          const icon = window.L.divIcon({
            html: `<div style="width:16px;height:16px;background:${color};border:2px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.25)"></div>`,
            className: '', iconSize: [16, 16], iconAnchor: [8, 8],
          });
          window.L.marker([evt.lat, evt.lng], { icon })
            .bindPopup(`<b>${evt.type?.replace('_', ' ')}</b><br>Severity: ${evt.severity}`)
            .addTo(map);
        });

        const carIcon = window.L.divIcon({
          html: '<div style="width:18px;height:18px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 0 4px rgba(59,130,246,0.3),0 2px 8px rgba(0,0,0,0.3)"></div>',
          className: '', iconSize: [18, 18], iconAnchor: [9, 9],
        });
        markerRef.current = window.L.marker(latLngs[0], { icon: carIcon }).addTo(map);

        if (secondaryPoints.length > 0) {
          const secondaryIcon = window.L.divIcon({
            html: '<div style="width:18px;height:18px;background:#f97316;border:3px solid white;border-radius:50%;box-shadow:0 0 0 4px rgba(249,115,22,0.3),0 2px 8px rgba(0,0,0,0.3)"></div>',
            className: '', iconSize: [18, 18], iconAnchor: [9, 9],
          });
          secondaryMarkerRef.current = window.L.marker([secondaryPoints[0].lat, secondaryPoints[0].lng], { icon: secondaryIcon }).addTo(map);
        }

        map.fitBounds(window.L.latLngBounds(latLngs), { padding: [24, 24] });
      } else {
        map.setView([51.505, -0.09], 13);
      }
    });
    return () => {
      cancelAnimationFrame(animRef.current);
      if (leafletMapRef.current) { leafletMapRef.current.remove(); leafletMapRef.current = null; }
      markerRef.current = null;
      secondaryMarkerRef.current = null;
      progressLayersRef.current = null;
    };
  }, [trip?.id, secondaryTrip?.id]);

  useEffect(() => {
    if (!leafletMapRef.current || !points[currentIdx]) return;
    const pt = points[currentIdx];
    const latlng = [pt.lat, pt.lng];
    const secondaryIdx = secondaryPoints.length > 1
      ? Math.min(secondaryPoints.length - 1, Math.round((currentIdx / Math.max(1, totalPoints - 1)) * (secondaryPoints.length - 1)))
      : 0;
    const secondaryPt = secondaryPoints[secondaryIdx];

    if (markerRef.current) markerRef.current.setLatLng(latlng);
    if (secondaryMarkerRef.current && secondaryPt) secondaryMarkerRef.current.setLatLng([secondaryPt.lat, secondaryPt.lng]);
    if (progressLayersRef.current && window.L) {
      progressLayersRef.current.clearLayers();
      speedSegments.slice(0, currentIdx).forEach((segment) => {
        window.L.polyline(
          [[segment.from.lat, segment.from.lng], [segment.to.lat, segment.to.lng]],
          { color: segment.color, weight: 6, opacity: 0.95 }
        ).addTo(progressLayersRef.current);
      });
      secondarySegments.slice(0, secondaryIdx).forEach((segment) => {
        window.L.polyline(
          [[segment.from.lat, segment.from.lng], [segment.to.lat, segment.to.lng]],
          { color: '#f97316', weight: 6, opacity: 0.85, dashArray: '6 6' }
        ).addTo(progressLayersRef.current);
      });
    }

    const nearEvt = events.find(e => {
      if (!e.lat) return false;
      const dlat = Math.abs(e.lat - pt.lat);
      const dlng = Math.abs(e.lng - pt.lng);
      return dlat < 0.0002 && dlng < 0.0002;
    });
    setCurrentEvent(nearEvt || null);
  }, [currentIdx, events, points, secondaryPoints, secondarySegments, speedSegments, totalPoints]);

  useEffect(() => {
    if (!playing) { cancelAnimationFrame(animRef.current); return; }

    const speed = SPEEDS[speedIdx];
    let last = null;
    const BASE_INTERVAL = 600;

    const step = (ts) => {
      if (!last) last = ts;
      const elapsed = ts - last;
      const msPerPoint = BASE_INTERVAL / speed;

      if (elapsed >= msPerPoint) {
        last = ts;
        setCurrentIdx(prev => {
          if (prev >= totalPoints - 1) { setPlaying(false); return prev; }
          return prev + 1;
        });
      }
      animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animRef.current);
  }, [playing, speedIdx, totalPoints]);

  const handleReset = () => {
    setPlaying(false);
    setCurrentIdx(0);
    setCurrentEvent(null);
  };

  const progress = totalPoints > 1 ? (currentIdx / (totalPoints - 1)) * 100 : 0;
  const currentPt = points[currentIdx];
  const comparisonRows = secondaryTrip ? [
    { label: 'Overall Score', current: trip.score_overall ?? 0, other: secondaryTrip.score_overall ?? 0, higherWins: true },
    { label: 'Harsh Brakes', current: trip.harsh_brakes_count ?? 0, other: secondaryTrip.harsh_brakes_count ?? 0, higherWins: false },
    { label: 'Avg Speed', current: trip.avg_running_speed_kmh ?? trip.avg_speed_kmh ?? 0, other: secondaryTrip.avg_running_speed_kmh ?? secondaryTrip.avg_speed_kmh ?? 0, higherWins: null, speed: true },
  ] : [];

  if (!points.length) {
    return (
      <div className="rounded-2xl border border-border bg-secondary/30 flex items-center justify-center" style={{ height }}>
        <p className="text-muted-foreground text-sm">No GPS data for this trip</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl overflow-hidden border border-border shadow-sm relative">
        <div ref={mapRef} style={{ height, width: '100%', zIndex: 0 }} />

        {currentEvent && (
          <div className="absolute bottom-3 left-3 right-3 z-10 bg-black/70 backdrop-blur text-white rounded-xl px-3 py-2 text-xs font-medium flex items-center gap-2"
            style={{ borderLeft: `3px solid ${EVENT_COLORS[currentEvent.type] || '#6b7280'}` }}>
            <span style={{ color: EVENT_COLORS[currentEvent.type] }}>!</span>
            {currentEvent.type?.replace(/_/g, ' ')} - {currentEvent.severity} severity
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground overflow-x-auto thin-scrollbar pb-1">
        <span className="flex items-center gap-1 whitespace-nowrap"><span className="w-2 h-2 rounded-full bg-slate-400" />Slow</span>
        <span className="flex items-center gap-1 whitespace-nowrap"><span className="w-2 h-2 rounded-full bg-blue-500" />City</span>
        <span className="flex items-center gap-1 whitespace-nowrap"><span className="w-2 h-2 rounded-full bg-green-500" />Cruise</span>
        <span className="flex items-center gap-1 whitespace-nowrap"><span className="w-2 h-2 rounded-full bg-orange-500" />Fast</span>
        <span className="flex items-center gap-1 whitespace-nowrap"><span className="w-2 h-2 rounded-full bg-red-500" />Risk</span>
      </div>

      <div className="relative h-1.5 bg-secondary rounded-full overflow-hidden cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          setCurrentIdx(Math.round(pct * (totalPoints - 1)));
        }}>
        <div className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
      </div>

      <div className="flex items-center gap-2">
        <button onClick={handleReset}
          className="p-2 hover:bg-secondary rounded-xl transition-colors">
          <SkipBack className="w-4 h-4 text-muted-foreground" />
        </button>
        <button
          onClick={() => setPlaying(p => !p)}
          className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          {playing ? 'Pause' : 'Play'}
        </button>

        <button
          onClick={() => setSpeedIdx(s => (s + 1) % SPEEDS.length)}
          className="flex items-center gap-1 px-3 py-2 bg-secondary rounded-xl text-xs font-medium hover:bg-border transition-colors"
        >
          <Gauge className="w-3.5 h-3.5" />
          {SPEEDS[speedIdx]}x
        </button>

        <div className="ml-auto text-xs text-muted-foreground">
          {currentPt && (
            <span>{Math.round(currentPt.speed_kmh || 0)} km/h - pt {currentIdx + 1}/{totalPoints}</span>
          )}
        </div>
      </div>

      {secondaryTrip && (
        <div className="rounded-2xl border border-border bg-card p-3">
          <div className="mb-2 flex items-center gap-3 text-xs font-semibold">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500" />This Trip</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-orange-500" />vs Trip</span>
          </div>
          <div className="space-y-2">
            {comparisonRows.map((row) => {
              const currentWins = row.higherWins == null
                ? null
                : row.higherWins
                  ? row.current >= row.other
                  : row.current <= row.other;
              const otherText = row.speed ? formatSpeed(row.other) : row.other;
              return (
                <div key={row.label} className="grid grid-cols-3 items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className={`font-semibold ${currentWins === true ? 'text-emerald-600' : currentWins === false ? 'text-red-600' : ''}`}>
                    {row.speed ? formatSpeed(row.current) : row.current}
                  </span>
                  <span className={currentWins === false ? 'text-emerald-600 font-semibold' : currentWins === true ? 'text-red-600 font-semibold' : 'font-semibold'}>
                    {otherText} {currentWins === true ? '▼' : currentWins === false ? '▲' : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
