import { motion } from 'framer-motion';
import { Clock, Gauge, Navigation, ChevronRight, ShieldAlert, Flame, Smartphone } from 'lucide-react';
import { formatDistance, formatDuration, formatDate, formatTime, getScoreColor, formatSpeed } from '@/lib/tripEngine';
import { useNavigate } from 'react-router-dom';

export default function TripCard({ trip, units = 'metric', index = 0 }) {
  const navigate = useNavigate();
  const { color, label: scoreLabel, bg } = getScoreColor(trip.score_overall || 0);

  const startPt = trip.route_points?.[0];
  const endPt = trip.route_points?.[trip.route_points.length - 1];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      onClick={() => navigate(`/trips/${trip.id}`)}
      className="bg-card border border-border rounded-2xl p-4 hover:shadow-md hover:border-primary/30 transition-all cursor-pointer group"
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left: info */}
        <div className="flex-1 min-w-0">
          {/* Date/time row */}
          <div className="flex items-center gap-2 mb-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="w-3.5 h-3.5" />
              <span>{formatDate(trip.start_time)}</span>
              <span>·</span>
              <span>{formatTime(trip.start_time)}</span>
            </div>
            {trip.night_driving && (
              <span className="text-xs bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-800/50 px-1.5 py-0.5 rounded-full">
                🌙 Night
              </span>
            )}
          </div>

          {/* Route */}
          {(trip.start_address || trip.end_address) && (
            <div className="flex items-center gap-1.5 mb-2 text-sm">
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-1.5 text-foreground font-medium truncate">
                  <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0" />
                  <span className="truncate">{trip.start_address || 'Start'}</span>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground truncate">
                  <div className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0" />
                  <span className="truncate">{trip.end_address || 'End'}</span>
                </div>
              </div>
            </div>
          )}

          {/* Stats row */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Navigation className="w-3.5 h-3.5" />
              <span className="font-medium text-foreground">{formatDistance(trip.distance_km || 0, units)}</span>
            </div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Clock className="w-3.5 h-3.5" />
              <span>{formatDuration(trip.duration_seconds)}</span>
            </div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Gauge className="w-3.5 h-3.5" />
              <span>{formatSpeed(trip.avg_speed_kmh || 0, units)}</span>
            </div>
          </div>

          {/* Events row */}
          {(trip.harsh_brakes_count > 0 || trip.rapid_accel_count > 0 || trip.sharp_turns_count > 0 || trip.speeding_events_count > 0) && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {trip.harsh_brakes_count > 0 && (
                <span className="text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/40 px-1.5 py-0.5 rounded-md">
                  🛑 {trip.harsh_brakes_count} brake{trip.harsh_brakes_count > 1 ? 's' : ''}
                </span>
              )}
              {trip.rapid_accel_count > 0 && (
                <span className="text-xs bg-yellow-50 dark:bg-yellow-950/30 text-yellow-700 dark:text-yellow-400 border border-yellow-200 dark:border-yellow-800/40 px-1.5 py-0.5 rounded-md">
                  ⚡ {trip.rapid_accel_count} accel
                </span>
              )}
              {trip.sharp_turns_count > 0 && (
                <span className="text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40 px-1.5 py-0.5 rounded-md">
                  ↰ {trip.sharp_turns_count} turn{trip.sharp_turns_count > 1 ? 's' : ''}
                </span>
              )}
              {trip.speeding_events_count > 0 && (
                <span className="text-xs bg-orange-50 dark:bg-orange-950/30 text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-800/40 px-1.5 py-0.5 rounded-md">
                  🚀 {trip.speeding_events_count} speed
                </span>
              )}
            </div>
          )}

          {((trip.near_miss_count || 0) > 0 || trip.aggressive_grade === 'aggressive' || ['possible', 'likely'].includes(trip.phone_proxy_risk)) && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {(trip.near_miss_count || 0) > 0 && (
                <span title={`${trip.near_miss_count} near-miss event(s)`} className="inline-flex items-center gap-1 text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/40 px-1.5 py-0.5 rounded-md">
                  <ShieldAlert className="w-3 h-3" /> {trip.near_miss_count}
                </span>
              )}
              {trip.aggressive_grade === 'aggressive' && (
                <span title="Aggressive driving pattern" className="inline-flex items-center text-xs bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/40 px-1.5 py-0.5 rounded-md">
                  <Flame className="w-3 h-3" />
                </span>
              )}
              {['possible', 'likely'].includes(trip.phone_proxy_risk) && (
                <span title={`Phone distraction risk: ${trip.phone_proxy_risk}`} className="inline-flex items-center text-xs bg-yellow-50 dark:bg-yellow-950/30 text-yellow-700 dark:text-yellow-400 border border-yellow-200 dark:border-yellow-800/40 px-1.5 py-0.5 rounded-md">
                  <Smartphone className="w-3 h-3" />
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right: Score */}
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <div className={`w-12 h-12 rounded-2xl ${bg} flex items-center justify-center border`}>
            <span className={`font-grotesk font-bold text-lg ${color}`}>
              {trip.score_overall ?? '—'}
            </span>
          </div>
          <span className={`text-xs font-medium ${color}`}>{scoreLabel}</span>
        </div>
      </div>

      {/* Chevron */}
      <div className="flex justify-end mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
      </div>
    </motion.div>
  );
}
