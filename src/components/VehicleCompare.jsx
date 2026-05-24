import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Gauge, Navigation, Activity } from 'lucide-react';
import { getScoreColor } from '@/lib/tripEngine';

function ScoreBar({ label, value, max, color }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground truncate max-w-[120px]">{label}</span>
        <span className="font-semibold" style={{ color }}>{value}</span>
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

const CHART_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899', '#eab308'];

const distanceWeightedScore = (trips = []) => {
  const totalKm = trips.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  return totalKm > 0
    ? trips.reduce((sum, trip) => sum + (Number(trip.score_overall) || 0) * (Number(trip.distance_km) || 0), 0) / totalKm
    : null;
};

export default function VehicleCompare({ vehicles, trips }) {
  const stats = useMemo(() => {
    return vehicles.map((v, i) => {
      const vTrips = trips.filter(t => t.vehicle_id === v.id && t.status === 'completed');
      const count = vTrips.length;
      const avgScore = count ? Math.round(distanceWeightedScore(vTrips) ?? 0) : 0;
      const totalKm = Math.round(vTrips.reduce((s, t) => s + (t.distance_km || 0), 0));
      const harshBrakes = vTrips.reduce((s, t) => s + (t.harsh_brakes_count || 0), 0);
      const color = v.color || CHART_COLORS[i % CHART_COLORS.length];
      return { id: v.id, name: v.name, avgScore, totalKm, harshBrakes, count, color };
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

  const maxScore = Math.max(...stats.map(s => s.avgScore), 1);
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
          <BarChart data={stats} barSize={32} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(v) => [v, 'Avg Score']}
              contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', fontSize: 12 }}
            />
            <Bar dataKey="avgScore" radius={[6, 6, 0, 0]}>
              {stats.map((s) => <Cell key={s.id} fill={s.color} />)}
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
          {[...stats].sort((a, b) => b.avgScore - a.avgScore).map((s, i) => {
            const { color } = getScoreColor(s.avgScore);
            return (
              <div key={s.id} className="flex items-center gap-3">
                <span className="text-xs font-bold text-muted-foreground w-4">#{i + 1}</span>
                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: s.color }} />
                <span className="flex-1 text-sm font-medium truncate">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.count} trips</span>
                <span className={`text-sm font-bold ${color}`}>{s.avgScore}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
