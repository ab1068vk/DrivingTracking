import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { tripQueryKeys, tripService } from '@/api/trips';
import { MapPin, Crosshair, Car, AlertCircle, Play, Filter, Gauge, Layers, ChevronLeft, ChevronRight, Shield } from 'lucide-react';
import TripMap from '@/components/TripMap';
import TripPlayback from '@/components/TripPlayback';
import { formatDistance, formatDate, getScoreColor, getTripComponentScore, prefetchLocalKnowledge } from '@/lib/tripEngine';
import { formatScoreWithProvenance } from '@/lib/scoreDisplay';
import { getLastParkedLocation, localSettings, saveLastParkedLocation } from '@/lib/trackingStore';
import { getCurrentLocation } from '@/lib/trackingService';
import { LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { saveDangerZones } from '@/lib/dangerZoneEngine';
import { buildRouteRiskIndex, getSegmentsForTrip, loadRouteRiskIndex, saveRouteRiskIndex } from '@/lib/routeRiskIndex';
import { buildRiskHotspots, routeKeyForTrip } from '@/lib/mediumInsights';
import {
  buildRoadDataDisabledMessage,
  buildRoadContextPrivacyMessage,
  describeMapMatchingStatus,
  describeOsmSpeedLimitStatus,
  isOsrmMapMatchingConfigured,
  isRoadDataLookupConfigured,
} from '@/lib/openSourceTripContext';
import { runRoadContextRefresh } from '@/lib/roadContextQueue';
import { getPrivacyZones, isPointInPrivacyZone } from '@/lib/privacyZones';
import { MAX_VISIBLE_DANGER_ZONES } from '@/lib/appConstants';
import { pinnedFetch } from '@/lib/pinnedFetch';
import useLocalSettings from '@/hooks/useLocalSettings';

const MAP_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'night', label: 'Night' },
  { id: 'harsh_braking', label: 'Harsh Braking' },
];

const MAP_ROUTE_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#06b6d4', '#ef4444'];
const TRIP_CARD_PAGE_SIZE = 30;
const MAP_OVERVIEW_ROUTE_LIMIT = 24;
const scheduleIdleWork = (callback) => {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const idleId = window.requestIdleCallback(callback, { timeout: 1000 });
    return () => window.cancelIdleCallback?.(idleId);
  }

  const timer = setTimeout(callback, 120);
  return () => clearTimeout(timer);
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

const tripPointSummary = (trip) => {
  const mapPoints = trip?.route_points?.length || 0;
  const recorded = Number(trip?.route_points_raw_count) || mapPoints;
  return recorded !== mapPoints
    ? `${recorded} GPS readings - ${mapPoints} map/playback points`
    : `${mapPoints} GPS points`;
};

const completedTripSummaryLabel = (count) => (
  `${count} completed trip summar${count === 1 ? 'y' : 'ies'}`
);

const hasPlayableRouteGps = (trip) => (trip?.route_points?.length || 0) > 1;
const hasReplayableRoute = (trip) => (
  hasPlayableRouteGps(trip) || trip?.route_replay_available === true
);
const tripRouteKey = (trip) => trip?.route_key || routeKeyForTrip(trip);

