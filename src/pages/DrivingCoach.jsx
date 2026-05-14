import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Brain, Gauge, MapPinned, ShieldCheck, Target } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { tripService } from '@/api/trips';
import { formatDistance, formatSpeed } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import {
  analyzeDayOfWeek,
  analyzeTimeOfDay,
  buildDrivingCoachInsights,
} from '@/lib/tripInsights';

const focusLabels = {
  braking: 'Brake Earlier',
  acceleration: 'Smoother Starts',
  cornering: 'Cleaner Turns',
  'speed control': 'Speed Discipline',
  'fatigue breaks': 'Break Timing',
  consistency: 'Consistency',
};

export default function DrivingCoach() {
  const settings = localSettings.get();
  const units = settings.units || 'metric';
  const { data: allTrips = [], isLoading } = useQuery({
    queryKey: ['coach-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 1000 }),
  });

  const completed = allTrips.filter((trip) => trip.status === 'completed');
  const coach = buildDrivingCoachInsights(completed, settings);
  const timeOfDay = analyzeTimeOfDay(completed);
  const dayOfWeek = analyzeDayOfWeek(completed);

  return (
    <div className="space-y-6 pb-4">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-grotesk font-bold">Driving Coach</h1>
          <p className="text-muted-foreground text-sm mt-1">Actionable driving patterns from your trip history</p>
        </div>
        <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Brain className="w-5 h-5 text-primary" />
        </div>
      </motion.div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-28 rounded-2xl bg-secondary/60 animate-pulse" />
          ))}
        </div>
      ) : completed.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <Brain className="w-12 h-12 text-muted-foreground mb-3" />
          <div className="font-semibold">No coaching data yet</div>
          <div className="text-muted-foreground text-sm mt-1">Complete trips to unlock driving insights</div>
        </div>
      ) : (
        <>
          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Target className="w-6 h-6 text-primary" />
              </div>
              <div className="flex-1">
                <div className="text-xs text-muted-foreground mb-1">Current focus</div>
                <h2 className="font-grotesk font-bold text-2xl">
                  {focusLabels[coach.focus_area] || coach.focus_area}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Based on {coach.trip_count} completed trips, {coach.risk_rate.total_events} risky events, and route speed samples.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-card border border-border rounded-2xl p-4">
              <AlertTriangle className="w-5 h-5 text-orange-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{coach.risk_rate.events_per_100km}</div>
              <div className="text-xs text-muted-foreground">events per 100 km</div>
            </div>
            <div className="bg-card border border-border rounded-2xl p-4">
              <ShieldCheck className="w-5 h-5 text-emerald-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{coach.consistency.consistency_score}</div>
              <div className="text-xs text-muted-foreground">consistency score</div>
            </div>
            <div className="bg-card border border-border rounded-2xl p-4">
              <Gauge className="w-5 h-5 text-blue-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{formatSpeed(coach.speed_discipline.max_speed_kmh, units)}</div>
              <div className="text-xs text-muted-foreground">max recorded speed</div>
            </div>
            <div className="bg-card border border-border rounded-2xl p-4">
              <MapPinned className="w-5 h-5 text-violet-500 mb-2" />
              <div className="font-grotesk font-bold text-2xl">{formatDistance(coach.risk_rate.distance_km, units)}</div>
              <div className="text-xs text-muted-foreground">distance analyzed</div>
            </div>
          </div>

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <h2 className="font-semibold mb-3">Next Driving Actions</h2>
            <div className="space-y-2">
              {coach.actions.map((action) => (
                <div key={action} className="text-sm text-muted-foreground bg-secondary/50 rounded-xl p-3">
                  {action}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Speed Discipline</h2>
            <p className="text-xs text-muted-foreground mb-4">
              {coach.speed_discipline.over_limit_percent}% of sampled route points were above the configured speed threshold.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{coach.speed_discipline.sample_points}</div>
                <div className="text-xs text-muted-foreground">samples</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{coach.speed_discipline.over_limit_points}</div>
                <div className="text-xs text-muted-foreground">over limit</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl capitalize">{coach.speed_discipline.level.replace('_', ' ')}</div>
                <div className="text-xs text-muted-foreground">status</div>
              </div>
            </div>
          </div>

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Best Driving Window</h2>
            <p className="text-xs text-muted-foreground mb-4">Average score by trip start time</p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={timeOfDay} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="avgScore" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Avg score" />
                <Bar dataKey="events" fill="#f97316" radius={[4, 4, 0, 0]} name="Risk events" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-card border border-border rounded-3xl p-5 shadow-sm">
            <h2 className="font-semibold mb-1">Day Pattern</h2>
            <p className="text-xs text-muted-foreground mb-4">Risk events and score across the week</p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={dayOfWeek} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="events" fill="#ef4444" radius={[4, 4, 0, 0]} name="Risk events" />
                <Bar dataKey="avgScore" fill="#22c55e" radius={[4, 4, 0, 0]} name="Avg score" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
