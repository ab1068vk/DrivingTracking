import { useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, Gauge } from 'lucide-react';

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

export default function TripPlayback({ trip, height = '380px' }) {
  const mapRef = useRef(null);
  const leafletMapRef = useRef(null);
  const markerRef = useRef(null);
  const polylineRef = useRef(null);
  const animRef = useRef(null);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [currentEvent, setCurrentEvent] = useState(null);

  const points = trip?.route_points || [];
  const events = trip?.driving_events || [];
  const totalPoints = points.length;

  // Build map
  useEffect(() => {
    loadLeaflet().then(() => {
      if (!mapRef.current || leafletMapRef.current) return;
      const map = window.L.map(mapRef.current, { zoomControl: true, attributionControl: true });
      leafletMapRef.current = map;
      window.L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);

      if (points.length > 1) {
        const latLngs = points.map(p => [p.lat, p.lng]);

        // Full grey route
        window.L.polyline(latLngs, { color: '#94a3b8', weight: 3, opacity: 0.5 }).addTo(map);

        // Animated portion polyline
        polylineRef.current = window.L.polyline([], { color: '#3b82f6', weight: 4, opacity: 0.9 }).addTo(map);

        // Event markers
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

        // Car marker
        const carIcon = window.L.divIcon({
          html: `<div style="width:18px;height:18px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 0 4px rgba(59,130,246,0.3),0 2px 8px rgba(0,0,0,0.3)"></div>`,
          className: '', iconSize: [18, 18], iconAnchor: [9, 9],
        });
        markerRef.current = window.L.marker(latLngs[0], { icon: carIcon }).addTo(map);

        map.fitBounds(window.L.latLngBounds(latLngs), { padding: [24, 24] });
      } else {
        map.setView([51.505, -0.09], 13);
      }
    });
    return () => {
      cancelAnimationFrame(animRef.current);
      if (leafletMapRef.current) { leafletMapRef.current.remove(); leafletMapRef.current = null; }
    };
  }, [trip?.id]);

  // Update map position when currentIdx changes
  useEffect(() => {
    if (!leafletMapRef.current || !points[currentIdx]) return;
    const pt = points[currentIdx];
    const latlng = [pt.lat, pt.lng];

    if (markerRef.current) markerRef.current.setLatLng(latlng);
    if (polylineRef.current) {
      polylineRef.current.setLatLngs(points.slice(0, currentIdx + 1).map(p => [p.lat, p.lng]));
    }

    // Check if near an event
    const nearEvt = events.find(e => {
      if (!e.lat) return false;
      const dlat = Math.abs(e.lat - pt.lat);
      const dlng = Math.abs(e.lng - pt.lng);
      return dlat < 0.0002 && dlng < 0.0002;
    });
    setCurrentEvent(nearEvt || null);
  }, [currentIdx]);

  // Playback loop
  useEffect(() => {
    if (!playing) { cancelAnimationFrame(animRef.current); return; }

    const speed = SPEEDS[speedIdx];
    let last = null;
    const BASE_INTERVAL = 600; // ms per point at 1x

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

  if (!points.length) {
    return (
      <div className="rounded-2xl border border-border bg-secondary/30 flex items-center justify-center" style={{ height }}>
        <p className="text-muted-foreground text-sm">No GPS data for this trip</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Map */}
      <div className="rounded-2xl overflow-hidden border border-border shadow-sm relative">
        <div ref={mapRef} style={{ height, width: '100%', zIndex: 0 }} />

        {/* Event flash overlay */}
        {currentEvent && (
          <div className="absolute bottom-3 left-3 right-3 z-10 bg-black/70 backdrop-blur text-white rounded-xl px-3 py-2 text-xs font-medium flex items-center gap-2"
            style={{ borderLeft: `3px solid ${EVENT_COLORS[currentEvent.type] || '#6b7280'}` }}>
            <span style={{ color: EVENT_COLORS[currentEvent.type] }}>⚠</span>
            {currentEvent.type?.replace(/_/g, ' ')} · {currentEvent.severity} severity
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="relative h-1.5 bg-secondary rounded-full overflow-hidden cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          setCurrentIdx(Math.round(pct * (totalPoints - 1)));
        }}>
        <div className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
      </div>

      {/* Controls */}
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

        {/* Speed */}
        <button
          onClick={() => setSpeedIdx(s => (s + 1) % SPEEDS.length)}
          className="flex items-center gap-1 px-3 py-2 bg-secondary rounded-xl text-xs font-medium hover:bg-border transition-colors"
        >
          <Gauge className="w-3.5 h-3.5" />
          {SPEEDS[speedIdx]}x
        </button>

        {/* Live stats */}
        <div className="ml-auto text-xs text-muted-foreground">
          {currentPt && (
            <span>{Math.round(currentPt.speed_kmh || 0)} km/h · pt {currentIdx + 1}/{totalPoints}</span>
          )}
        </div>
      </div>
    </div>
  );
}
