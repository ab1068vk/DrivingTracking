import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Navigation, Clock, Gauge, TrendingDown, Zap, Car,
  CornerUpRight, AlertTriangle, Moon, Trash2, Fuel, Leaf
} from 'lucide-react';
import ScoreRing from '@/components/ScoreRing';
import TripMap from '@/components/TripMap';
import { formatDistance, formatDuration, formatDateTime, formatSpeed, getScoreColor } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { estimateTripEconomics } from '@/lib/tripInsights';

export default function TripDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const settings = localSettings.get();
  const units = settings.units || 'metric';

  const { data: trip, isLoading } = useQuery({
    queryKey: ['trip', id],
    queryFn: () => tripService.getById(id),
  });

  const { data: vehicles = [] } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 100 }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => tripService.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['all-trips'] });
      qc.invalidateQueries({ queryKey: ['recent-trips'] });
      navigate('/trips');
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4 pb-4">
        <div className="h-8 bg-secondary/50 rounded-xl animate-pulse w-32" />
        <div className="h-64 bg-secondary/50 rounded-2xl animate-pulse" />
        <div className="h-32 bg-secondary/50 rounded-2xl animate-pulse" />
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <AlertTriangle className="w-12 h-12 text-muted-foreground mb-4" />
        <div className="font-semibold">Trip not found</div>
        <button onClick={() => navigate('/trips')} className="mt-4 text-primary text-sm">
          Back to trips
        </button>
      </div>
    );
  }

  const { color, label: scoreLabel, bg } = getScoreColor(trip.score_overall || 0);
  const tripVehicle = vehicles.find((vehicle) => String(vehicle.id) === String(trip.vehicle_id));
  const economics = estimateTripEconomics(trip, tripVehicle, settings);

  return (
    <div className="space-y-5 pb-4">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <button
          onClick={() => navigate('/trips')}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="text-sm">Back</span>
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => {
              if (confirm('Delete this trip? This cannot be undone.')) deleteMutation.mutate();
            }}
            className="p-2 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 rounded-xl transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </motion.div>

      {/* Map */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
        <div className="rounded-2xl overflow-hidden border border-border shadow-sm">
          <TripMap
            routePoints={trip.route_points || []}
            events={trip.driving_events || []}
            height="300px"
          />
        </div>
      </motion.div>

      {/* Score overview */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="bg-card border border-border rounded-3xl p-5 shadow-sm"
      >
        <div className="flex items-center gap-6">
          <ScoreRing score={trip.score_overall || 0} size={100} strokeWidth={8} sublabel="overall" />
          <div className="flex-1 grid grid-cols-3 gap-3">
            {[
              { label: 'Safety', value: trip.score_safety },
              { label: 'Smooth', value: trip.score_smoothness },
              { label: 'Eco', value: trip.score_eco },
            ].map(({ label, value }) => {
              const { color: c } = getScoreColor(value || 0);
              return (
                <div key={label} className="text-center">
                  <div className={`font-grotesk font-bold text-xl ${c}`}>{value ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              );
            })}
          </div>
        </div>
      </motion.div>

      {/* Trip metadata */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="bg-card border border-border rounded-3xl p-5 shadow-sm space-y-4"
      >
        <h2 className="font-semibold">Trip Details</h2>

        <div className="grid grid-cols-2 gap-4">
          {[
            { icon: Navigation, label: 'Distance', value: formatDistance(trip.distance_km || 0, units) },
            { icon: Clock, label: 'Duration', value: formatDuration(trip.duration_seconds) },
            { icon: Gauge, label: 'Avg Speed', value: formatSpeed(trip.avg_speed_kmh || 0, units) },
            { icon: Gauge, label: 'Max Speed', value: formatSpeed(trip.max_speed_kmh || 0, units) },
            { icon: Fuel, label: 'Fuel Cost', value: `$${economics.cost.toFixed(2)}` },
            { icon: Leaf, label: 'CO2', value: `${economics.co2_kg.toFixed(1)} kg` },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-start gap-3 p-3 bg-secondary/50 rounded-xl">
              <Icon className="w-4 h-4 text-muted-foreground mt-0.5" />
              <div>
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="font-semibold text-sm">{value}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <div className="w-2.5 h-2.5 bg-green-500 rounded-full" />
            <span className="text-muted-foreground">Start:</span>
            <span className="font-medium">{formatDateTime(trip.start_time)}</span>
          </div>
          {trip.end_time && (
            <div className="flex items-center gap-2 text-sm">
              <div className="w-2.5 h-2.5 bg-red-500 rounded-full" />
              <span className="text-muted-foreground">End:</span>
              <span className="font-medium">{formatDateTime(trip.end_time)}</span>
            </div>
          )}
          {trip.night_driving && (
            <div className="flex items-center gap-2 text-sm text-purple-600 dark:text-purple-400">
              <Moon className="w-4 h-4" />
              <span>Night driving detected</span>
            </div>
          )}
          {tripVehicle && (
            <div className="flex items-center gap-2 text-sm">
              <Car className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">Vehicle:</span>
              <span className="font-medium">{tripVehicle.name}</span>
            </div>
          )}
        </div>
      </motion.div>

      {/* Driving Events */}
      {trip.driving_events && trip.driving_events.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="bg-card border border-border rounded-3xl p-5 shadow-sm"
        >
          <h2 className="font-semibold mb-4">
            Driving Events
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {trip.driving_events.length} detected
            </span>
          </h2>

          {/* Summary counts */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            {[
              { label: 'Harsh Brakes', value: trip.harsh_brakes_count, icon: TrendingDown, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-950/30' },
              { label: 'Rapid Accel', value: trip.rapid_accel_count, icon: Zap, color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30' },
              { label: 'Sharp Turns', value: trip.sharp_turns_count, icon: CornerUpRight, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
              { label: 'Speeding', value: trip.speeding_events_count, icon: AlertTriangle, color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
            ].map(({ label, value, icon: Icon, color, bg }) => (
              <div key={label} className={`${bg} rounded-xl p-3 flex items-center gap-3`}>
                <Icon className={`w-5 h-5 ${color}`} />
                <div>
                  <div className={`font-grotesk font-bold text-xl ${color}`}>{value || 0}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Event list */}
          <div className="space-y-2 max-h-64 overflow-y-auto thin-scrollbar">
            {trip.driving_events.map((evt, i) => {
              const labels = {
                harsh_brake: { label: 'Harsh Brake', icon: '🛑', color: 'text-red-600' },
                rapid_acceleration: { label: 'Rapid Acceleration', icon: '⚡', color: 'text-yellow-600' },
                sharp_turn: { label: 'Sharp Turn', icon: '↰', color: 'text-blue-600' },
                speeding: { label: 'Speeding', icon: '🚀', color: 'text-orange-600' },
                idle: { label: 'Excessive Idle', icon: '⏸', color: 'text-slate-500' },
              };
              const cfg = labels[evt.type] || { label: evt.type, icon: '⚠', color: 'text-foreground' };
              return (
                <div key={i} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg">{cfg.icon}</span>
                    <div>
                      <div className={`text-sm font-medium ${cfg.color}`}>{cfg.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(evt.timestamp).toLocaleTimeString()} · {evt.value?.toFixed(1)} {evt.type === 'idle' ? 's' : evt.type === 'speeding' ? 'km/h' : 'm/s²'}
                      </div>
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize
                    ${evt.severity === 'high' ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400' :
                      evt.severity === 'medium' ? 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400' :
                      'bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400'}`}>
                    {evt.severity}
                  </span>
                </div>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* Route Points summary */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="bg-secondary/50 rounded-2xl px-5 py-3 flex items-center justify-between"
      >
        <span className="text-sm text-muted-foreground">Route Points</span>
        <span className="text-sm font-semibold">{trip.route_points?.length || 0} GPS readings</span>
      </motion.div>
    </div>
  );
}