export default function MapScreen() {
  const qc = useQueryClient();
  const navigate = useNavigate();
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
  const [showLayerPanel, setShowLayerPanel] = useState(true);
  const [showAllDangerZones, setShowAllDangerZones] = useState(false);
  const [osmFetchStatus, setOsmFetchStatus] = useState('');
  const [tripListPage, setTripListPage] = useState(0);
  const [speedLimitKnowledgeRevision, setSpeedLimitKnowledgeRevision] = useState(0);
  const [speedLimitLocalKnowledgeResults, setSpeedLimitLocalKnowledgeResults] = useState([]);
  const settings = useLocalSettings();
  const units = settings.units || 'metric';
  const privacyZones = useMemo(() => getPrivacyZones(settings), [settings]);
  const privacyZonesKey = useMemo(() => JSON.stringify(privacyZones.map((zone) => [
    zone.id,
    Number(zone.lat),
    Number(zone.lng),
    Number(zone.radius_m),
  ])), [privacyZones]);
  const osrmConfigured = isOsrmMapMatchingConfigured(settings);

  const { data: trips = [], isLoading: tripsLoading } = useQuery({
    queryKey: tripQueryKeys.map,
    queryFn: () => tripService.listSummaries({ sort: '-start_time', limit: 500 }),
    staleTime: 2 * 60 * 1000,
  });
  const contextMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTrip) throw new Error('Select a trip first.');
      if (!hasPlayableRouteGps(selectedTrip)) throw new Error('Wait for this trip route to finish loading.');
      setOsmFetchStatus('Preparing road data');
      return runRoadContextRefresh(selectedTrip, localSettings.get(), {
        onProgress: setOsmFetchStatus,
      });
    },
    onSuccess: (updatedTrip) => {
      if (updatedTrip) {
        qc.setQueryData(tripQueryKeys.detail(updatedTrip.id), updatedTrip);
        qc.setQueryData(tripQueryKeys.map, (old = []) => (
          Array.isArray(old) ? old.map((trip) => String(trip.id) === String(updatedTrip.id) ? updatedTrip : trip) : old
        ));
      }
      qc.invalidateQueries({ queryKey: tripQueryKeys.map });
      qc.invalidateQueries({ queryKey: tripQueryKeys.summaries });
      if (selectedTripId) qc.invalidateQueries({ queryKey: tripQueryKeys.detail(selectedTripId) });
      const hasSpeedLimits = (updatedTrip?.route_points || []).some((point) => Number.isFinite(Number(point.speed_limit_kmh)));
      setShowSpeedLimits(hasSpeedLimits);
    },
    onError: (error) => {
      setOsmFetchStatus(error?.message || 'Could not get road data');
    },
    onSettled: () => {
      setTimeout(() => setOsmFetchStatus(''), 2500);
    },
  });

  const completedSummaries = useMemo(
    () => trips.filter(t => t.status === 'completed'),
    [trips]
  );
  const allCompleted = useMemo(
    () => completedSummaries.filter(hasReplayableRoute),
    [completedSummaries]
  );
  const retentionRemovedRouteCount = completedSummaries.filter(t => (
    t.route_data_expired_at && !hasPlayableRouteGps(t)
  )).length;
  const completed = useMemo(() => allCompleted.filter(t => {
    if (mapFilter === 'night') return t.night_driving;
    if (mapFilter === 'harsh_braking') return (t.harsh_brakes_count || 0) > 0;
    return true;
  }), [allCompleted, mapFilter]);
  const selectedTripSummary = useMemo(
    () => allCompleted.find(t => t.id === selectedTripId),
    [allCompleted, selectedTripId]
  );
  const secondaryTripSummary = useMemo(
    () => allCompleted.find(t => String(t.id) === String(secondaryTripId)),
    [allCompleted, secondaryTripId]
  );
  const { data: selectedTripDetail, isFetching: selectedTripLoading } = useQuery({
    queryKey: tripQueryKeys.detail(selectedTripId || 'none'),
    queryFn: () => tripService.getById(selectedTripId),
    enabled: Boolean(selectedTripId),
    staleTime: 2 * 60 * 1000,
  });
  const { data: secondaryTripDetail } = useQuery({
    queryKey: tripQueryKeys.detail(secondaryTripId || 'none'),
    queryFn: () => tripService.getById(secondaryTripId),
    enabled: Boolean(secondaryTripId),
    staleTime: 2 * 60 * 1000,
  });
  const overviewTripsForMap = useMemo(
    () => selectedTripId ? [] : completed.slice(0, MAP_OVERVIEW_ROUTE_LIMIT),
    [completed, selectedTripId]
  );
  const overviewTripDetails = useQueries({
    queries: overviewTripsForMap.map((trip) => ({
      queryKey: tripQueryKeys.detail(trip.id),
      queryFn: () => tripService.getById(trip.id),
      staleTime: 2 * 60 * 1000,
    })),
  });
  const overviewMapTrips = useMemo(
    () => overviewTripDetails.map((query) => query.data).filter(hasPlayableRouteGps),
    [overviewTripDetails]
  );
  const selectedTrip = selectedTripDetail || selectedTripSummary || null;
  const secondaryTrip = secondaryTripDetail || secondaryTripSummary || null;
  const selectedEvents = useMemo(() => (
    settings.phone_use_show_on_map === false
      ? (selectedTrip?.driving_events || []).filter((event) => event.type !== 'phone_use')
      : (selectedTrip?.driving_events || [])
  ), [selectedTrip, settings.phone_use_show_on_map]);
  const selectedSpeedLimitCoverage = selectedTrip?.speed_limit_context?.coverage ?? 0;
  const selectedHasTripSpeedLimits = (selectedTrip?.route_points || []).some((point) => Number.isFinite(Number(point.speed_limit_kmh)));
  const selectedHasLocalSpeedLimits = speedLimitLocalKnowledgeResults.some((item) => Number(item?.limitKmh) > 0);
  const selectedHasSpeedLimits = selectedHasTripSpeedLimits || selectedHasLocalSpeedLimits;
  const selectedRouteReady = !selectedTripId || hasPlayableRouteGps(selectedTripDetail);
  const selectedSpeedLimitStatus = selectedTrip?.speed_limit_context?.status || 'not_fetched';
  const selectedMapMatchingStatus = selectedTrip?.map_matching_context?.status || 'not_fetched';
  const speedLimitLookupEnabled = settings.speed_limit_lookup_enabled !== false;

  useEffect(() => {
    let cancelled = false;
    const loadLocalSpeedKnowledge = async () => {
      const points = Array.isArray(selectedTrip?.route_points) ? selectedTrip.route_points : [];
      if (!points.length) {
        if (!cancelled) setSpeedLimitLocalKnowledgeResults([]);
        return;
      }
      const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
      const results = await prefetchLocalKnowledge(points, knowledge).catch(() => points.map(() => null));
      if (!cancelled) setSpeedLimitLocalKnowledgeResults(results);
    };
    loadLocalSpeedKnowledge();
    return () => {
      cancelled = true;
    };
  }, [selectedTrip?.id, selectedTrip?.route_points, speedLimitKnowledgeRevision]);

  useEffect(() => {
    const onSpeedKnowledgeChanged = () => {
      setSpeedLimitKnowledgeRevision((value) => value + 1);
    };
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onSpeedKnowledgeChanged);
    return () => window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onSpeedKnowledgeChanged);
  }, []);

  const selectedLayerEffect = !selectedTrip
    ? 'Select a trip to get road data.'
    : !selectedRouteReady
      ? 'Loading this trip route...'
    : selectedHasSpeedLimits
      ? 'Turning the layer on recolors the selected route: green is within the matched/default limit, orange is over, red is well over.'
      : !speedLimitLookupEnabled
        ? 'Speed-limit lookup is off in Settings. Get Road Data can still run other enabled lookups, but it will not add OpenStreetMap speed limits.'
      : selectedSpeedLimitStatus === 'unavailable'
        ? selectedTrip.speed_limit_context?.error || 'The OSM speed-limit lookup failed, so the map is still using GPS speed bands and fallback scoring thresholds.'
      : selectedSpeedLimitStatus === 'not_fetched' || selectedSpeedLimitStatus === 'manual_required'
        ? 'Before fetching, the map shows only GPS speed bands and event markers. Get road data to look for posted limits.'
        : 'No speed-limit layer is available for this trip, so the map will not visibly change until OSM returns matched limits.';
  const selectedRiskSegments = useMemo(() => (
    selectedTrip ? getSegmentsForTrip(selectedTrip, routeRiskIndex) : []
  ), [routeRiskIndex, selectedTrip]);
  const overlaySourceTrips = useMemo(
    () => selectedTripDetail ? [selectedTripDetail, ...overviewMapTrips] : overviewMapTrips,
    [overviewMapTrips, selectedTripDetail]
  );
  const visibleDangerZones = useMemo(
    () => dangerZones.filter((zone) => !isPointInPrivacyZone(zone, privacyZones)),
    [dangerZones, privacyZones]
  );
  const displayedDangerZones = showAllDangerZones
    ? visibleDangerZones
    : visibleDangerZones.slice(0, MAX_VISIBLE_DANGER_ZONES);
  const hiddenDangerZoneCount = visibleDangerZones.length - displayedDangerZones.length;
  const parkedLocationIsPrivate = parkedLocation && isPointInPrivacyZone(parkedLocation, privacyZones);
  const commuteRouteCounts = useMemo(() => {
    const counts = new Map();
    allCompleted.forEach((trip) => {
      const key = tripRouteKey(trip);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }, [allCompleted]);
  const compareOptions = useMemo(() => {
    if (!selectedTrip) return [];
    const selectedKey = tripRouteKey(selectedTrip);
    if (!selectedKey || (commuteRouteCounts.get(selectedKey) || 0) < 3) return [];
    const routeRuns = allCompleted
      .filter((trip) => String(trip.id) !== String(selectedTrip.id) && tripRouteKey(trip) === selectedKey)
      .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
    const bestRun = [...routeRuns].sort((a, b) => (
      (getTripComponentScore(b, 'overall').value ?? Number.NEGATIVE_INFINITY) -
      (getTripComponentScore(a, 'overall').value ?? Number.NEGATIVE_INFINITY)
    ))[0];
    const recentRuns = routeRuns.slice(0, 5);
    return [
      ...(bestRun ? [{ ...bestRun, compareLabel: `Best run - score ${formatScoreWithProvenance(getTripComponentScore(bestRun, 'overall').value, bestRun.score_provenance)}` }] : []),
      ...recentRuns
        .filter((trip) => String(trip.id) !== String(bestRun?.id))
        .map((trip) => ({ ...trip, compareLabel: `${formatDate(trip.start_time)} - ${formatDistance(trip.distance_km || 0, units)}` })),
    ].slice(0, 6);
  }, [allCompleted, commuteRouteCounts, selectedTrip, units]);
  const mapRoutes = useMemo(() => (
    selectedTripDetail
      ? [{
        id: selectedTripDetail.id,
        route_points: selectedTripDetail.route_points,
        rawPointCount: selectedTripDetail.route_points_raw_count,
        selected: true,
        color: '#3b82f6',
        label: formatDate(selectedTripDetail.start_time),
      }]
      : overviewMapTrips.map((trip, index) => ({
        id: trip.id,
        route_points: trip.route_points,
        rawPointCount: trip.route_points_raw_count,
        selected: false,
        color: MAP_ROUTE_COLORS[index % MAP_ROUTE_COLORS.length],
        label: formatDate(trip.start_time),
      }))
  ), [overviewMapTrips, selectedTripDetail]);
  const tripPageCount = Math.max(1, Math.ceil(completed.length / TRIP_CARD_PAGE_SIZE));
  const safeTripListPage = Math.min(tripListPage, tripPageCount - 1);
  const tripPageStart = safeTripListPage * TRIP_CARD_PAGE_SIZE;
  const visibleTripCards = completed.slice(tripPageStart, tripPageStart + TRIP_CARD_PAGE_SIZE);
  const tripPageEnd = tripPageStart + visibleTripCards.length;
  const mapOverviewHiddenCount = selectedTripId ? 0 : Math.max(0, completed.length - overviewTripsForMap.length);

  const confirmAndFetchRoadContext = () => {
    if (!selectedTrip || !hasPlayableRouteGps(selectedTrip)) return;
    const latestSettings = localSettings.get();
    if (!isRoadDataLookupConfigured(latestSettings)) {
      if (typeof window !== 'undefined') window.alert(buildRoadDataDisabledMessage(latestSettings));
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm(buildRoadContextPrivacyMessage(latestSettings))) {
      return;
    }
    contextMutation.mutate();
  };

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
    setTripListPage(0);
  }, [mapFilter]);

  useEffect(() => {
    if (tripListPage > tripPageCount - 1) setTripListPage(Math.max(0, tripPageCount - 1));
  }, [tripListPage, tripPageCount]);

  useEffect(() => {
    let cancelled = false;
    const rebuildOverlays = async () => {
      if (!overlaySourceTrips.length) {
        setDangerZones([]);
        setRouteRiskIndex(new Map());
        return;
      }

      const zones = buildRiskHotspots(overlaySourceTrips);
      await saveDangerZones(zones);
      let index = await loadRouteRiskIndex(privacyZones);
      if (!index || index.size === 0) {
        index = buildRouteRiskIndex(overlaySourceTrips, privacyZones);
        await saveRouteRiskIndex(index);
      } else if (privacyZones.length) {
        await saveRouteRiskIndex(index);
      }
      if (!cancelled) {
        setDangerZones(zones);
        setRouteRiskIndex(index);
      }
    };

    const cancelScheduledWork = scheduleIdleWork(rebuildOverlays);
    return () => {
      cancelled = true;
      cancelScheduledWork();
    };
  }, [overlaySourceTrips, privacyZones, privacyZonesKey]);

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
        const response = await pinnedFetch(url, { headers: { Accept: 'application/json' } });
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
          {selectedTrip
            ? selectedTripLoading && !selectedTripDetail
              ? 'Loading focused route view'
              : 'Focused route view'
            : tripsLoading
              ? 'Loading trips...'
              : `Showing ${completed.length} filtered trip${completed.length === 1 ? '' : 's'}`}
          {!selectedTrip && mapOverviewHiddenCount > 0 && (
            <span className="block text-xs">
              Drawing the most recent {overviewTripsForMap.length} routes first for a faster map. Select any trip below for the full route.
            </span>
          )}
          {!selectedTrip && retentionRemovedRouteCount > 0 && (
            <span className="block text-xs">
              {completedTripSummaryLabel(retentionRemovedRouteCount)} {retentionRemovedRouteCount === 1 ? 'is' : 'are'} hidden from map/playback because raw GPS retention removed route coordinates.
            </span>
          )}
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
        <button
          type="button"
          onClick={() => setShowLayerPanel(value => !value)}
          className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all flex items-center justify-center gap-1.5 ${
            showLayerPanel ? 'bg-card border-primary text-primary' : 'bg-card border-border text-muted-foreground hover:border-primary/40'
          }`}
        >
          <Layers className="w-3.5 h-3.5" /> Layers
        </button>
      </div>

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
        {playbackMode ? (
          selectedTrip ? (
            <>
              {compareOptions.length > 0 && (
                <>
                  <select
                    value={secondaryTripId}
                    onChange={(event) => setSecondaryTripId(event.target.value)}
                    className="mb-3 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground outline-none"
                  >
                    <option value="">Compare with another run</option>
                    {compareOptions.map((trip) => (
                      <option key={trip.id} value={trip.id}>{trip.compareLabel || `${formatDate(trip.start_time)} - ${formatDistance(trip.distance_km || 0, units)}`}</option>
                    ))}
                  </select>
                  <div className="-mt-2 mb-3 text-xs text-muted-foreground">
                    The best-scoring matching route appears first, followed by recent runs.
                  </div>
                </>
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
              dangerZones={visibleDangerZones}
              showRouteRisk={showRouteRisk && Boolean(selectedTrip)}
              routeRiskSegments={selectedRiskSegments}
              showSpeedLimits={showSpeedLimits && Boolean(selectedTrip)}
              speedLimitKnowledgeResults={speedLimitLocalKnowledgeResults}
              rawPointCount={selectedTrip?.route_points_raw_count}
              height="400px"
            />
            {selectedTripId && selectedTripLoading && !selectedTripDetail && (
              <div className="absolute inset-x-3 bottom-3 z-10 rounded-2xl border border-border bg-card/95 px-3 py-2 text-xs font-semibold text-muted-foreground shadow backdrop-blur">
                Loading route detail...
              </div>
            )}
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
                  {parkedLocationIsPrivate
                    ? 'Inside privacy zone'
                    : parkedLocation.address || `${parkedLocation.lat.toFixed(5)}, ${parkedLocation.lng.toFixed(5)}`}
                </div>
              </div>
            )}
            {privacyZones.length > 0 && !parkedLocation && (
              <button
                type="button"
                onClick={() => navigate('/privacy-intelligence')}
                className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-xl border border-border bg-card/95 px-3 py-2 text-xs font-semibold text-primary shadow backdrop-blur transition-colors hover:bg-card"
              >
                <Shield className="h-3.5 w-3.5" />
                Privacy
              </button>
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
                {formatDistance(selectedTrip.distance_km || 0, units)} - {selectedRouteReady ? tripPointSummary(selectedTrip) : 'loading route details'} - {selectedTrip.driving_events?.length || 0} events
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

      {showLayerPanel && (
        <div className="rounded-3xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" />
            <h2 className="font-semibold">Map layers</h2>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <button
              onClick={() => {
                if (!selectedTrip) return;
                if (!selectedHasSpeedLimits) {
                  if (!speedLimitLookupEnabled) return;
                  confirmAndFetchRoadContext();
                  return;
                }
                setShowSpeedLimits(value => !value);
              }}
              disabled={!selectedTrip || !selectedRouteReady || contextMutation.isPending || (!selectedHasSpeedLimits && !speedLimitLookupEnabled)}
              className={`rounded-xl border p-3 text-left text-xs font-semibold transition-all disabled:opacity-50 ${
                showSpeedLimits ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border-border bg-secondary/40 text-muted-foreground'
              }`}
            >
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4" />
                Speed-limit layer
              </div>
              <div className="mt-1 font-normal">
                {!selectedTrip
                  ? 'Select a trip first'
                  : !selectedRouteReady
                    ? 'Loading route data'
                  : selectedHasLocalSpeedLimits
                    ? 'Saved local speeds available - tap to show or hide'
                    : selectedHasSpeedLimits
                    ? `${selectedSpeedLimitCoverage}% coverage - tap to show or hide`
                    : !speedLimitLookupEnabled
                      ? 'OpenStreetMap speed-limit lookup is off in Settings'
                    : contextMutation.isPending
                      ? osmFetchStatus || 'Getting road data...'
                      : `${selectedSpeedLimitStatus.replace(/_/g, ' ')} - tap to get road data`}
              </div>
            </button>
            <button
              onClick={() => setShowRouteRisk(value => !value)}
              disabled={!selectedTrip}
              className={`rounded-xl border p-3 text-left text-xs font-semibold transition-all disabled:opacity-50 ${
                showRouteRisk ? 'border-orange-500 bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300' : 'border-border bg-secondary/40 text-muted-foreground'
              }`}
            >
              Repeated-event layer
              <div className="mt-1 font-normal">{selectedTrip ? `${selectedRiskSegments.length} matched segments` : 'Select a trip first'}</div>
            </button>
            <button
              onClick={() => setShowDangerZones(value => !value)}
              className={`rounded-xl border p-3 text-left text-xs font-semibold transition-all ${
                showDangerZones ? 'border-red-500 bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' : 'border-border bg-secondary/40 text-muted-foreground'
              }`}
            >
              Repeated event areas
              <div className="mt-1 font-normal">{visibleDangerZones.length} local areas</div>
            </button>
          </div>
          {selectedTrip && (
            <div className="mt-3 rounded-2xl bg-secondary/40 p-3 text-xs text-muted-foreground">
              <div className="font-semibold text-foreground">Get Road Data, in plain words</div>
              <div className="mt-1">Runs only the enabled online lookups for this selected trip. Privacy-zone coordinates are excluded before anything leaves the app.</div>
              <div className="mt-2 grid gap-1">
                <div>Speed limits {settings.speed_limit_lookup_enabled === false ? 'OFF' : 'ON'}: {settings.speed_limit_lookup_enabled === false ? 'OpenStreetMap speed-limit lookup is skipped; route colors use GPS bands or any speed-limit data already saved on the trip.' : 'sends privacy-filtered public road boxes to OpenStreetMap for posted maxspeed; missing tags may use labeled estimates.'}</div>
                <div>Weather {settings.weather_context_enabled === false ? 'OFF' : 'ON'}: {settings.weather_context_enabled === false ? 'Open-Meteo is skipped; scores get no weather adjustment.' : 'sends one privacy-safe route point and trip date to Open-Meteo.'}</div>
                <div>Snap to roads {settings.map_matching_enabled === false ? 'OFF' : settings.osrm_map_matching_url && settings.osrm_data_sharing_consented === true ? 'ON' : 'NEEDS CONSENT'}: {settings.map_matching_enabled === false ? 'OSRM is skipped; map/playback keep GPS shape.' : settings.osrm_map_matching_url && settings.osrm_data_sharing_consented === true ? 'sends sampled public GPS segments to your OSRM endpoint.' : 'OSRM is skipped until a trusted endpoint and consent are saved in Settings.'}</div>
              </div>
              <div className="mt-2 rounded-xl bg-background/60 px-3 py-2 font-medium text-foreground">
                {contextMutation.isPending ? osmFetchStatus || 'Getting road data...' : selectedLayerEffect}
              </div>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                <span>Speed limits: {selectedSpeedLimitStatus.replace(/_/g, ' ')}</span>
                <span>Map matching: {selectedMapMatchingStatus.replace(/_/g, ' ')}{osrmConfigured ? '' : ' (off)'}</span>
              </div>
              {!osrmConfigured && (
                <div className="mt-2 rounded-xl bg-background/60 px-3 py-2">
                  {describeMapMatchingStatus(selectedTrip.map_matching_context || { status: 'disabled' })}
                </div>
              )}
            </div>
          )}
          {selectedTrip && !selectedHasSpeedLimits && speedLimitLookupEnabled && (
            <div className="mt-3 rounded-2xl border border-dashed border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
              <div>{describeOsmSpeedLimitStatus(selectedTrip.speed_limit_context)}</div>
              <button
                type="button"
                onClick={confirmAndFetchRoadContext}
                disabled={contextMutation.isPending || !selectedRouteReady || !selectedTrip.route_points?.length}
                className="mt-2 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
              >
                {contextMutation.isPending ? osmFetchStatus || 'Getting road data...' : 'Get Road Data'}
              </button>
              {contextMutation.isError && (
                <div className="mt-2 text-orange-600 dark:text-orange-300">
                  {contextMutation.error?.message || 'Could not get road data.'}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="rounded-3xl border border-border bg-card p-5 shadow-sm">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-base">Repeated Driving-Event Areas</h2>
            <p className="mt-1 text-xs text-muted-foreground">Your repeated harsh-braking, speeding, or sharp-turn locations</p>
          </div>
          <button
            onClick={() => setShowDangerZones(true)}
            disabled={visibleDangerZones.length === 0}
            className="rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
          >
            Show on map
          </button>
        </div>
        {visibleDangerZones.length === 0 ? (
          <div className="rounded-2xl bg-secondary/50 p-4 text-sm text-muted-foreground">
            No repeated event areas yet. The app will highlight a place here after the same area has repeated harsh brakes, speeding, or sharp turns.
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-3">
            {displayedDangerZones.map((zone) => (
              <div key={zone.id} className="rounded-2xl bg-secondary/50 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold capitalize">{String(zone.dominantType || 'risk').replace(/_/g, ' ')}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${
                    zone.riskLevel === 'critical' || zone.riskLevel === 'high'
                      ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                      : 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300'
                  }`}>
                    {zone.riskLevel} event level
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
        {visibleDangerZones.length > MAX_VISIBLE_DANGER_ZONES && (
          <button
            type="button"
            onClick={() => setShowAllDangerZones((value) => !value)}
            className="mt-3 text-xs font-semibold text-primary"
          >
            {showAllDangerZones ? 'Show fewer areas' : `Show all areas (${hiddenDangerZoneCount} hidden)`}
          </button>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3 gap-3">
          <h2 className="font-semibold text-base">Select Trip</h2>
          <div className="flex items-center gap-1.5 overflow-x-auto thin-scrollbar">
            <Filter className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <div className="flex gap-1">
              {MAP_FILTERS.map(f => (
                <button key={f.id} onClick={() => { setMapFilter(f.id); setSelectedTripId(null); setTripListPage(0); }}
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
                Event areas
              </button>
              <button
                onClick={() => setShowRouteRisk(value => !value)}
                disabled={!selectedTrip}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all whitespace-nowrap disabled:opacity-50 ${
                  showRouteRisk ? 'bg-orange-500 text-white border-orange-500' : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                Repeated-event layer
              </button>
              <button
                onClick={() => {
                  if (!selectedTrip) return;
                  if (!selectedRouteReady) return;
                  if (!selectedHasSpeedLimits) {
                    if (!speedLimitLookupEnabled) return;
                    confirmAndFetchRoadContext();
                    return;
                  }
                  setShowSpeedLimits(value => !value);
                }}
                disabled={!selectedTrip || !selectedRouteReady || contextMutation.isPending || (!selectedHasSpeedLimits && !speedLimitLookupEnabled)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all whitespace-nowrap disabled:opacity-50 ${
                  showSpeedLimits ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-card border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                Speed limits
              </button>
            </div>
          </div>
        </div>

        {completed.length === 0 ? (
          <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-secondary/30 px-5 py-10 text-center">
            <Car className="w-10 h-10 text-muted-foreground mb-3" />
            <div className="text-sm font-semibold text-foreground">No trips with playable route GPS</div>
            <div className="mt-1 max-w-md text-xs text-muted-foreground">
              {completedSummaries.length > 0
                ? `${completedTripSummaryLabel(completedSummaries.length)} ${completedSummaries.length === 1 ? 'is' : 'are'} still saved. ${retentionRemovedRouteCount > 0 ? `${retentionRemovedRouteCount} reached raw GPS retention, so map and playback are intentionally unavailable.` : 'Some trips may be summary-only or too sparse to draw safely.'}`
                : 'Recorded trips will appear here after they save enough route coordinates for map and playback.'}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {retentionRemovedRouteCount > 0 && (
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-300">
                {completedTripSummaryLabel(retentionRemovedRouteCount)} {retentionRemovedRouteCount === 1 ? 'is' : 'are'} not shown here because raw GPS retention removed route coordinates for map/playback. Summaries stay saved in Trip History.
              </div>
            )}
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

            {completed.length > TRIP_CARD_PAGE_SIZE && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-secondary/35 px-3 py-2 text-xs text-muted-foreground">
                <span>
                  Showing trips {tripPageStart + 1}-{tripPageEnd} of {completed.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setTripListPage((page) => Math.max(0, page - 1))}
                    disabled={safeTripListPage === 0}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card transition-colors hover:border-primary/40 disabled:opacity-40"
                    aria-label="Previous trip page"
                    title="Previous trip page"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <span className="min-w-12 text-center font-medium text-foreground">
                    {safeTripListPage + 1}/{tripPageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTripListPage((page) => Math.min(tripPageCount - 1, page + 1))}
                    disabled={safeTripListPage >= tripPageCount - 1}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card transition-colors hover:border-primary/40 disabled:opacity-40"
                    aria-label="Next trip page"
                    title="Next trip page"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {visibleTripCards.map(trip => {
              const overallScore = getTripComponentScore(trip, 'overall');
              const { color } = overallScore.value == null
                ? { color: 'text-muted-foreground' }
                : getScoreColor(overallScore.value);
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
                        {formatDistance(trip.distance_km || 0, units)} - {tripPointSummary(trip)} - {trip.driving_events?.length || 0} events
                      </div>
                    </div>
                    <div className={`font-grotesk font-bold text-xl ${color}`}>
                      {formatScoreWithProvenance(overallScore.value, trip.score_provenance)}
                      <div className="text-[10px] font-medium capitalize text-muted-foreground">{overallScore.evidence} evidence</div>
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
