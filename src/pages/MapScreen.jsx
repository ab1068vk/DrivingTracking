import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { MapPin, Crosshair, Car, AlertCircle, Play, Filter } from 'lucide-react';
import TripMap from '@/components/TripMap';
import TripPlayback from '@/components/TripPlayback';
import { formatDistance, formatDate, getScoreColor } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { getCurrentLocation } from '@/lib/trackingService';

const MAP_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'night', label: 'Night' },
  { id: 'harsh_braking', label: 'Harsh Braking' },
];

const MAP_ROUTE_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#06b6d4', '#ef4444'];

export default function MapScreen() {
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [showCurrentLoc, setShowCurrentLoc] = useState(false);
  const [locError, setLocError] = useState(null);
  const [mapFilter, setMapFilter] = useState('all');
  const [playbackMode, setPlaybackMode] = useState(false);
  const settings = localSettings.get();
  const units = settings.units || 'metric';

  const { data: trips = [] } = useQuery({
    queryKey: ['map-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 500 }),
  });

  const allCompleted = trips.filter(t => t.status === 'completed' && t.route_points?.length > 1);
  const completed = allCompleted.filter(t => {
    if (mapFilter === 'night') return t.night_driving;
    if (mapFilter === 'harsh_braking') return (t.harsh_brakes_count || 0) > 0;
    return true;
  });
  const selectedTrip = allCompleted.find(t => t.id === selectedTripId);
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
            <TripPlayback trip={selectedTrip} height="380px" />
          ) : (
            <div className="rounded-2xl border border-border bg-secondary/30 flex items-center justify-center h-48">
              <p className="text-muted-foreground text-sm">Select a trip below to start playback</p>
            </div>
          )
        ) : (
          <div className="rounded-2xl overflow-hidden border border-border shadow-sm relative">
            <TripMap
              routes={mapRoutes}
              events={selectedTrip?.driving_events || []}
              showCurrentLocation={showCurrentLoc}
              currentLocation={currentLocation}
              height="400px"
            />
            <div className="absolute top-3 right-3 flex flex-col gap-2 z-10">
              <button onClick={handleShowMyLocation}
                className="w-10 h-10 bg-card/90 backdrop-blur rounded-xl border border-border shadow flex items-center justify-center hover:bg-card transition-colors"
                title="Show my location">
                <Crosshair className="w-4 h-4 text-primary" />
              </button>
            </div>
          </div>
        )}

        {locError && (
          <div className="flex items-center gap-2 mt-2 text-xs text-red-500">
            <AlertCircle className="w-3.5 h-3.5" />
            {locError}
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
