// @ts-check
import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Gauge, Navigation, Activity } from 'lucide-react';
import { getScoreColor, getTripComponentScore } from '@/lib/tripEngine';
import { formatEstimatedScore } from '@/lib/scoreDisplay';

function ScoreBar({ label, value, max, color, evidence = null }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground truncate max-w-[120px]">{label}</span>
        <span className="text-right">
          <span className="font-semibold" style={{ color }}>{value}</span>
          {evidence && <span className="ml-1 text-[10px] capitalize text-muted-foreground">{evidence}</span>}
        </span>
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

const CHART_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899', '#eab308'];

const distanceWeightedScore = (trips = []) => {
  const scored = trips
    .map((trip) => ({
      score: getTripComponentScore(trip, 'overall').value,
      distance: Number(trip.distance_km) || 0,
    }))
    .filter((item) => item.score != null);
  const totalKm = scored.reduce((sum, trip) => sum + trip.distance, 0);
  return totalKm > 0
    ? scored.reduce((sum, trip) => sum + trip.score * trip.distance, 0) / totalKm
    : null;
};

const tripsForVehicle = (vehicle, trips = []) => trips.filter((trip) => (
  trip.status === 'completed' &&
  (
    String(trip.vehicle_id || '') === String(vehicle.id) ||
    (vehicle.is_default && !trip.vehicle_id)
  )
));

export default function VehicleCompare({ vehicles, trips }) {
  const stats = useMemo(() => {
    return vehicles.map((v, i) => {
      const vTrips = tripsForVehicle(v, trips);
      const count = vTrips.length;
      const weightedScore = count ? distanceWeightedScore(vTrips) : null;
      const avgScore = weightedScore == null ? null : Math.round(weightedScore);
      const scoredCount = vTrips.filter((trip) => getTripComponentScore(trip, 'overall').value != null).length;
      const totalKm = Math.round(vTrips.reduce((s, t) => s + (t.distance_km || 0), 0));
      const harshBrakes = vTrips.reduce((s, t) => s + (t.harsh_brakes_count || 0), 0);
      const color = v.color || CHART_COLORS[i % CHART_COLORS.length];
      return { id: v.id, name: v.name, avgScore, totalKm, harshBrakes, count, scoredCount, color };
    }).filter(s => s.count > 0);
  }, [vehicles, trips]);

  if (stats.length < 2) {
    return (
      <div className="bg-card border border-border rounded-2xl p-6 text-center">
        <Activity className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
        <div className="text-sm text-muted-foreground">
          Assign trips to at least 2 vehicles to see the comparison dashboard.
        </div>
      </div>
    );
  }

  const scoredStats = stats.filter((s) => s.avgScore != null);
  const maxKm = Math.max(...stats.map(s => s.totalKm), 1);

  return (
    <div className="space-y-4">
      <h2 className="font-grotesk font-bold text-lg">Vehicle Comparison</h2>

      {/* Score comparison bar chart */}
      <div className="bg-card border border-border rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-4">
          <Gauge className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">Average Driving Score</span>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={scoredStats} barSize={32} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(v) => [formatEstimatedScore(v), 'Avg Score']}
              contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', fontSize: 12 }}
            />
            <Bar dataKey="avgScore" radius={[6, 6, 0, 0]}>
              {scoredStats.map((s) => <Cell key={s.id} fill={s.color} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Distance comparison */}
      <div className="bg-card border border-border rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-4">
          <Navigation className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">Total Distance (km)</span>
        </div>
        <div className="space-y-3">
          {stats.map(s => (
            <ScoreBar key={s.id} label={s.name} value={s.totalKm} max={maxKm} color={s.color} />
          ))}
        </div>
      </div>

      {/* Score ranking */}
      <div className="bg-card border border-border rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm">Score Ranking</span>
        </div>
        <div className="space-y-3">
          {[...stats].sort((a, b) => (b.avgScore ?? Number.NEGATIVE_INFINITY) - (a.avgScore ?? Number.NEGATIVE_INFINITY)).map((s, i) => {
            const { color } = s.avgScore == null ? { color: 'text-muted-foreground' } : getScoreColor(s.avgScore);
            return (
              <div key={s.id} className="flex items-center gap-3">
                <span className="text-xs font-bold text-muted-foreground w-4">#{i + 1}</span>
                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: s.color }} />
                <span className="flex-1 text-sm font-medium truncate">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.scoredCount}/{s.count} scored</span>
                <span className={`text-sm font-bold ${color}`}>{formatEstimatedScore(s.avgScore)}</span>
                <span className="text-[10px] capitalize text-muted-foreground">aggregate evidence</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
