import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { MapPin, Crosshair, Car, AlertCircle, Play, Filter, Gauge, Layers } from 'lucide-react';
import TripMap from '@/components/TripMap';
import TripPlayback from '@/components/TripPlayback';
import { formatDistance, formatDate, getScoreColor } from '@/lib/tripEngine';
import { getLastParkedLocation, localSettings, saveLastParkedLocation } from '@/lib/trackingStore';
import { getCurrentLocation } from '@/lib/trackingService';
import { identifyCommutePatterns } from '@/lib/tripInsights';
import { saveDangerZones } from '@/lib/dangerZoneEngine';
import { buildRouteRiskIndex, getSegmentsForTrip, loadRouteRiskIndex, saveRouteRiskIndex } from '@/lib/routeRiskIndex';
import { buildRiskHotspots } from '@/lib/mediumInsights';
import { buildOpenSourceTripContextPatch, describeOsmSpeedLimitStatus } from '@/lib/openSourceTripContext';

const MAP_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'night', label: 'Night' },
  { id: 'harsh_braking', label: 'Harsh Braking' },
];

const MAP_ROUTE_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#06b6d4', '#ef4444'];
const routeCell = (point) => `${Math.round(point.lat * 200) / 200},${Math.round(point.lng * 200) / 200}`;
const routeKeyForTrip = (trip) => {
  const points = trip?.route_points || [];
  if (points.length < 2) return null;
  return `${routeCell(points[0])}|${routeCell(points[points.length - 1])}`;
};

