import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import {
  BarChart3, TrendingUp, AlertTriangle,
  Download, Car, Clock, Navigation, Fuel, Leaf, Gauge, Award, FileText
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, LineChart, Line, PieChart, Pie, Cell,
  RadarChart, Radar, PolarGrid, PolarAngleAxis
} from 'recharts';
import { generateReportSummary, formatDistance, formatDuration, formatDate, formatSpeed, getScoreColor, tripsToCSV, downloadCSV } from '@/lib/tripEngine';
import ScoreRing from '@/components/ScoreRing';
import { localSettings } from '@/lib/trackingStore';
import { formatCurrencyAmount } from '@/lib/currency';
import { exportMonthlyReportPDF, exportUBIReportPDF } from '@/lib/pdfExport';
import { computeUBIReport } from '@/lib/ubiReport';
import { notifyExportSaved } from '@/lib/notificationService';
import { toast } from '@/components/ui/use-toast';
import {
  analyzeDayOfWeek,
  analyzeTimeOfDay,
  buildScoreTips,
  calculateFatigueRisk,
  calculateCarbonImpact,
  computePersonalBaseline,
  estimateTripEconomics,
  identifyCommutePatterns,
  calculatePeakHourStress,
} from '@/lib/tripInsights';

const PERIODS = [
  { id: 'week', label: 'This Week', days: 7 },
  { id: 'month', label: 'This Month', days: 30 },
  { id: 'all', label: 'All Time', days: Infinity },
];

