import { jsPDF } from 'jspdf';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { isNativePlatform } from '@/lib/nativePlatform';
import { calculateNoHarshBrakeStreak, estimateTripEconomics } from '@/lib/tripInsights';
import { formatDate, formatDistance, formatDuration, generateReportSummary } from '@/lib/tripEngine';
import { formatCurrencyAmount } from '@/lib/currency';

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
    bucket.push({
      score: Number(trip.score_overall) || 0,
      distance: Number(trip.distance_km) || 0,
    });
    byWeek.set(key, bucket);
  });
  const weeks = [...byWeek.entries()]
    .map(([key, scores]) => {
      const totalKm = scores.reduce((sum, item) => sum + item.distance, 0);
      return {
        key,
        avg: totalKm > 0 ? scores.reduce((sum, item) => sum + item.score * item.distance, 0) / totalKm : 0,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  let best = null;
  for (let i = 1; i < weeks.length; i++) {
    const delta = weeks[i].avg - weeks[i - 1].avg;
    if (!best || delta > best.delta) best = { ...weeks[i], delta };
  }
  return best ? `${best.key} (${best.delta >= 0 ? '+' : ''}${Math.round(best.delta)} pts)` : 'Not enough weekly history';
}

function drawHorizontalBars(doc, title, rows, startY, options = {}) {
  const maxValue = Math.max(1, ...rows.map((row) => Number(row.value) || 0));
  const barWidth = options.barWidth || 86;
  const barX = options.barX || 78;
  let y = startY;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(title, 14, y);
  y += 10;
  doc.setFontSize(8);
  rows.forEach((row) => {
    const value = Number(row.value) || 0;
    const width = Math.max(1, (value / maxValue) * barWidth);
    const color = row.color || [59, 130, 246];
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(40);
    doc.text(String(row.label), 14, y + 3, { maxWidth: barX - 18 });
    doc.setDrawColor(230);
    doc.setFillColor(245, 245, 245);
    doc.roundedRect(barX, y - 2, barWidth, 5, 1, 1, 'FD');
    doc.setFillColor(color[0], color[1], color[2]);
    doc.roundedRect(barX, y - 2, width, 5, 1, 1, 'F');
    doc.setFont('helvetica', 'bold');
    doc.text(String(row.display ?? value), barX + barWidth + 5, y + 3);
    y += 9;
  });
  doc.setTextColor(0);
  return y;
}

function recentTripTrendRows(trips = []) {
  return [...trips]
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
    .slice(-8)
    .map((trip) => ({
      label: formatDate(trip.start_time),
      value: Number(trip.score_overall) || 0,
      display: `${Math.round(Number(trip.score_overall) || 0)} score`,
      color: (trip.score_overall || 0) >= 80 ? [34, 197, 94] : (trip.score_overall || 0) >= 60 ? [234, 179, 8] : [239, 68, 68],
    }));
}

/**
 * @param {Array<object>} trips
 * @param {string} period
 * @param {{units?:string,currencySymbol?:string}} settings
 */
export async function exportMonthlyReportPDF(trips = [], period = 'month', settings = {}) {
  const tripList = Array.isArray(trips) ? trips : [];
  const doc = new jsPDF();
  const summary = generateReportSummary(tripList);
  const now = new Date();
  const filename = `road-sage-monthly-report-${period}-${now.toISOString().slice(0, 10)}.pdf`;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.text('Road Sage', 14, 24);
  doc.setFontSize(16);
  doc.text(`${periodLabel(period)} Driving Report`, 14, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Exported ${now.toLocaleString()}`, 14, 46);
  doc.setFontSize(8);
  doc.text(
    'GPS proxy limitation: score components may include low-confidence brake onset smoothness and stop-start patterns. They do not measure human reaction time or following distance.',
    14,
    52,
    { maxWidth: 182 }
  );

  const coverRows = [
    ['Total trips', summary.total_trips],
    ['Total distance', formatDistance(summary.total_distance_km, settings.units)],
    ['Total drive time', formatDuration(summary.total_duration_seconds)],
    ['Average score', summary.avg_score],
  ];
  let y = 70;
  coverRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold');
    doc.text(label, 14, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(value), 70, y);
    y += 10;
  });
  const trendRows = recentTripTrendRows(tripList);
  if (trendRows.length) {
    drawHorizontalBars(doc, 'Recent Score Trend', trendRows, 120, { barWidth: 72, barX: 72 });
  }

  doc.addPage();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Score Breakdown', 14, 20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('Safety and Smoothness include only GPS-derived behavioral proxies where applicable; see the cover limitation note.', 14, 27, { maxWidth: 180 });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  const widths = [24, 22, 22, 18, 18, 20, 16, 20, 20];
  writeRow(doc, ['Date', 'Distance', 'Duration', 'Overall', 'Safety', 'Smooth', 'Eco', 'Brakes', 'Speeding'], 38, widths);
  doc.setFont('helvetica', 'normal');
  y = 46;
  tripList.slice(0, 24).forEach((trip) => {
    if (y > 280) {
      doc.addPage();
      y = 20;
    }
    writeRow(doc, [
      formatDate(trip.start_time),
      formatDistance(trip.distance_km ?? 0, settings.units),
      formatDuration(trip.duration_seconds ?? 0),
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

  const sortedByDistance = [...tripList].sort((a, b) => (b.distance_km ?? 0) - (a.distance_km ?? 0));
  const economics = tripList.reduce((totals, trip) => {
    const estimate = estimateTripEconomics(trip, {}, settings);
    return {
      cost: totals.cost + estimate.cost,
      co2: totals.co2 + estimate.co2_kg,
    };
  }, { cost: 0, co2: 0 });
  const streak = calculateNoHarshBrakeStreak(tripList);
  const summaryRows = [
    ['Best trip', summary.best_trip ? `${formatDate(summary.best_trip.start_time)} (${summary.best_trip.score_overall})` : 'None'],
    ['Worst trip', summary.worst_trip ? `${formatDate(summary.worst_trip.start_time)} (${summary.worst_trip.score_overall})` : 'None'],
    ['Longest trip', sortedByDistance[0] ? `${formatDate(sortedByDistance[0].start_time)} - ${formatDistance(sortedByDistance[0].distance_km ?? 0, settings.units)}` : 'None'],
    ['Most improved week', mostImprovedWeek(tripList)],
    ['Total estimated fuel cost', formatCurrencyAmount(economics.cost, settings)],
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
  const riskRows = [
    { label: 'Harsh brakes', value: summary.total_harsh_brakes || 0, color: [239, 68, 68] },
    { label: 'Rapid acceleration', value: summary.total_rapid_accels || 0, color: [245, 158, 11] },
    { label: 'Sharp turns', value: summary.total_sharp_turns || 0, color: [59, 130, 246] },
    { label: 'Speeding', value: summary.total_speeding_events || 0, color: [249, 115, 22] },
  ];
  drawHorizontalBars(doc, 'Risk Event Breakdown', riskRows, y + 12, { barWidth: 82, barX: 78 });

  if (isNativePlatform()) {
    const base64 = arrayBufferToBase64(doc.output('arraybuffer'));
    const result = await saveExportToDownloads({
      filename,
      data: base64,
      mimeType: 'application/pdf',
      base64: true,
    });
    return { ...result, filename, native: true };
  }

  doc.save(filename);
  return { filename, native: false };
}

export async function exportUBIReportPDF(ubiReport, settings = {}) {
  const doc = new jsPDF();
  const now = new Date(ubiReport.generatedAt || Date.now());
  const filename = `road-sage-driver-score-card-${now.toISOString().slice(0, 10)}.pdf`;
  const period = ubiReport.periodStart && ubiReport.periodEnd
    ? `${formatDate(ubiReport.periodStart)} to ${formatDate(ubiReport.periodEnd)}`
    : 'No completed trips';

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Road Sage - Driver Score Card', 14, 22);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Generated: ${now.toLocaleDateString()}`, 14, 32);
  doc.text(`Period: ${period}`, 14, 39);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(42);
  doc.text(ubiReport.ubiScore == null ? '-' : `${ubiReport.ubiScore}`, 92, 70, { align: 'center' });
  doc.setFontSize(12);
  doc.text('/ 100', 111, 70);
  doc.setFontSize(14);
  doc.text(`${ubiReport.ubiGrade} - ${ubiReport.ubiTier}`, 92, 82, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const hours = Math.floor((ubiReport.totalDrivingMinutes || 0) / 60);
  const minutes = Math.round((ubiReport.totalDrivingMinutes || 0) % 60);
  doc.text(
    `Trips: ${ubiReport.tripCount || 0}  |  Distance: ${(ubiReport.totalKm || 0).toFixed(1)} km  |  Drive time: ${hours}h ${minutes}m`,
    92,
    92,
    { align: 'center' }
  );

  const rows = Object.values(ubiReport.categories || {});
  let y = 114;
  doc.setFont('helvetica', 'bold');
  writeRow(doc, ['Category', 'Score', 'Grade', 'Detail'], y, [58, 28, 24, 60]);
  y += 8;
  doc.setFont('helvetica', 'normal');
  rows.forEach((row) => {
    const score = Number(row.score) || 0;
    const color = score >= 80 ? [34, 197, 94] : score >= 60 ? [234, 179, 8] : [239, 68, 68];
    writeRow(doc, [row.label, score, row.grade, row.value], y, [58, 28, 24, 60]);
    doc.setFillColor(color[0], color[1], color[2]);
    doc.rect(72, y + 2, Math.max(1, score / 5), 2, 'F');
    y += 11;
  });

  doc.setTextColor(120);
  doc.setFontSize(8);
  doc.text(ubiReport.disclaimer || '', 14, 270, { maxWidth: 180 });
  doc.text('Powered by Road Sage - private, local-only data', 14, 280);
  doc.setTextColor(0);

  if (isNativePlatform()) {
    const base64 = arrayBufferToBase64(doc.output('arraybuffer'));
    const result = await saveExportToDownloads({
      filename,
      data: base64,
      mimeType: 'application/pdf',
      base64: true,
    });
    return { ...result, filename, native: true };
  }

  doc.save(filename);
  return { filename, native: false };
}