const relativeTime = (value) => {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return 'recently';
  const minutes = Math.max(0, Math.round(elapsed / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export default function MapScreen() {
  const qc = useQueryClient();
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [showCurrentLoc, setShowCurrentLoc] = useState(false);
  const [locError, setLocError] = useState(null);
  const [mapFilter, setMapFilter] = useState('all');
  const [playbackMode, setPlaybackMode] = useState(false);
  const [parkedLocation, setParkedLocation] = useState(null);
  const [parkingError, setParkingError] = useState(null);
  const [secondaryTripId, setSecondaryTripId] = useState('');
  const [dangerZones, setDangerZones] = useState([]);
  const [showDangerZones, setShowDangerZones] = useState(false);
  const [routeRiskIndex, setRouteRiskIndex] = useState(new Map());
  const [showRouteRisk, setShowRouteRisk] = useState(false);
  const [showSpeedLimits, setShowSpeedLimits] = useState(false);
  const settings = localSettings.get();
  const units = settings.units || 'metric';

  const { data: trips = [] } = useQuery({
    queryKey: ['map-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 500 }),
  });
  const contextMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTrip) throw new Error('Select a trip first.');
      return tripService.update(selectedTrip.id, await buildOpenSourceTripContextPatch(selectedTrip, localSettings.get()));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-trips'] });
      qc.invalidateQueries({ queryKey: ['recent-trips'] });
      qc.invalidateQueries({ queryKey: ['all-trips'] });
      if (selectedTripId) qc.invalidateQueries({ queryKey: ['trip', selectedTripId] });
    },
  });

  const allCompleted = trips.filter(t => t.status === 'completed' && t.route_points?.length > 1);
  const completed = allCompleted.filter(t => {
    if (mapFilter === 'night') return t.night_driving;
    if (mapFilter === 'harsh_braking') return (t.harsh_brakes_count || 0) > 0;
    return true;
  });
  const selectedTrip = allCompleted.find(t => t.id === selectedTripId);
  const secondaryTrip = allCompleted.find(t => String(t.id) === String(secondaryTripId));
  const selectedEvents = settings.phone_use_show_on_map === false
    ? (selectedTrip?.driving_events || []).filter((event) => event.type !== 'phone_use')
    : (selectedTrip?.driving_events || []);
  const selectedSpeedLimitCoverage = selectedTrip?.speed_limit_context?.coverage ?? 0;
  const selectedHasSpeedLimits = (selectedTrip?.route_points || []).some((point) => Number.isFinite(Number(point.speed_limit_kmh)));
  const selectedRiskSegments = useMemo(() => (
    selectedTrip ? getSegmentsForTrip(selectedTrip, routeRiskIndex) : []
  ), [routeRiskIndex, selectedTrip]);
  const commutePatterns = useMemo(() => identifyCommutePatterns(allCompleted), [allCompleted]);
  const compareOptions = useMemo(() => {
    if (!selectedTrip) return [];
    const selectedKey = routeKeyForTrip(selectedTrip);
    if (!selectedKey || !commutePatterns.some((pattern) => pattern.route_key === selectedKey)) return [];
    return allCompleted
      .filter((trip) => String(trip.id) !== String(selectedTrip.id) && routeKeyForTrip(trip) === selectedKey)
      .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime())
      .slice(0, 5);
  }, [allCompleted, commutePatterns, selectedTrip]);
  const mapRoutes = selectedTrip
    ? [{
      id: selectedTrip.id,
      route_points: selectedTrip.route_points,
      selected: true,
      color: '#3b82f6',
      label: formatDate(selectedTrip.start_time),
    }]
    : completed.map((trip, index) => ({
      id: trip.id,
      route_points: trip.route_points,
      selected: false,
      color: MAP_ROUTE_COLORS[index % MAP_ROUTE_COLORS.length],
      label: formatDate(trip.start_time),
    }));

  const handleShowMyLocation = async () => {
    try {
      const point = await getCurrentLocation();
      setCurrentLocation({ lat: point.lat, lng: point.lng });
      setShowCurrentLoc(true);
      setLocError(null);
    } catch {
      setLocError('Could not get location. Check location permission and GPS settings.');
    }
  };

  useEffect(() => {
    setSecondaryTripId('');
  }, [selectedTripId]);

  useEffect(() => {
    let cancelled = false;
    const rebuildOverlays = async () => {
      if (!allCompleted.length) {
        setDangerZones([]);
        setRouteRiskIndex(new Map());
        return;
      }

      const zones = buildRiskHotspots(allCompleted);
      await saveDangerZones(zones);
      let index = await loadRouteRiskIndex();
      if (!index || index.size === 0) {
        index = buildRouteRiskIndex(allCompleted);
        await saveRouteRiskIndex(index);
      }
      if (!cancelled) {
        setDangerZones(zones);
        setRouteRiskIndex(index);
      }
    };

    rebuildOverlays();
    return () => {
      cancelled = true;
    };
  }, [allCompleted.length, trips]);

  const handleWhereParked = async () => {
    const stored = await getLastParkedLocation();
    if (!stored) {
      setParkingError('No parked location saved yet.');
      return;
    }

    let next = stored;
    if (!stored.address) {
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(stored.lat)}&lon=${encodeURIComponent(stored.lng)}`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (response.ok) {
          const data = await response.json();
          next = { ...stored, address: data.display_name || `${stored.lat.toFixed(5)}, ${stored.lng.toFixed(5)}` };
          await saveLastParkedLocation(next);
        }
      } catch {
        next = { ...stored, address: `${stored.lat.toFixed(5)}, ${stored.lng.toFixed(5)}` };
      }
    }

    setParkedLocation(next);
    setParkingError(null);
    setPlaybackMode(false);
  };

  return (
    <div className="space-y-5 pb-4">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-grotesk font-bold">Map</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {selectedTrip ? 'Focused route view' : `Showing ${completed.length} filtered route${completed.length === 1 ? '' : 's'}`}
        </p>
      </motion.div>

      <div className="flex gap-2">
        <button onClick={() => setPlaybackMode(false)}
          className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-all ${!playbackMode ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground hover:border-primary/40'}`}>
          Map View
        </button>
        <button onClick={() => setPlaybackMode(true)}
          className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-all flex items-center justify-center gap-1.5 ${playbackMode ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground hover:border-primary/40'}`}>
          <Play className="w-3.5 h-3.5" /> Playback
        </button>
      </div>

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
        {playbackMode ? (
          selectedTrip ? (
            <>
              {compareOptions.length > 0 && (
                <select
                  value={secondaryTripId}
                  onChange={(event) => setSecondaryTripId(event.target.value)}
                  className="mb-3 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground outline-none"
                >
                  <option value="">Compare with previous run</option>
                  {compareOptions.map((trip) => (
                    <option key={trip.id} value={trip.id}>{formatDate(trip.start_time)} · {formatDistance(trip.distance_km || 0, units)}</option>
                  ))}
                </select>
              )}
              <TripPlayback trip={selectedTrip} secondaryTrip={secondaryTrip} height="380px" />
            </>
          ) : (
            <div className="rounded-2xl border border-border bg-secondary/30 flex items-center justify-center h-48">
              <p className="text-muted-foreground text-sm">Select a trip below to start playback</p>
            </div>
          )
        ) : (
          <div className="rounded-2xl overflow-hidden border border-border shadow-sm relative">
            <TripMap
              routes={mapRoutes}
              events={selectedEvents}
              showCurrentLocation={showCurrentLoc}
              currentLocation={currentLocation}
              parkedLocation={parkedLocation}
              showDangerZones={showDangerZones}
              dangerZones={dangerZones}
              showRouteRisk={showRouteRisk && Boolean(selectedTrip)}
              routeRiskSegments={selectedRiskSegments}
              showSpeedLimits={showSpeedLimits && Boolean(selectedTrip)}
              height="400px"
            />
            <div className="absolute top-3 right-3 flex flex-col gap-2 z-10">
              <button onClick={handleShowMyLocation}
                className="w-10 h-10 bg-card/90 backdrop-blur rounded-xl border border-border shadow flex items-center justify-center hover:bg-card transition-colors"
                title="Show my location">
                <Crosshair className="w-4 h-4 text-primary" />
              </button>
              <button onClick={handleWhereParked}
                className="w-10 h-10 bg-card/90 backdrop-blur rounded-xl border border-border shadow flex items-center justify-center hover:bg-card transition-colors"
                title="Where did I park?">
                <Car className="w-4 h-4 text-orange-500" />
              </button>
            </div>
            {parkedLocation && (
              <div className="absolute bottom-3 right-3 left-3 z-10 rounded-2xl border border-border bg-card/95 p-3 text-xs shadow backdrop-blur">
                <div className="font-semibold text-foreground">📍 Parked here · {relativeTime(parkedLocation.timestamp)}</div>
                <div className="mt-1 line-clamp-2 text-muted-foreground">
                  {parkedLocation.address || `${parkedLocation.lat.toFixed(5)}, ${parkedLocation.lng.toFixed(5)}`}
                </div>
              </div>
            )}
          </div>
        )}

        {(locError || parkingError) && (
          <div className="flex items-center gap-2 mt-2 text-xs text-red-500">
            <AlertCircle className="w-3.5 h-3.5" />
            {locError || parkingError}
          </div>
        )}
      </motion.div>

      {selectedTrip && (
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-sm">{formatDate(selectedTrip.start_time)}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {formatDistance(selectedTrip.distance_km || 0, units)} - {selectedTrip.route_points?.length || 0} GPS points - {selectedTrip.driving_events?.length || 0} events
              </div>
            </div>
            <button
              onClick={() => setSelectedTripId(null)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-secondary text-muted-foreground hover:text-foreground"
            >
              Show all
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-green-500 rounded-full" />
          Start
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-red-500 rounded-full" />
          End
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-blue-500 rounded-full" />
          Your location
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-orange-400 rounded-full" />
          Event marker
        </div>
        {dangerZones.length > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 bg-red-500 rounded-full opacity-70" />
            Danger zone
          </div>
        )}
        {selectedHasSpeedLimits && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 bg-emerald-500 rounded-full" />
            OSM speed limit
          </div>
        )}
      </div>

      {selectedTrip && (
        <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" />
            <h2 className="font-semibold">Map layers</h2>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <button
              onClick={() => setShowSpeedLimits(value => !value)}
              disabled={!selectedHasSpeedLimits}
              className={`rounded-xl border p-3 text-left text-xs font-semibold transition-all disabled:opacity-50 ${
                showSpeedLimits ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border-border bg-secondary/40 text-muted-foreground'
              }`}
            >
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4" />
                OSM speed limits
              </div>
              <div className="mt-1 font-normal">
                {selectedHasSpeedLimits ? `${selectedSpeedLimitCoverage}% route coverage` : 'Open a trip detail and refresh context'}
              </div>
            </button>
            <button
              onClick={() => setShowRouteRisk(value => !value)}
              disabled={!selectedTrip}
              className={`rounded-xl border p-3 text-left text-xs font-semibold transition-all disabled:opacity-50 ${
                showRouteRisk ? 'border-orange-500 bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300' : 'border-border bg-secondary/40 text-muted-foreground'
              }`}
            >
              Route risk
              <div className="mt-1 font-normal">{selectedRiskSegments.length} matched segments</div>
            </button>
            <button
              onClick={() => setShowDangerZones(value => !value)}
              className={`rounded-xl border p-3 text-left text-xs font-semibold transition-all ${
                showDangerZones ? 'border-red-500 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' : 'border-border bg-secondary/40 text-muted-foreground'
              }`}
            >
              Risk hotspots
              <div className="mt-1 font-normal">{dangerZones.length} local zones</div>
            </button>
          </div>
          {!selectedHasSpeedLimits && (
            <div className="mt-3 rounded-2xl border border-dashed border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
              <div>{describeOsmSpeedLimitStatus(selectedTrip.speed_limit_context)}</div>
              <button
                type="button"
                onClick={() => contextMutation.mutate()}
                disabled={contextMutation.isPending || !selectedTrip.route_points?.length}
                className="mt-2 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
              >
                {contextMutation.isPending ? 'Refreshing...' : 'Refresh OSM Context'}
              </button>
              {contextMutation.isError && (
                <div className="mt-2 text-orange-600 dark:text-orange-300">
                  {contextMutation.error?.message || 'Could not refresh OSM context.'}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="rounded-3xl border border-border bg-card p-5 shadow-sm">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-base">Risk Hotspots</h2>
            <p className="mt-1 text-xs text-muted-foreground">Places where harsh braking, speeding, or sharp turns repeat</p>
          </div>
          <button
            onClick={() => setShowDangerZones(true)}
            disabled={dangerZones.length === 0}
            className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
          >
            Show on map
          </button>
        </div>
        {dangerZones.length === 0 ? (
          <div className="rounded-2xl bg-secondary/50 p-4 text-sm text-muted-foreground">
            No risk hotspots yet. The app will highlight a place here after the same area has repeated harsh brakes, speeding, or sharp turns.
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-3">
            {dangerZones.slice(0, 6).map((zone) => (
              <div key={zone.id} className="rounded-2xl bg-secondary/50 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold capitalize">{String(zone.dominantType || 'risk').replace(/_/g, ' ')}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${
                    zone.riskLevel === 'critical' || zone.riskLevel === 'high'
                      ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                      : 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                  }`}>
                    {zone.riskLevel}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {zone.eventCount} repeated event{zone.eventCount === 1 ? '' : 's'} near {Number(zone.lat).toFixed(4)}, {Number(zone.lng).toFixed(4)}
                </div>
                {zone.lastSeen && (
                  <div className="mt-1 text-[11px] text-muted-foreground">Last seen {relativeTime(zone.lastSeen)}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3 gap-3">
          <h2 className="font-semibold text-base">Select Trip</h2>
          <div className="flex items-center gap-1.5 overflow-x-auto thin-scrollbar">
            <Filter className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <div className="flex gap-1">
              {MAP_FILTERS.map(f => (
                <button key={f.id} onClick={() => { setMapFilter(f.id); setSelectedTripId(null); }}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all whitespace-nowrap ${
                    mapFilter === f.id ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                  }`}>
                  {f.label}
                </button>
              ))}
              <button
                onClick={() => setShowDangerZones(value => !value)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all whitespace-nowrap ${
                  showDangerZones ? 'bg-red-500 text-white border-red-500' : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                Risk hotspots
              </button>
              <button
                onClick={() => setShowRouteRisk(value => !value)}
                disabled={!selectedTrip}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all whitespace-nowrap disabled:opacity-50 ${
                  showRouteRisk ? 'bg-orange-500 text-white border-orange-500' : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                Route risk
              </button>
              <button
                onClick={() => setShowSpeedLimits(value => !value)}
                disabled={!selectedTrip || !selectedHasSpeedLimits}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all whitespace-nowrap disabled:opacity-50 ${
                  showSpeedLimits ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                OSM speed
              </button>
            </div>
          </div>
        </div>

        {completed.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-center">
            <Car className="w-10 h-10 text-muted-foreground mb-3" />
            <div className="text-muted-foreground text-sm">No trips with GPS data yet</div>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              onClick={() => setSelectedTripId(null)}
              className={`w-full p-3 rounded-xl border text-sm text-left transition-all ${
                !selectedTripId ? 'border-primary bg-primary/5 text-primary font-medium' : 'border-border bg-card text-muted-foreground hover:border-primary/40'
              }`}
            >
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                Show all filtered trips
              </div>
            </button>

            {completed.slice(0, 30).map(trip => {
              const { color } = getScoreColor(trip.score_overall || 0);
              return (
                <button
                  key={trip.id}
                  onClick={() => setSelectedTripId(trip.id)}
                  className={`w-full p-3 rounded-xl border text-sm text-left transition-all ${
                    selectedTripId === trip.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-card hover:border-primary/40'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{formatDate(trip.start_time)}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {formatDistance(trip.distance_km || 0, units)} - {trip.route_points?.length} GPS points - {trip.driving_events?.length || 0} events
                      </div>
                    </div>
                    <div className={`font-grotesk font-bold text-xl ${color}`}>
                      {trip.score_overall || '-'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="bg-secondary/50 rounded-2xl p-4 text-xs text-muted-foreground">
        <div className="font-medium text-foreground mb-1">About the Map</div>
        Map tiles provided by <strong>OpenStreetMap</strong> contributors via Leaflet. Event markers appear when a single trip is selected.
      </div>
    </div>
  );
}
