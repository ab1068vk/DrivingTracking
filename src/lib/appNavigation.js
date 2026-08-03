const safeTripPath = (tripId) => {
  if (tripId == null || tripId === '') return null;
  return `/trips/${encodeURIComponent(String(tripId))}`;
};

export function pathForNotificationExtra(extra = {}) {
  const tripPath = safeTripPath(extra.tripId);
  if (tripPath) return tripPath;

  switch (extra.type) {
    case 'phone_use_pattern':
      return '/coach';
    case 'maintenance':
      return '/vehicles';
    case 'parking_reminder':
    case 'parking_review':
      return '/parking';
    case 'weekly_report':
      return '/reports';
    case 'weekly_pattern':
      return '/insights';
    case 'achievement':
    case 'achievement_batch':
    case 'harsh_brake_streak':
      return '/achievements';
    case 'export_saved':
      return '/reports';
    case 'daily_fatigue_warning':
    case 'fatigue_break':
    case 'inactive_nudge':
    case 'safe_driving_tip':
    case 'phone_use':
    case 'speeding':
    case 'heading_drift_beta_warning':
      return '/';
    default:
      return null;
  }
}

export function pathFromAppUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'drivesense:') return null;
    const destination = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);
    if (destination === 'trips' && segments[0]) return safeTripPath(decodeURIComponent(segments[0]));
    if (destination === 'settings') return '/settings';
    if (destination === 'parking') {
      if (['save', 'verify', 'history', 'found', 'reminder'].includes(segments[0])) {
        return `/parking?action=${segments[0]}`;
      }
      return '/parking';
    }
    if (destination === 'dashboard') return '/';
    if (destination === 'coach') return '/coach';
    if (destination === 'reports') return '/reports';
    if (destination === 'achievements') return '/achievements';
    return null;
  } catch {
    return null;
  }
}

/**
 * Capacitor may keep returning the original Android launch intent when React
 * remounts after an app lock, theme change, or WebView lifecycle transition.
 * Consume that cold-start URL only once so later in-app navigation remains in
 * the user's control. Live `appUrlOpen` events intentionally bypass this gate.
 */
export function createInitialAppUrlConsumer() {
  const consumed = new Set();
  return (value) => {
    const key = String(value || '').trim();
    if (!key || consumed.has(key)) return null;
    consumed.add(key);
    return pathFromAppUrl(key);
  };
}