export default function Reports() {
  const [period, setPeriod] = useState('week');
  const [ubiLoading, setUbiLoading] = useState(false);
  const settings = localSettings.get();
  const units = settings.units || 'metric';

  const { data: allTrips = [], isLoading } = useQuery({
    queryKey: ['report-trips'],
    queryFn: () => tripService.listAll({ sort: '-start_time' }),
  });

  const { data: vehicles = [] } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 100 }),
  });

  const completed = allTrips.filter(t => t.status === 'completed');
  const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle.id), vehicle]));

  // Filter by period
  const now = Date.now();
  const periodDays = PERIODS.find(p => p.id === period)?.days || 7;
  const cutoff = period === 'all' ? 0 : now - periodDays * 24 * 3600 * 1000;
  const trips = completed.filter(t => new Date(t.start_time).getTime() >= cutoff);

  const summary = generateReportSummary(trips);
  const economics = trips.reduce((totals, trip) => {
    const estimate = estimateTripEconomics(trip, vehicleById.get(String(trip.vehicle_id)), settings);
    return {
      cost: totals.cost + estimate.cost,
      liters: totals.liters + estimate.liters,
      co2: totals.co2 + estimate.co2_kg,
      saved: totals.saved + estimate.fuel_saved_liters,
    };
  }, { cost: 0, liters: 0, co2: 0, saved: 0 });
  const tips = buildScoreTips(trips);
  const timeOfDayData = analyzeTimeOfDay(trips);
  const dayOfWeekData = analyzeDayOfWeek(trips);
  const fatigueRisk = calculateFatigueRisk(trips, settings);
  const avgMovingSpeedKmh = trips.length
    ? trips.reduce((sum, trip) => sum + (trip.avg_running_speed_kmh ?? trip.avg_speed_kmh ?? 0), 0) / trips.length
    : 0;
  // FIX: Compute report average speed from avg_running_speed_kmh, falling back only for legacy trips.
  const baseline = computePersonalBaseline(completed);
  const carbonImpact = calculateCarbonImpact(trips, settings, vehicleById);
  const commutePatterns = identifyCommutePatterns(trips);
  const peakHourStress = calculatePeakHourStress(trips);
  const roadTypeData = ['highway', 'urban', 'mixed', 'residential']
    .map((type) => ({
      name: type[0].toUpperCase() + type.slice(1),
      value: trips.filter((trip) => trip.road_type === type).length,
    }))
    .filter((item) => item.value > 0);
  const roadColors = ['#3b82f6', '#f59e0b', '#64748b', '#22c55e'];
  const complianceChartData = ['highway', 'urban', 'residential']
    .map((type) => {
      const values = trips
        .map((trip) => trip[`${type}_compliance`]?.rate)
        .filter((value) => Number.isFinite(value));
      return {
        name: type[0].toUpperCase() + type.slice(1),
        rate: values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) : null,
      };
    })
    .filter((item) => item.rate != null);
  const efficiencyBandsData = [{
    name: 'Selected',
    cityCrawl: trips.length ? Math.round(trips.reduce((sum, trip) => sum + (trip.city_crawl_ratio || 0), 0) / trips.length) : 0,
    cruise: trips.length ? Math.round(trips.reduce((sum, trip) => sum + (trip.optimal_band_ratio || 0), 0) / trips.length) : 0,
    highSpeed: trips.length ? Math.round(trips.reduce((sum, trip) => sum + (trip.high_speed_ratio || 0), 0) / trips.length) : 0,
  }];
  efficiencyBandsData[0].city = Math.max(0, 100 - efficiencyBandsData[0].cityCrawl - efficiencyBandsData[0].cruise - efficiencyBandsData[0].highSpeed);
  const peakComparisonData = [
    { label: 'Peak', rate: peakHourStress.peak_trips_event_rate },
    { label: 'Off-peak', rate: peakHourStress.off_peak_trips_event_rate },
  ];
  const ubiReport = computeUBIReport(trips, settings, vehicles);
  const ubiRadarData = Object.values(ubiReport.categories).map((item) => ({
    category: item.label.replace('Rapid acceleration', 'Acceleration').replace('Speed compliance', 'Speed'),
    score: item.score,
  }));

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
      map[key] = { date: key, distance: 0, trips: 0, score: 0, scoreDistance: 0, svi: 0, sviCount: 0 };
    }
    trips.forEach(t => {
      const key = new Date(t.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (map[key]) {
        map[key].distance += t.distance_km || 0;
        map[key].trips += 1;
        if (t.score_overall) {
          const distance = Number(t.distance_km) || 0;
          map[key].score += t.score_overall * distance;
          map[key].scoreDistance += distance;
        }
        if (t.svi_score != null && t.svi_score !== '' && Number.isFinite(Number(t.svi_score))) {
          map[key].svi += Number(t.svi_score);
          map[key].sviCount += 1;
        }
      }
    });
    return Object.values(map).map(d => ({
      ...d,
      distance: Math.round(d.distance * 10) / 10,
      avgScore: d.scoreDistance > 0 ? Math.round(d.score / d.scoreDistance) : null,
      avgSviScore: d.sviCount > 0 ? Math.round(d.svi / d.sviCount) : null,
    }));
  })();

  const riskLabels = {
    harsh_brake: 'Harsh Braking',
    rapid_acceleration: 'Rapid Acceleration',
    sharp_turn: 'Sharp Turns',
    speeding: 'Speeding',
    lane_change: 'Lane Changes',
    tailgate_cycle: 'Following Gap',
    erratic_speed: 'Erratic Speed',
    near_miss: 'Close Proximity',
    close_proximity: 'Close Proximity',
    aggressive_overtake: 'Aggressive Overtakes',
  };

  const handleExport = async () => {
    const csv = tripsToCSV(trips);
    const result = await downloadCSV(csv, `road-sage-report-${period}-${new Date().toISOString().split('T')[0]}.csv`);
    toast({
      title: 'Export saved',
      description: result?.native
        ? `${result.filename} was saved to Downloads.`
        : `${result?.filename || 'CSV report'} is downloading.`,
    });
    if (result?.native) {
      await notifyExportSaved({
        filename: result.filename,
        uri: result.uri,
        mimeType: 'text/csv',
        label: 'CSV export',
      }).catch(() => {});
    }
  };

  const handlePdfExport = async () => {
    const result = await exportMonthlyReportPDF(trips, period, settings);
    toast({
      title: 'PDF saved',
      description: result?.native
        ? `${result.filename} was saved to Downloads.`
        : `${result?.filename || 'Monthly PDF report'} is downloading.`,
    });
    if (result?.native) {
      await notifyExportSaved({
        filename: result.filename,
        uri: result.uri,
        mimeType: 'application/pdf',
        label: 'PDF report',
      }).catch(() => {});
    }
  };

  const handleUbiExport = async () => {
    setUbiLoading(true);
    const result = await exportUBIReportPDF(ubiReport, settings);
    setUbiLoading(false);
    toast({
      title: 'Score card saved',
      description: result?.native
        ? `${result.filename} was saved to Downloads.`
        : `${result?.filename || 'Score card PDF'} is downloading.`,
    });
    if (result?.native) {
      await notifyExportSaved({
        filename: result.filename,
        uri: result.uri,
        mimeType: 'application/pdf',
        label: 'Score card',
      }).catch(() => {});
    }
  };

  const { color: bestColor } = getScoreColor(summary.best_trip?.score_overall || 0);
  const { color: worstColor } = getScoreColor(summary.worst_trip?.score_overall || 0);
  const previousTrips = (() => {
    if (period === 'all') return [];
    const previousCutoff = cutoff - periodDays * 24 * 3600 * 1000;
    return completed.filter((trip) => {
      const time = new Date(trip.start_time).getTime();
      return time >= previousCutoff && time < cutoff;
    });
  })();
  const previousSummary = generateReportSummary(previousTrips);
  const topRisk = Object.entries(riskLabels)
    .map(([type, label]) => ({
      type,
      label,
      count: trips.reduce((sum, trip) => sum + (trip.driving_events || []).filter((event) => event.type === type).length, 0),
    }))
    .sort((a, b) => b.count - a.count)[0];
  const reportTakeaways = [
    summary.total_trips > 0
      ? `${summary.total_trips} trips covered ${formatDistance(summary.total_distance_km, units)} with an average score of ${summary.avg_score}.`
      : 'No trips were recorded in this report period.',
    previousTrips.length > 0
      ? `Compared with the previous period, score ${summary.avg_score >= previousSummary.avg_score ? 'improved' : 'dropped'} by ${Math.abs(summary.avg_score - previousSummary.avg_score)} points.`
      : 'Complete another matching period to unlock period-over-period comparison.',
    topRisk?.count > 0
      ? `Main thing to work on: ${topRisk.label.toLowerCase()} (${topRisk.count} event${topRisk.count === 1 ? '' : 's'}).`
      : 'No dominant risk event stood out in this period.',
  ];

  return (
    <div className="space-y-6 pb-4">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-grotesk font-bold">Reports</h1>
          <p className="text-muted-foreground text-sm mt-1">Driving performance analysis</p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 bg-card border border-border rounded-xl text-sm hover:bg-secondary transition-colors"
          >
            <Download className="w-4 h-4" />
            Export {trips.length} Trips
          </button>
          <button
            onClick={handlePdfExport}
            className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-xl text-sm hover:opacity-90 transition-opacity"
          >
            <FileText className="w-4 h-4" />
            Export Monthly Report (PDF)
          </button>
          <button
            onClick={handleUbiExport}
            disabled={ubiLoading}
            className="flex items-center gap-1.5 px-3 py-2 bg-card border border-border rounded-xl text-sm hover:bg-secondary transition-colors disabled:opacity-60"
          >
            <Award className="w-4 h-4" />
            {ubiLoading ? 'Generating...' : 'Export Score Card (PDF)'}
          </button>
        </div>
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
        <div className="flex flex-col items-center rounded-3xl border border-dashed border-border bg-card py-16 px-4 text-center">
          <BarChart3 className="w-12 h-12 text-muted-foreground mb-3" />
          <div className="font-semibold">No report data yet</div>
          <div className="mt-1 max-w-xs text-muted-foreground text-sm">
            Complete a trip in this period to unlock score trends, risk events, exports, and route comparisons.
          </div>
        </div>
      ) : (
        <>
          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">What changed</h2>
                <p className="mt-1 text-xs text-muted-foreground">Plain-English summary for the selected period</p>
              </div>
              <TrendingUp className="h-5 w-5 text-primary" />
            </div>
            <div className="space-y-2">
              {reportTakeaways.map((takeaway) => (
                <div key={takeaway} className="rounded-xl bg-secondary/50 p-3 text-sm text-muted-foreground">
                  {takeaway}
                </div>
              ))}
            </div>
          </section>

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: Car, label: 'Total Trips', value: summary.total_trips, gradient: 'gradient-primary' },
              { icon: Navigation, label: 'Distance', value: formatDistance(summary.total_distance_km, units), gradient: 'gradient-success' },
              { icon: Clock, label: 'Drive Time', value: formatDuration(summary.total_duration_seconds), gradient: 'bg-gradient-to-br from-purple-500 to-purple-700' },
              { icon: TrendingUp, label: 'Avg Score', value: summary.avg_score, gradient: getScoreColor(summary.avg_score).color.includes('green') ? 'gradient-success' : 'gradient-warning' },
              { icon: Gauge, label: 'Avg Moving Speed', value: formatSpeed(avgMovingSpeedKmh || 0, units), gradient: 'bg-gradient-to-br from-sky-500 to-blue-700' },
              // FIX: Display Avg Moving Speed in the report instead of an overall average including stops.
              { icon: Fuel, label: 'Fuel Cost', value: formatCurrencyAmount(economics.cost, settings), gradient: 'bg-gradient-to-br from-cyan-500 to-blue-600' },
              { icon: Leaf, label: 'Fuel Saved', value: `${economics.saved.toFixed(2)} L`, gradient: 'bg-gradient-to-br from-lime-500 to-emerald-700' },
              { icon: Leaf, label: 'CO2', value: `${economics.co2.toFixed(1)} kg`, gradient: 'bg-gradient-to-br from-emerald-500 to-teal-700' },
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

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <div className="mb-5 rounded-2xl border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Driver Score Card</h2>
                  <p className="mt-1 text-xs text-muted-foreground">UBI-style telematics report for insurance or personal records</p>
                </div>
                <div className="text-right">
                  <div className="font-grotesk text-3xl font-bold">{ubiReport.ubiScore}</div>
                  <div className="text-xs font-semibold text-primary">{ubiReport.ubiGrade} · {ubiReport.ubiTier}</div>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <RadarChart data={ubiRadarData} outerRadius={78}>
                  <PolarGrid />
                  <PolarAngleAxis dataKey="category" tick={{ fontSize: 10 }} />
                  <Radar dataKey="score" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.28} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
            <h2 className="font-semibold mb-1">Vs. Your Baseline</h2>
            <p className="text-xs text-muted-foreground mb-4">
              {baseline.baseline_avg == null
                ? 'More recent trips are needed for a rolling 4-week baseline.'
                : `This week is ${baseline.delta >= 0 ? '+' : ''}${baseline.delta} points from baseline.`}
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{baseline.this_week_avg ?? '-'}</div>
                <div className="text-xs text-muted-foreground">this week</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{baseline.baseline_avg ?? '-'}</div>
                <div className="text-xs text-muted-foreground">baseline</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{baseline.personal_best_week_avg ?? '-'}</div>
                <div className="text-xs text-muted-foreground">best week</div>
              </div>
            </div>
          </motion.div>

          {roadTypeData.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.185 }}
              className="bg-card border border-border rounded-3xl p-5 shadow-sm"
            >
              <h2 className="font-semibold mb-1">Road Type Breakdown</h2>
              <p className="text-xs text-muted-foreground mb-4">Trip classification from speed distribution</p>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={roadTypeData} dataKey="value" nameKey="name" innerRadius={42} outerRadius={72} paddingAngle={2}>
                    {roadTypeData.map((entry, index) => (
                      <Cell key={entry.name} fill={roadColors[index % roadColors.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="grid grid-cols-2 gap-2">
                {roadTypeData.map((item, index) => (
                  <div key={item.name} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: roadColors[index % roadColors.length] }} />
                    {item.name}: {item.value}
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {complianceChartData.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.186 }}
              className="bg-card border border-border rounded-3xl p-5 shadow-sm"
            >
              <h2 className="font-semibold mb-1">Compliance</h2>
              <p className="text-xs text-muted-foreground mb-4">Average speed-limit compliance by road type</p>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={complianceChartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} formatter={(v) => [`${v}%`, 'Compliance']} />
                  <Bar dataKey="rate" fill="#22c55e" radius={[4, 4, 0, 0]} name="Compliance" />
                </BarChart>
              </ResponsiveContainer>
            </motion.div>
          )}

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.187 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-1">Drive Efficiency Bands</h2>
            <p className="text-xs text-muted-foreground mb-4">Average moving time by speed band</p>
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={efficiencyBandsData} layout="vertical" margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                <XAxis type="number" domain={[0, 100]} hide />
                <YAxis type="category" dataKey="name" hide />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} formatter={(v) => [`${v}%`, 'Share']} />
                <Bar dataKey="cityCrawl" stackId="a" fill="#ef4444" name="City crawl" />
                <Bar dataKey="city" stackId="a" fill="#f97316" name="City" />
                <Bar dataKey="cruise" stackId="a" fill="#22c55e" name="Cruise band" />
                <Bar dataKey="highSpeed" stackId="a" fill="#dc2626" name="High speed" />
              </BarChart>
            </ResponsiveContainer>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.188 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <Leaf className="w-5 h-5 text-emerald-500 mt-1" />
              <div>
                <h2 className="font-semibold mb-1">Your Environmental Impact</h2>
                <div className="font-grotesk font-bold text-2xl">{carbonImpact.trees_equivalent} tree-years of CO2 offset</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {carbonImpact.total_co2_saved_kg > 0
                    ? `You saved ${carbonImpact.total_co2_saved_kg} kg CO2 vs. a vehicle/fleet baseline estimate.`
                    : 'Assign vehicles to trips to unlock CO2 savings estimates.'}
                  {carbonImpact.total_co2_saved_kg > 0 && ' Estimates carry a +/-30% confidence band unless a vehicle baseline is available.'}
                </p>
                <span className="mt-3 inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                  {carbonImpact.carbon_grade}
                </span>
              </div>
            </div>
          </motion.div>

          {commutePatterns.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.189 }}
              className="bg-card border border-border rounded-3xl p-5 shadow-sm"
            >
              <h2 className="font-semibold mb-1">Your Routes</h2>
              <p className="text-xs text-muted-foreground mb-4">Recurring start/end patterns across your trip history</p>
              <div className="space-y-3">
                {commutePatterns.map((pattern) => (
                  <div key={pattern.route_key} className="flex items-center gap-3 rounded-2xl border border-border p-3">
                    <ScoreRing score={pattern.avg_score} size={56} strokeWidth={5} sublabel="avg" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold">{pattern.trip_count} trips</div>
                      <div className="text-xs text-muted-foreground">
                        {formatDistance(pattern.avg_distance_km, units)} avg, {pattern.avg_duration_minutes}m avg, {pattern.weekly_minutes_estimate}m/week
                      </div>
                    </div>
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold capitalize ${
                      pattern.score_trend === 'improving' ? 'bg-emerald-100 text-emerald-700' :
                        pattern.score_trend === 'declining' ? 'bg-red-100 text-red-700' :
                          'bg-secondary text-muted-foreground'
                    }`}>{pattern.score_trend}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.19 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-3">Improvement Tips</h2>
            <div className="space-y-2">
              {tips.map((tip) => (
                <div key={tip} className="text-sm text-muted-foreground bg-secondary/50 rounded-xl p-3">
                  {tip}
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.195 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-1">Fatigue Risk</h2>
            <p className="text-xs text-muted-foreground mb-4">
              Long-drive threshold: {fatigueRisk.threshold_minutes} minutes
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className={`font-grotesk font-bold text-xl capitalize ${
                  fatigueRisk.level === 'high' ? 'text-red-500' : fatigueRisk.level === 'medium' ? 'text-orange-500' : 'text-emerald-500'
                }`}>
                  {fatigueRisk.level}
                </div>
                <div className="text-xs text-muted-foreground">Risk</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{fatigueRisk.long_trip_count}</div>
                <div className="text-xs text-muted-foreground">Long drives</div>
              </div>
              <div className="bg-secondary/50 rounded-xl p-3">
                <div className="font-grotesk font-bold text-xl">{fatigueRisk.longest_trip_minutes}m</div>
                <div className="text-xs text-muted-foreground">Longest</div>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.197 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-1">Time of Day</h2>
            <p className="text-xs text-muted-foreground mb-4">Average score and risky events by trip start time</p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={timeOfDayData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                />
                <Bar dataKey="avgScore" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Avg score" />
                <Bar dataKey="events" fill="#f97316" radius={[4, 4, 0, 0]} name="Risk events" />
              </BarChart>
            </ResponsiveContainer>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1975 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-1">Peak Vs Off-Peak</h2>
            <p className="text-xs text-muted-foreground mb-4">Risk event rate per km by traffic window</p>
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={peakComparisonData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="rate" fill="#f97316" radius={[4, 4, 0, 0]} name="Events/km" />
              </BarChart>
            </ResponsiveContainer>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.198 }}
            className="bg-card border border-border rounded-3xl p-5 shadow-sm"
          >
            <h2 className="font-semibold mb-1">Day of Week</h2>
            <p className="text-xs text-muted-foreground mb-4">Which days produce the safest drives</p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={dayOfWeekData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                />
                <Bar dataKey="avgScore" fill="#22c55e" radius={[4, 4, 0, 0]} name="Avg score" />
                <Bar dataKey="events" fill="#ef4444" radius={[4, 4, 0, 0]} name="Risk events" />
              </BarChart>
            </ResponsiveContainer>
          </motion.div>

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
                <Line type="monotone" dataKey="avgSviScore" stroke="#14b8a6" strokeWidth={2} dot={false} name="Speed Smoothness" />
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
            <h2 className="font-semibold mb-1">Event Trends - Last 6 Months</h2>
            <p className="text-xs text-muted-foreground mb-4">Harsh braking vs rapid acceleration per month</p>
            <ResponsiveContainer width="100%" height={170}>
              <BarChart data={eventTrendData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 11 }}
                  formatter={(v, name) => [v, name === 'harshBrakes' ? 'Harsh Brakes' : 'Rapid Accels']}
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
                  Most common risk: {riskLabels[summary.most_common_risk]}
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
