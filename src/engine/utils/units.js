export function getScoreColor(score) {
  if (score >= 85) return { color: 'text-green-500', fill: 'bg-green-500', stroke: '#22c55e', bg: 'bg-green-50 dark:bg-green-950/30', label: 'Excellent' };
  if (score >= 70) return { color: 'text-blue-500', fill: 'bg-blue-500', stroke: '#3b82f6', bg: 'bg-blue-50 dark:bg-blue-950/30', label: 'Good' };
  if (score >= 55) return { color: 'text-yellow-500', fill: 'bg-yellow-500', stroke: '#eab308', bg: 'bg-yellow-50 dark:bg-yellow-950/30', label: 'Fair' };
  if (score >= 40) return { color: 'text-orange-500', fill: 'bg-orange-500', stroke: '#f97316', bg: 'bg-orange-50 dark:bg-orange-950/30', label: 'Poor' };
  return { color: 'text-red-500', fill: 'bg-red-500', stroke: '#ef4444', bg: 'bg-red-50 dark:bg-red-950/30', label: 'Risky' };
}

export function getScoreGradient(score) {
  if (score >= 85) return 'from-green-400 to-emerald-500';
  if (score >= 70) return 'from-blue-400 to-blue-600';
  if (score >= 55) return 'from-yellow-400 to-orange-400';
  if (score >= 40) return 'from-orange-400 to-red-400';
  return 'from-red-500 to-red-700';
}

// ─── Format Utilities ──────────────────────────────────────────────────────────
export function formatDuration(seconds) {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDistance(km, units = 'metric') {
  if (units === 'imperial') {
    const miles = km * 0.621371;
    return `${miles.toFixed(1)} mi`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export function formatSpeed(kmh, units = 'metric') {
  if (units === 'imperial') return `${Math.round(kmh * 0.621371)} mph`;
  return `${Math.round(kmh)} km/h`;
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '';
  return `${formatDate(dateStr)} ${formatTime(dateStr)}`;
}
