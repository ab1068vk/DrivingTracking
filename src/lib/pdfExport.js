import { jsPDF } from 'jspdf';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { isNativePlatform } from '@/lib/nativePlatform';
import { calculateNoHarshBrakeStreak, estimateTripEconomics } from '@/lib/tripInsights';
import { formatDate, formatDistance, formatDuration, generateReportSummary } from '@/lib/tripEngine';

function periodLabel(period) {
  if (period === 'week') return 'This Week';
  if (period === 'month') return 'This Month';
  if (period === 'all') return 'All Time';
  return String(period || 'Selected Period');
}

function writeRow(doc, columns, y, widths) {
  let x = 14;
  columns.forEach((value, index) => {
    doc.text(String(value ?? ''), x, y, { maxWidth: widths[index] - 2 });
    x += widths[index];
  });
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function mostImprovedWeek(trips = []) {
  const byWeek = new Map();
  trips.forEach((trip) => {
    const date = new Date(trip.start_time);
    if (Number.isNaN(date.getTime())) return;
    const weekStart = new Date(date);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const key = weekStart.toISOString().slice(0, 10);
    const bucket = byWeek.get(key) || [];
    bucket.push(Number(trip.score_overall) || 0);
    byWeek.set(key, bucket);
  });
  const weeks = [...byWeek.entries()]
    .map(([key, scores]) => ({ key, avg: scores.reduce((sum, score) => sum + score, 0) / scores.length }))
    .sort((a, b) => a.key.localeCompare(b.key));
  let best = null;
  for (let i = 1; i < weeks.length; i++) {
    const delta = weeks[i].avg - weeks[i - 1].avg;
    if (!best || delta > best.delta) best = { ...weeks[i], delta };
  }
  return best ? `${best.key} (${best.delta >= 0 ? '+' : ''}${Math.round(best.delta)} pts)` : 'Not enough weekly history';
}

export async function exportMonthlyReportPDF(trips = [], period = 'month', settings = {}) {
  const doc = new jsPDF();
  const summary = generateReportSummary(trips);
  const now = new Date();
  const filename = `drivesense-monthly-report-${period}-${now.toISOString().slice(0, 10)}.pdf`;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.text('DriveSense', 14, 24);
  doc.setFontSize(16);
  doc.text(`${periodLabel(period)} Driving Report`, 14, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Exported ${now.toLocaleString()}`, 14, 46);

  const coverRows = [
    ['Total trips', summary.total_trips],
    ['Total distance', formatDistance(summary.total_distance_km, settings.units)],
    ['Total drive time', formatDuration(summary.total_duration_seconds)],
    ['Average score', summary.avg_score],
  ];
  let y = 62;
  coverRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold');
    doc.text(label, 14, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(value), 70, y);
    y += 10;
  });
  doc.text('Full charts available in the app under Reports.', 14, 120);

  doc.addPage();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Score Breakdown', 14, 20);
  doc.setFontSize(8);
  const widths = [24, 22, 22, 18, 18, 20, 16, 20, 20];
  writeRow(doc, ['Date', 'Distance', 'Duration', 'Overall', 'Safety', 'Smooth', 'Eco', 'Brakes', 'Speeding'], 32, widths);
  doc.setFont('helvetica', 'normal');
  y = 40;
  trips.slice(0, 24).forEach((trip) => {
    if (y > 280) {
      doc.addPage();
      y = 20;
    }
    writeRow(doc, [
      formatDate(trip.start_time),
      formatDistance(trip.distance_km || 0, settings.units),
      formatDuration(trip.duration_seconds || 0),
      trip.score_overall ?? '',
      trip.score_safety ?? '',
      trip.score_smoothness ?? '',
      trip.score_eco ?? '',
      trip.harsh_brakes_count ?? 0,
      trip.speeding_events_count ?? 0,
    ], y, widths);
    y += 8;
  });

  doc.addPage();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Summary Stats', 14, 20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);

  const sortedByDistance = [...trips].sort((a, b) => (b.distance_km || 0) - (a.distance_km || 0));
  const economics = trips.reduce((totals, trip) => {
    const estimate = estimateTripEconomics(trip, {}, settings);
    return {
      cost: totals.cost + estimate.cost,
      co2: totals.co2 + estimate.co2_kg,
    };
  }, { cost: 0, co2: 0 });
  const streak = calculateNoHarshBrakeStreak(trips);
  const summaryRows = [
    ['Best trip', summary.best_trip ? `${formatDate(summary.best_trip.start_time)} (${summary.best_trip.score_overall})` : 'None'],
    ['Worst trip', summary.worst_trip ? `${formatDate(summary.worst_trip.start_time)} (${summary.worst_trip.score_overall})` : 'None'],
    ['Longest trip', sortedByDistance[0] ? `${formatDate(sortedByDistance[0].start_time)} · ${formatDistance(sortedByDistance[0].distance_km || 0, settings.units)}` : 'None'],
    ['Most improved week', mostImprovedWeek(trips)],
    ['Total estimated fuel cost', `$${economics.cost.toFixed(2)}`],
    ['Total CO2', `${economics.co2.toFixed(1)} kg`],
    ['No-harsh-brake streak', `${streak} day${streak === 1 ? '' : 's'}`],
  ];
  y = 36;
  summaryRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold');
    doc.text(label, 14, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(value), 76, y, { maxWidth: 110 });
    y += 12;
  });
  doc.text('Full charts available in the app under Reports.', 14, y + 10);

  if (isNativePlatform()) {
    const base64 = arrayBufferToBase64(doc.output('arraybuffer'));
    return saveExportToDownloads({
      filename,
      data: base64,
      mimeType: 'application/pdf',
      base64: true,
    });
  }

  doc.save(filename);
  return { filename, native: false };
}
