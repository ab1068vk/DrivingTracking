import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Clock, Flag, Gauge, LocateFixed, Pause, Play, Route, SkipBack, SkipForward } from 'lucide-react';
import { buildRouteComparison, buildPlaybackTimeline, playbackPositionAtElapsed } from '@/lib/mapPlaybackInsights';
import { calculateBearing, formatDistance, formatDuration, formatSpeed } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { maskEventsForPrivacy, maskRoutePointsForPrivacy } from '@/lib/privacyZones';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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
  possible_crash: '#991b1b',
};

const titleCase = (value) => String(value || '')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const formatEventTime = (value) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
};

const eventPopupHtml = (event) => {
  const limit = event.speed_limit_kmh ?? event.inferred_zone_kmh ?? event.actualLimitKmh;
  const rows = [
    ['Severity', titleCase(event.severity || event.confidence_level || 'medium')],
    ['Time', formatEventTime(event.timestamp || event.startTime)],
    ['Speed', Number.isFinite(Number(event.speed_kmh)) ? `${Math.round(Number(event.speed_kmh))} km/h` : null],
    ['Limit', Number.isFinite(Number(limit)) ? `${Math.round(Number(limit))} km/h` : null],
    ['Over by', Number.isFinite(Number(event.speed_kmh)) && Number.isFinite(Number(limit))
      ? `${Math.max(0, Math.round(Number(event.speed_kmh) - Number(limit)))} km/h`
      : null],
    ['Duration', Number.isFinite(Number(event.durationS ?? event.duration_seconds)) ? `${Math.round(Number(event.durationS ?? event.duration_seconds))}s` : null],
    ['Value', Number.isFinite(Number(event.value)) ? Number(event.value).toFixed(event.type === 'sharp_turn' ? 2 : 1) : null],
    ['Source', event.speed_limit_source || event.source || null],
    ['Confidence', event.zone_confidence || event.confidence_level || event.confidence || null],
    ['Signals', Array.isArray(event.signals_triggered) && event.signals_triggered.length ? event.signals_triggered.join(', ') : null],
  ].filter(([, value]) => value != null && value !== '');

  return `
    <div style="min-width:200px">
      <b>${escapeHtml(titleCase(event.type || 'event'))}</b>
      <div style="margin-top:6px;display:grid;gap:3px">
        ${rows.map(([key, value]) => `<div><span style="color:#64748b">${escapeHtml(key)}:</span> ${escapeHtml(value)}</div>`).join('')}
      </div>
    </div>
  `;
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
const REVIEW_SECONDS_PER_POINT = 0.6;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const carIconHtml = (color, heading, label = '') => `
  <div style="width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,0.94);border:1px solid rgba(15,23,42,0.18);box-shadow:0 4px 16px rgba(15,23,42,0.24);display:flex;align-items:center;justify-content:center">
    <div style="width:20px;height:20px;border-radius:999px;background:${color};color:white;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;transform:rotate(${heading}deg)">${label || '^'}</div>
  </div>
`;

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
  const [followVehicle, setFollowVehicle] = useState(true);
  const [playbackElapsedSeconds, setPlaybackElapsedSeconds] = useState(0);
  const [selectedSegmentId, setSelectedSegmentId] = useState(null);

  const privacySettings = useMemo(() => localSettings.get(), [trip?.id, secondaryTrip?.id]);
  const points = useMemo(() => maskRoutePointsForPrivacy(trip?.route_points || [], privacySettings)
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)), [privacySettings, trip?.route_points]);
  const secondaryPoints = useMemo(() => maskRoutePointsForPrivacy(secondaryTrip?.route_points || [], privacySettings)
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)), [privacySettings, secondaryTrip?.route_points]);
  const events = useMemo(() => maskEventsForPrivacy(trip?.driving_events || [], privacySettings), [privacySettings, trip?.driving_events]);
  const totalPoints = points.length;
  const timeline = useMemo(() => buildPlaybackTimeline(points, events), [events, points]);
  const secondaryTimeline = useMemo(() => buildPlaybackTimeline(secondaryPoints, []), [secondaryPoints]);
  const speedSegments = timeline.segments;
  const secondarySegments = secondaryTimeline.segments;
  const stats = timeline.stats;
  const timelineEvents = timeline.events;
  const playbackPosition = useMemo(() => playbackPositionAtElapsed(points, playbackElapsedSeconds), [playbackElapsedSeconds, points]);
  const currentPt = playbackPosition.point || points[currentIdx];
  const previousPt = points[Math.max(0, currentIdx - 1)];
  const currentHeading = currentPt && previousPt && currentIdx > 0
    ? playbackPosition.heading || calculateBearing(previousPt.lat, previousPt.lng, currentPt.lat, currentPt.lng)
    : Number(currentPt?.heading ?? currentPt?.bearing ?? 0) || 0;
  const currentDistanceKm = timeline.cumulativeDistancesKm[Math.min(currentIdx, timeline.cumulativeDistancesKm.length - 1)] || 0;
  const elapsedSeconds = Math.round(playbackElapsedSeconds);
  const nextEvent = timelineEvents.find((event) => event.playbackIndex > currentIdx);
  const selectedSegment = speedSegments.find((segment) => segment.id === selectedSegmentId);
  const routeComparison = useMemo(() => buildRouteComparison(trip, secondaryTrip), [secondaryTrip, trip]);

  useEffect(() => {
    setCurrentIdx(0);
    setPlaying(false);
    setCurrentEvent(null);
    setFollowVehicle(true);
    setPlaybackElapsedSeconds(0);
    setSelectedSegmentId(null);
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
            .bindPopup(`${segment.band.label}: ${Math.round(segment.speedKmh)} km/h${segment.speedLimitKmh ? `<br>Limit: ${Math.round(segment.speedLimitKmh)} km/h` : ''}`)
            .on('click', () => setSelectedSegmentId(segment.id))
            .addTo(map);
        });

        if (secondaryPoints.length > 1) {
          secondarySegments.forEach((segment) => {
            window.L.polyline(
            [[segment.from.lat, segment.from.lng], [segment.to.lat, segment.to.lng]],
            { color: '#f97316', weight: 4, opacity: 0.35, dashArray: '6 6' }
          )
              .bindPopup(`Comparison: ${Math.round(segment.speedKmh)} km/h`)
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
            .bindPopup(eventPopupHtml(evt))
            .addTo(map);
        });

        const carIcon = window.L.divIcon({
          html: carIconHtml('#2563eb', 0),
          className: '', iconSize: [34, 34], iconAnchor: [17, 17],
        });
        markerRef.current = window.L.marker(latLngs[0], { icon: carIcon }).addTo(map);

        if (secondaryPoints.length > 0) {
          const secondaryIcon = window.L.divIcon({
            html: carIconHtml('#f97316', 0, '2'),
            className: '', iconSize: [34, 34], iconAnchor: [17, 17],
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
    const pt = currentPt || points[currentIdx];
    if (!pt) return;
    const latlng = [pt.lat, pt.lng];
    const secondaryIdx = secondaryPoints.length > 1
      ? Math.min(secondaryPoints.length - 1, Math.round((currentIdx / Math.max(1, totalPoints - 1)) * (secondaryPoints.length - 1)))
      : 0;
    const secondaryPt = secondaryPoints[secondaryIdx];

    const heading = playbackPosition.heading || (currentIdx > 0
      ? calculateBearing(points[currentIdx - 1].lat, points[currentIdx - 1].lng, pt.lat, pt.lng)
      : Number(pt.heading ?? pt.bearing ?? 0) || 0);

    if (markerRef.current) {
      markerRef.current.setLatLng(latlng);
      markerRef.current.setIcon(window.L.divIcon({
        html: carIconHtml('#2563eb', heading),
        className: '',
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      }));
    }
    if (secondaryMarkerRef.current && secondaryPt) {
      const secondaryPrev = secondaryPoints[Math.max(0, secondaryIdx - 1)];
      const secondaryHeading = secondaryIdx > 0 && secondaryPrev
        ? calculateBearing(secondaryPrev.lat, secondaryPrev.lng, secondaryPt.lat, secondaryPt.lng)
        : Number(secondaryPt.heading ?? secondaryPt.bearing ?? 0) || 0;
      secondaryMarkerRef.current.setLatLng([secondaryPt.lat, secondaryPt.lng]);
      secondaryMarkerRef.current.setIcon(window.L.divIcon({
        html: carIconHtml('#f97316', secondaryHeading, '2'),
        className: '',
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      }));
    }
    if (followVehicle) leafletMapRef.current.panTo(latlng, { animate: true, duration: 0.25 });
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

    const nearEvt = timelineEvents.find((event) => Math.abs(event.playbackIndex - currentIdx) <= 1);
    setCurrentEvent(nearEvt || null);
  }, [currentIdx, currentPt, followVehicle, playbackPosition.heading, points, secondaryPoints, secondarySegments, speedSegments, timelineEvents, totalPoints]);

  useEffect(() => {
    if (!playing) { cancelAnimationFrame(animRef.current); return; }

    const speed = SPEEDS[speedIdx];
    let last = null;
    const totalSeconds = stats.durationSeconds || Math.max(1, totalPoints - 1);
    const reviewDurationSeconds = Math.max(8, totalPoints * REVIEW_SECONDS_PER_POINT);
    const timelineScale = totalSeconds > 0 ? totalSeconds / reviewDurationSeconds : 1;

    const step = (ts) => {
      if (!last) last = ts;
      const elapsedMs = ts - last;
      last = ts;
      setPlaybackElapsedSeconds((previous) => {
        const next = previous + (elapsedMs / 1000) * speed * timelineScale;
        if (next >= totalSeconds) {
          setPlaying(false);
          setCurrentIdx(totalPoints - 1);
          return totalSeconds;
        }
        const position = playbackPositionAtElapsed(points, next);
        setCurrentIdx(position.index);
        return next;
      });
      animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animRef.current);
  }, [playing, points, speedIdx, stats.durationSeconds, totalPoints]);

  const handleReset = () => {
    setPlaying(false);
    setCurrentIdx(0);
    setPlaybackElapsedSeconds(0);
    setCurrentEvent(null);
  };

  const elapsedForIndex = (index) => (
    speedSegments.find((segment) => segment.toIndex >= index)?.endOffsetSeconds || index
  );

  const seekToIndex = (index) => {
    const safeIndex = clamp(index, 0, totalPoints - 1);
    setPlaying(false);
    setCurrentIdx(safeIndex);
    setPlaybackElapsedSeconds(elapsedForIndex(safeIndex));
  };

  const jumpToNextEvent = () => {
    const event = timelineEvents.find((item) => item.playbackIndex > currentIdx);
    if (event) {
      setPlaying(false);
      seekToIndex(event.playbackIndex);
    }
  };

  const jumpToPreviousEvent = () => {
    const event = [...timelineEvents].reverse().find((item) => item.playbackIndex < currentIdx);
    if (event) {
      setPlaying(false);
      seekToIndex(event.playbackIndex);
    }
  };

  const progress = totalPoints > 1 ? (currentIdx / (totalPoints - 1)) * 100 : 0;
  const comparisonRows = secondaryTrip ? routeComparison.rows : [];

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

        <div className="absolute left-3 top-3 z-10 grid max-w-[calc(100%-1.5rem)] grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-xl border border-border bg-card/95 px-3 py-2 shadow backdrop-blur">
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-normal text-muted-foreground">
              <Gauge className="h-3 w-3" /> Speed
            </div>
            <div className="font-grotesk text-lg font-bold">{Math.round(currentPt?.speed_kmh || 0)} km/h</div>
          </div>
          <div className="rounded-xl border border-border bg-card/95 px-3 py-2 shadow backdrop-blur">
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-normal text-muted-foreground">
              <Route className="h-3 w-3" /> Traveled
            </div>
            <div className="font-grotesk text-lg font-bold">{formatDistance(currentDistanceKm)}</div>
          </div>
          <div className="rounded-xl border border-border bg-card/95 px-3 py-2 shadow backdrop-blur">
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-normal text-muted-foreground">
              <Clock className="h-3 w-3" /> Time
            </div>
            <div className="font-grotesk text-lg font-bold">{formatDuration(elapsedSeconds)}</div>
          </div>
          <div className="rounded-xl border border-border bg-card/95 px-3 py-2 shadow backdrop-blur">
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-normal text-muted-foreground">
              <Activity className="h-3 w-3" /> Heading
            </div>
            <div className="font-grotesk text-lg font-bold">{Math.round(currentHeading)} deg</div>
          </div>
        </div>

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
          seekToIndex(Math.round(pct * (totalPoints - 1)));
        }}>
        {speedSegments.map((segment) => (
          <button
            key={segment.id}
            type="button"
            aria-label={`Inspect ${segment.band.label} segment`}
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${segment.progressStart}%`,
              width: `${Math.max(0.8, segment.progressEnd - segment.progressStart)}%`,
              backgroundColor: segment.color,
              opacity: selectedSegmentId === segment.id ? 1 : 0.42,
            }}
            onClick={(event) => {
              event.stopPropagation();
              setSelectedSegmentId(segment.id);
              seekToIndex(segment.toIndex);
            }}
          />
        ))}
        {timeline.stops.map((stop) => (
          <span
            key={stop.id}
            className="absolute bottom-0 top-0 rounded-full bg-slate-900/60"
            style={{
              left: `${stop.progressStart}%`,
              width: `${Math.max(1, stop.progressEnd - stop.progressStart)}%`,
            }}
          />
        ))}
        <div className="pointer-events-none absolute inset-y-0 left-0 rounded-full border-r-2 border-primary bg-primary/25 transition-all" style={{ width: `${progress}%` }} />
        {timelineEvents.map((event, index) => (
          <span
            key={`${event.timestamp || event.type}-${index}`}
            className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-full"
            style={{
              left: `${totalPoints > 1 ? (event.playbackIndex / (totalPoints - 1)) * 100 : 0}%`,
              backgroundColor: EVENT_COLORS[event.type] || '#6b7280',
            }}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={handleReset}
          title="Restart"
          aria-label="Restart playback"
          className="p-2 hover:bg-secondary rounded-xl transition-colors">
          <SkipBack className="w-4 h-4 text-muted-foreground" />
        </button>
        <button onClick={jumpToPreviousEvent}
          disabled={!timelineEvents.some((event) => event.playbackIndex < currentIdx)}
          title="Previous event"
          aria-label="Previous event"
          className="p-2 hover:bg-secondary rounded-xl transition-colors disabled:opacity-40">
          <Flag className="w-4 h-4 text-muted-foreground" />
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
        <button
          onClick={() => setFollowVehicle(value => !value)}
          className={`flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
            followVehicle ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300' : 'bg-secondary hover:bg-border'
          }`}
        >
          <LocateFixed className="w-3.5 h-3.5" />
          Follow
        </button>
        <button onClick={jumpToNextEvent}
          disabled={!nextEvent}
          title="Next event"
          aria-label="Next event"
          className="p-2 hover:bg-secondary rounded-xl transition-colors disabled:opacity-40">
          <SkipForward className="w-4 h-4 text-muted-foreground" />
        </button>

        <div className="ml-auto text-xs text-muted-foreground">
          {currentPt && (
            <span>{Math.round(currentPt.speed_kmh || 0)} km/h - pt {currentIdx + 1}/{totalPoints}</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-2xl border border-border bg-card p-3 text-xs">
        <div>
          <div className="text-muted-foreground">Route</div>
          <div className="font-semibold">{formatDistance(stats.distanceKm)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Duration</div>
          <div className="font-semibold">{stats.durationSeconds ? formatDuration(stats.durationSeconds) : '-'}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Max speed</div>
          <div className="font-semibold">{stats.maxSpeedKmh} km/h</div>
        </div>
      </div>

      {selectedSegment && (
        <div className="rounded-2xl border border-border bg-card p-3 text-xs">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-semibold">Selected segment</div>
            <button
              type="button"
              onClick={() => setSelectedSegmentId(null)}
              className="rounded-lg bg-secondary px-2 py-1 text-[11px] font-semibold text-muted-foreground"
            >
              Clear
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <div className="text-muted-foreground">Speed</div>
              <div className="font-semibold">{Math.round(selectedSegment.speedKmh)} km/h</div>
            </div>
            <div>
              <div className="text-muted-foreground">Limit</div>
              <div className="font-semibold">{selectedSegment.speedLimitKmh ? `${Math.round(selectedSegment.speedLimitKmh)} km/h` : '-'}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Distance</div>
              <div className="font-semibold">{formatDistance(selectedSegment.distanceKm)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Duration</div>
              <div className="font-semibold">{selectedSegment.durationSeconds ? formatDuration(selectedSegment.durationSeconds) : '-'}</div>
            </div>
          </div>
          {(selectedSegment.roadName || selectedSegment.overLimitKmh > 0) && (
            <div className="mt-2 rounded-xl bg-secondary/60 px-3 py-2 text-muted-foreground">
              {selectedSegment.roadName || 'Matched segment'}
              {selectedSegment.overLimitKmh > 0 ? ` - ${Math.round(selectedSegment.overLimitKmh)} km/h over` : ''}
            </div>
          )}
        </div>
      )}

      {timeline.story.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-3 text-xs">
          <div className="mb-2 font-semibold">Trip story</div>
          <div className="grid gap-1.5">
            {timeline.story.map((item) => (
              <div key={item} className="flex gap-2 text-muted-foreground">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}

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
          {routeComparison.notes.length > 0 && (
            <div className="mt-3 grid gap-1 rounded-xl bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
              {routeComparison.notes.map((note) => <div key={note}>{note}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
