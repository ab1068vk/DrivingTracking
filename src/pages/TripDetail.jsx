import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Navigation, Clock, Gauge, TrendingDown, Zap, Car, MapPin,
  CornerUpRight, AlertTriangle, Moon, Trash2, Fuel, Leaf, Milestone,
  Building, Shuffle, Home, Waves, ShieldCheck, Focus, TimerReset, Tag
} from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import ScoreRing from '@/components/ScoreRing';
import TripMap from '@/components/TripMap';
import { formatDistance, formatDuration, formatDateTime, formatSpeed, getScoreColor } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { calculateFatigueRisk, detectTripStops, estimateTripEconomics, suggestTripTag } from '@/lib/tripInsights';

const roadTypeConfig = {
  highway: { label: 'Highway', icon: Milestone, className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800/50' },
  urban: { label: 'Urban', icon: Building, className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800/50' },
  mixed: { label: 'Mixed', icon: Shuffle, className: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700' },
  residential: { label: 'Residential', icon: Home, className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800/50' },
};

const fatigueText = {
  significant: 'Quality dropped toward end of trip',
  moderate: 'Quality dipped; consider breaks',
  improving: 'You warmed up well',
  slight: 'Fairly consistent',
};

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
  const tagMutation = useMutation({
    mutationFn: (tag) => tripService.update(id, { tag, tag_reviewed: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trip', id] }),
  });
  const [dismissedTags, setDismissedTags] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('drivesense_dismissed_tag_suggestions') || '[]');
    } catch {
      return [];
    }
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
  const stops = detectTripStops(trip.route_points || []);
  const fatigueRisk = calculateFatigueRisk([trip], settings);
  const tagSuggestion = suggestTripTag(trip);
  const showTagSuggestion = !trip.tag &&
    ['high', 'medium'].includes(tagSuggestion.auto_tag_confidence) &&
    !dismissedTags.includes(String(trip.id));
  const dismissTagSuggestion = () => {
    const next = [...new Set([...dismissedTags, String(trip.id)])];
    setDismissedTags(next);
    localStorage.setItem('drivesense_dismissed_tag_suggestions', JSON.stringify(next));
  };
  const roadCfg = roadTypeConfig[trip.road_type];
  const RoadIcon = roadCfg?.icon;
  const fatigueChartData = Array.isArray(trip.segment_scores) && trip.segment_scores.length === 3
    ? [
      { label: 'First', score: trip.segment_scores[0] },
      { label: 'Middle', score: trip.segment_scores[1] },
      { label: 'Last', score: trip.segment_scores[2] },
    ]
    : [];
  const fatigueColor = trip.fatigue_progression === 'significant'
    ? '#ef4444'
    : trip.fatigue_progression === 'moderate'
      ? '#f59e0b'
      : '#22c55e';

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

      {showTagSuggestion && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-primary/5 border border-primary/20 rounded-2xl p-3 flex items-center gap-3"
        >
          <Tag className="w-4 h-4 text-primary" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium capitalize">Suggested tag: {tagSuggestion.auto_tag}</div>
            <div className="text-xs text-muted-foreground capitalize">{tagSuggestion.auto_tag_confidence} confidence</div>
          </div>
          <button
            onClick={() => tagMutation.mutate(tagSuggestion.auto_tag)}
            className="px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold"
          >
            Accept
          </button>
          <button
            onClick={() => {
              const next = prompt('Tag this trip as work, errands, or personal', tagSuggestion.auto_tag);
              if (next && ['work', 'errands', 'personal'].includes(next.toLowerCase())) tagMutation.mutate(next.toLowerCase());
            }}
            className="px-2.5 py-1.5 rounded-lg bg-secondary text-xs font-semibold"
          >
            Change
          </button>
          <button onClick={dismissTagSuggestion} className="px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground">
            Dismiss
          </button>
        </motion.div>
      )}

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
            { icon: Leaf, label: 'Fuel Saved', value: `${economics.fuel_saved_liters.toFixed(2)} L` },
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
          {roadCfg && (
            <div className={`inline-flex w-fit items-center gap-2 text-sm border rounded-full px-3 py-1 ${roadCfg.className}`}>
              <RoadIcon className="w-4 h-4" />
              <span>{roadCfg.label} route</span>
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

      {/* Driving behavior detail */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.22 }}
        className="bg-card border border-border rounded-3xl p-5 shadow-sm"
      >
        <h2 className="font-semibold mb-4">Driving Pattern</h2>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[
            { icon: MapPin, label: 'detected stops', value: trip.stop_count ?? stops.length, color: 'text-primary' },
            { icon: AlertTriangle, label: 'fatigue risk', value: fatigueRisk.level, color: fatigueRisk.level === 'high' ? 'text-red-500' : fatigueRisk.level === 'medium' ? 'text-orange-500' : 'text-emerald-500', capitalize: true },
            { icon: Waves, label: 'jerk score', value: trip.jerk_score ?? '-', color: 'text-sky-500' },
            { icon: Leaf, label: 'eco driving', value: trip.eco_driving_score ?? '-', color: 'text-emerald-500' },
            { icon: ShieldCheck, label: 'following score', value: trip.following_distance_score ?? '-', color: 'text-blue-500' },
            { icon: Focus, label: 'focus score', value: trip.distraction_score ?? '-', color: 'text-violet-500' },
            { icon: TimerReset, label: 'intersection score', value: trip.intersection_score ?? '-', color: 'text-amber-500' },
          ].map(({ icon: Icon, label, value, color, capitalize }) => (
            <div key={label} className="bg-secondary/50 rounded-xl p-3">
              <Icon className={`w-4 h-4 mb-2 ${color}`} />
              <div className={`font-grotesk font-bold text-xl ${capitalize ? 'capitalize' : ''}`}>{value}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </div>
          ))}
        </div>

        {fatigueChartData.length === 3 && (
          <div className="mb-4 bg-secondary/50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">Driving quality over trip</div>
              <span className="text-xs text-muted-foreground">{fatigueText[trip.fatigue_progression] || trip.fatigue_progression}</span>
            </div>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={fatigueChartData} margin={{ top: 5, right: 0, bottom: 0, left: -28 }}>
                <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                <Area type="monotone" dataKey="score" stroke={fatigueColor} fill={fatigueColor} fillOpacity={0.18} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {stops.length > 0 ? (
          <div className="space-y-2 max-h-44 overflow-y-auto thin-scrollbar">
            {stops.slice(0, 8).map((stop, index) => (
              <div key={`${stop.start_time}-${index}`} className="flex items-center justify-between border border-border rounded-xl p-2 text-sm">
                <div>
                  <div className="font-medium">Stop {index + 1}</div>
                  <div className="text-xs text-muted-foreground">{new Date(stop.start_time).toLocaleTimeString()}</div>
                </div>
                <div className="text-xs font-semibold text-primary">{formatDuration(stop.duration_seconds)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground bg-secondary/50 rounded-xl p-3">
            No meaningful stops detected on this trip.
          </div>
        )}
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
              { label: 'Lane Changes', value: trip.lane_changes_count, icon: Shuffle, color: 'text-slate-500', bg: 'bg-slate-100 dark:bg-slate-800/50' },
              { label: 'Tailgate', value: trip.tailgate_cycle_count, icon: ShieldCheck, color: 'text-violet-500', bg: 'bg-violet-50 dark:bg-violet-950/30' },
              { label: 'Erratic Speed', value: trip.distraction_events_count, icon: Focus, color: 'text-cyan-500', bg: 'bg-cyan-50 dark:bg-cyan-950/30' },
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
        <span className="text-sm font-semibold">{trip.route_points_raw_count || trip.route_points?.length || 0} GPS readings</span>
      </motion.div>
    </div>
  );
}
