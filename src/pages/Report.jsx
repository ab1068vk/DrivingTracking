import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import {
  BarChart3, TrendingUp, Award, AlertTriangle,
  Download, Car, Clock, Navigation
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, LineChart, Line
} from 'recharts';
import { generateReportSummary, formatDistance, formatDuration, formatDate, getScoreColor, tripsToCSV, downloadCSV } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';

const PERIODS = [
  { id: 'week', label: 'This Week', days: 7 },
  { id: 'month', label: 'This Month', days: 30 },
  { id: 'all', label: 'All Time', days: Infinity },
];

export default function Reports() {
  const [period, setPeriod] = useState('week');
  const settings = localSettings.get();
  const units = settings.units || 'metric';

  const { data: allTrips = [], isLoading } = useQuery({
    queryKey: ['report-trips'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 500 }),
  });

  const completed = allTrips.filter(t => t.status === 'completed');

  // Filter by period
  const now = Date.now();
  const periodDays = PERIODS.find(p => p.id === period)?.days || 7;
  const cutoff = period === 'all' ? 0 : now - periodDays * 24 * 3600 * 1000;
  const trips = completed.filter(t => new Date(t.start_time).getTime() >= cutoff);

  const summary = generateReportSummary(trips);

  // Build 6-month monthly event trend data (always uses all completed trips)
  const eventTrendData = (() => {
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const label = d.toLocaleDateString('en-US', { month: 'short' });
      const year = d.getFullYear();
      const month = d.getMonth();
      const monthTrips = completed.filter(t => {
        const td = new Date(t.start_time);
        return td.getFullYear() === year && td.getMonth() === month;
      });
      months.push({
        month: label,
        harshBrakes: monthTrips.reduce((s, t) => s + (t.harsh_brakes_count || 0), 0),
        rapidAccels: monthTrips.reduce((s, t) => s + (t.rapid_accel_count || 0), 0),
      });
    }
    return months;
  })();

  // Build daily chart data
  const dailyData = (() => {
    const days = period === 'all' ? 30 : periodDays;
    const map = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      const key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      map[key] = { date: key, distance: 0, trips: 0, score: 0, scoreCount: 0 };
    }
    trips.forEach(t => {
      const key = new Date(t.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (map[key]) {
        map[key].distance += t.distance_km || 0;
        map[key].trips += 1;
        if (t.score_overall) {
          map[key].score += t.score_overall;
          map[key].scoreCount += 1;
        }
      }
    });
    return Object.values(map).map(d => ({
      ...d,
      distance: Math.round(d.distance * 10) / 10,
      avgScore: d.scoreCount > 0 ? Math.round(d.score / d.scoreCount) : null,
    }));
  })();

  const riskLabels = {
    harsh_brake: 'Harsh Braking',
    rapid_acceleration: 'Rapid Acceleration',
    sharp_turn: 'Sharp Turns',
    speeding: 'Speeding',
  };

  const handleExport = async () => {
    const csv = tripsToCSV(trips);
    const result = await downloadCSV(csv, `drivesense-report-${period}-${new Date().toISOString().split('T')[0]}.csv`);
    if (result?.native) alert(`Export saved to Documents as ${result.filename}.`);
  };

  const { color: bestColor } = getScoreColor(summary.best_trip?.score_overall || 0);
  const { color: worstColor } = getScoreColor(summary.worst_trip?.score_overall || 0);

  return (
    <div className="space-y-6 pb-4">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-grotesk font-bold">Reports</h1>
          <p className="text-muted-foreground text-sm mt-1">Driving performance analysis</p>
        </div>
        <button
          onClick={handleExport}
          className="flex items-center gap-1.5 px-3 py-2 bg-card border border-border rounded-xl text-sm hover:bg-secondary transition-colors"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </motion.div>

      {/* Period selector */}
      <div className="flex gap-2">
        {PERIODS.map(p => (
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              period === p.id ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-card border border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map(i => <div key={i} className="h-32 bg-secondary/50 rounded-2xl animate-pulse" />)}
        </div>
      ) : trips.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <BarChart3 className="w-12 h-12 text-muted-foreground mb-3" />
          <div className="font-semibold">No data for this period</div>
          <div className="text-muted-foreground text-sm mt-1">Record some trips first</div>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Car, label: 'Total Trips', value: summary.total_trips, gradient: 'gradient-primary' },
              { icon: Navigation, label: 'Distance', value: formatDistance(summary.total_distance_km, units), gradient: 'gradient-success' },
              { icon: Clock, label: 'Drive Time', value: formatDuration(summary.total_duration_seconds), gradient: 'bg-gradient-to-br from-purple-500 to-purple-700' },
              { icon: TrendingUp, label: 'Avg Score', value: summary.avg_score, gradient: getScoreColor(summary.avg_score).color.includes('green') ? 'gradient-success' : 'gradient-warning' },
            ].map(({ icon: Icon, label, value, gradient }, i) => (
              <motion.div
                key={label}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
                className={`relative overflow-hidden rounded-2xl p-4 text-white shadow-lg ${gradient}`}
              >
                <div className="absolute -top-4 -right-4 w-16 h-16 bg-white/10 rounded-full" />
                <Icon className="w-5 h-5 mb-2 opacity-80" />
                <div className="font-grotesk font-bold text-2xl leading-none">{value}</div>
                <div className="text-white/70 text-xs mt-1">{label}</div>
              </motion.div>
            ))}
          </div>

          {/* Score trend chart */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-1">Daily Distance</h2>
            <p className="text-xs text-muted-foreground mb-4">{units === 'imperial' ? 'Miles' : 'Kilometers'} driven per day</p>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={dailyData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="distGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                  formatter={(v) => [v, units === 'imperial' ? 'mi' : 'km']}
                />
                <Area type="monotone" dataKey="distance" stroke="hsl(var(--primary))" fill="url(#distGrad)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </motion.div>

          {/* Score trend */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-1">Score Trend</h2>
            <p className="text-xs text-muted-foreground mb-4">Average daily driving score</p>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={dailyData.filter(d => d.avgScore !== null)} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                  formatter={(v) => [v, 'Score']}
                />
                <Line type="monotone" dataKey="avgScore" stroke="hsl(var(--accent))" strokeWidth={2.5} dot={{ fill: 'hsl(var(--accent))', r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </motion.div>

          {/* 6-month event trend */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.28 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-1">Event Trends — Last 6 Months</h2>
            <p className="text-xs text-muted-foreground mb-4">Harsh braking vs rapid acceleration per month</p>
            <ResponsiveContainer width="100%" height={170}>
              <BarChart data={eventTrendData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                  formatter={(v, name) => [v, name === 'harshBrakes' ? '🛑 Harsh Brakes' : '⚡ Rapid Accels']}
                />
                <Bar dataKey="harshBrakes" fill="#ef4444" radius={[4, 4, 0, 0]} name="harshBrakes" />
                <Bar dataKey="rapidAccels" fill="#f59e0b" radius={[4, 4, 0, 0]} name="rapidAccels" />
              </BarChart>
            </ResponsiveContainer>
            <div className="flex gap-4 mt-2 justify-center text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block" />Harsh Braking</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-yellow-500 inline-block" />Rapid Acceleration</span>
            </div>
          </motion.div>

          {/* Risk breakdown */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-4">Risk Events</h2>
            <div className="space-y-3">
              {[
                { key: 'harsh_brake', count: summary.total_harsh_brakes, color: '#ef4444', bg: 'bg-red-500' },
                { key: 'rapid_acceleration', count: summary.total_rapid_accels, color: '#f59e0b', bg: 'bg-yellow-500' },
                { key: 'sharp_turn', count: summary.total_sharp_turns, color: '#3b82f6', bg: 'bg-blue-500' },
                { key: 'speeding', count: summary.total_speeding_events, color: '#f97316', bg: 'bg-orange-500' },
              ].map(({ key, count, color, bg }) => {
                const maxCount = Math.max(summary.total_harsh_brakes, summary.total_rapid_accels, summary.total_sharp_turns, summary.total_speeding_events, 1);
                const pct = (count / maxCount) * 100;
                return (
                  <div key={key}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-muted-foreground">{riskLabels[key]}</span>
                      <span className="font-semibold" style={{ color }}>{count}</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ delay: 0.4, duration: 0.8, ease: 'easeOut' }}
                        className={`h-full rounded-full ${bg}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {summary.most_common_risk && (
              <div className="mt-4 p-3 bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800/40 rounded-xl text-sm">
                <div className="text-orange-600 dark:text-orange-400 font-medium">
                  ⚠️ Most common risk: {riskLabels[summary.most_common_risk]}
                </div>
                <div className="text-orange-500 dark:text-orange-500/80 text-xs mt-0.5">
                  Focus on improving this for a better score
                </div>
              </div>
            )}
          </motion.div>

          {/* Best & Worst */}
          {summary.best_trip && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.35 }}
              className="space-y-3"
            >
              <h2 className="font-semibold">Highlights</h2>
              <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800/40 rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Award className="w-4 h-4 text-green-600 dark:text-green-400" />
                  <span className="text-sm font-semibold text-green-700 dark:text-green-300">Best Trip</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">{formatDate(summary.best_trip.start_time)}</div>
                  <div className={`font-grotesk font-bold text-2xl ${bestColor}`}>{summary.best_trip.score_overall}</div>
                </div>
              </div>
              {summary.worst_trip && summary.worst_trip.id !== summary.best_trip.id && (
                <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/40 rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400" />
                    <span className="text-sm font-semibold text-red-700 dark:text-red-300">Needs Improvement</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">{formatDate(summary.worst_trip.start_time)}</div>
                    <div className={`font-grotesk font-bold text-2xl ${worstColor}`}>{summary.worst_trip.score_overall}</div>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}
