import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
const queryData = new Map();
const settings = {
  onboarding_completed: true,
  tracking_mode: 'manual',
  units: 'metric',
  dark_mode: 'system',
  location_permission_granted: true,
  activity_permission_granted: true,
  notification_permission_granted: true,
  background_location_granted: false,
  tracking_paused: false,
  auto_tracking_enabled: false,
  background_tracking_enabled: false,
  speed_limit_lookup_enabled: true,
  weather_context_enabled: true,
  map_matching_enabled: false,
  osrm_map_matching_url: '',
  phone_use_show_on_map: true,
};

const sampleTrip = {
  id: 'trip-1',
  status: 'completed',
  start_time: '2026-01-01T12:00:00.000Z',
  end_time: '2026-01-01T12:12:00.000Z',
  distance_km: 8.4,
  duration_seconds: 720,
  score_overall: 88,
  score_safety: 91,
  score_smoothness: 86,
  score_eco: 84,
  avg_speed_kmh: 42,
  avg_running_speed_kmh: 48,
  max_speed_kmh: 74,
  harsh_brakes_count: 1,
  sharp_turns_count: 0,
  speeding_events_count: 1,
  near_miss_count: 0,
  road_type: 'urban',
  dominant_road_type: 'urban',
  route_points: [
    { lat: 43.65, lng: -79.38, speed_kmh: 42, timestamp: '2026-01-01T12:00:00.000Z' },
    { lat: 43.651, lng: -79.381, speed_kmh: 46, timestamp: '2026-01-01T12:06:00.000Z' },
    { lat: 43.652, lng: -79.382, speed_kmh: 40, timestamp: '2026-01-01T12:12:00.000Z' },
  ],
  driving_events: [{ type: 'harsh_brake', timestamp: '2026-01-01T12:04:00.000Z', value: -3.8 }],
  highway_score: { overall: 90 },
  urban_score: { overall: 84 },
  residential_score: { overall: 92 },
  highway_compliance: { score: 100 },
  urban_compliance: { score: 88, limit_source: 'openstreetmap' },
  residential_compliance: { score: 100 },
  speed_limit_context: { status: 'fetched', source: 'openstreetmap_overpass', coverage: 67 },
  weather_context: { provider: 'open-meteo', status: 'fetched', condition: 'rain', riskScore: 22, riskLevel: 'low' },
  map_matching_context: { provider: 'osrm', status: 'needs_endpoint' },
  segment_scores: [92, 88, 86],
  fatigue_progression: 'slight',
  phone_use_risk: 'none',
};

vi.mock('framer-motion', () => {
  const passthrough = (tag) => ({ children, ...props }) => React.createElement(tag, props, children);
  return {
    AnimatePresence: ({ children }) => <>{children}</>,
    motion: new Proxy({}, { get: (_target, tag) => passthrough(tag) }),
  };
});

vi.mock('recharts', () => {
  const Box = ({ children }) => <div>{children}</div>;
  return {
    Area: Box,
    AreaChart: Box,
    Line: Box,
    LineChart: Box,
    ResponsiveContainer: Box,
    Tooltip: Box,
    XAxis: Box,
    YAxis: Box,
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }) => ({
    data: queryData.get(JSON.stringify(queryKey)) ?? [],
    isLoading: false,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ id: 'trip-1' }),
}));

vi.mock('@/components/ScoreRing', () => ({
  default: ({ score, label }) => <div>{label || 'Score'} {score}</div>,
}));

vi.mock('@/components/TripMap', () => ({
  default: () => <div>Trip map placeholder</div>,
}));

vi.mock('@/components/TripCard', () => ({
  default: ({ trip }) => <article>{trip.id}</article>,
}));

vi.mock('@/components/LiveCoachOverlay', () => ({
  default: () => <div>Live coach placeholder</div>,
}));

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }) => <div>{children}</div>,
  AlertDialogAction: ({ children }) => <button>{children}</button>,
  AlertDialogCancel: ({ children }) => <button>{children}</button>,
  AlertDialogContent: ({ children }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }) => <h2>{children}</h2>,
  AlertDialogTrigger: ({ children }) => <>{children}</>,
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }) => <div>{children}</div>,
  DialogContent: ({ children }) => <div>{children}</div>,
  DialogDescription: ({ children }) => <p>{children}</p>,
  DialogHeader: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children }) => <h2>{children}</h2>,
}));

vi.mock('@/components/ui/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/lib/trackingStore', () => ({
  activeTripStore: {
    get: vi.fn(() => null),
    set: vi.fn(),
    clear: vi.fn(),
  },
  applyThemeMode: vi.fn(),
  getLastParkedLocation: vi.fn(() => null),
  localSettings: {
    get: vi.fn(() => settings),
    hydrateFromNative: vi.fn(async () => settings),
    set: vi.fn(),
    update: vi.fn((patch) => Object.assign(settings, patch)),
  },
  saveLastParkedLocation: vi.fn(),
  validateSettingsPatch: vi.fn(() => ({ valid: true, errors: [] })),
}));

vi.mock('@/lib/activityRecognition', () => ({
  AUTO_START_GPS_FALLBACK_SECONDS: 2,
  AUTO_START_IN_VEHICLE_CONFIDENCE: 65,
  AUTO_START_IN_VEHICLE_SECONDS: 2,
  AUTO_START_SPEED_KMH: 5,
  computeGpsPositionDrift: vi.fn(() => null),
  getAndroidBatteryOptimizationStatus: vi.fn(async () => ({ batteryOptimizationIgnored: true })),
  getAndroidPhoneUsageSummary: vi.fn(async () => ({})),
  getNativeAutoTrackingStatus: vi.fn(async () => ({ enabled: false })),
  openAndroidBatteryOptimizationSettings: vi.fn(),
  openAndroidUsageAccessSettings: vi.fn(),
  shouldAutoStartTracking: vi.fn(() => false),
  shouldAutoStopTracking: vi.fn(() => false),
  startActivityRecognition: vi.fn(async () => () => {}),
  startNativeAutoTracking: vi.fn(async () => ({})),
  stopNativeAutoTracking: vi.fn(async () => ({})),
}));

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: () => false,
  isNativePlatform: () => false,
}));

vi.mock('@/lib/permissions', () => ({
  getPermissionExplanation: (key) => `${key} permission`,
  getPermissionStatus: vi.fn(async () => ({
    foregroundLocation: 'granted',
    backgroundLocation: 'not_requested',
    activityRecognition: 'granted',
    notifications: 'granted',
    motionSensors: 'not_requested',
    bluetooth: 'not_requested',
  })),
  requestActivityRecognitionPermission: vi.fn(async () => 'granted'),
  requestBackgroundLocationPermission: vi.fn(async () => 'granted'),
  requestForegroundLocationPermission: vi.fn(async () => 'granted'),
  requestNotificationPermission: vi.fn(async () => 'granted'),
}));

describe('core page component renders', () => {
  beforeEach(() => {
    queryData.clear();
    queryData.set(JSON.stringify(['recent-trips']), [sampleTrip]);
    queryData.set(JSON.stringify(['vehicles']), [{ id: 'vehicle-1', name: 'Commuter', fuel_type: 'gasoline' }]);
    queryData.set(JSON.stringify(['trip', 'trip-1']), sampleTrip);
    queryData.set(JSON.stringify(['settings-trips']), [sampleTrip]);
    queryData.set(JSON.stringify(['settings-vehicles']), [{ id: 'vehicle-1', name: 'Commuter' }]);
  });

  it('renders Dashboard readiness and recent-trip surfaces', async () => {
    const { default: Dashboard } = await import('@/pages/Dashboard');
    const html = renderToStaticMarkup(<Dashboard />);

    expect(html).toContain('Dashboard');
    expect(html).toContain('Tracking is ready');
    expect(html).toContain('Why tracking did or did not start');
    expect(html).toContain('trip-1');
  }, 10_000);

  it('renders TripDetail with road, weather, and feedback sections', async () => {
    const { default: TripDetail } = await import('@/pages/TripDetail');
    const html = renderToStaticMarkup(<TripDetail />);

    expect(html).toContain('Back');
    expect(html).toContain('Trip map placeholder');
    expect(html).toContain('OpenStreetMap');
    expect(html).toContain('Open-Meteo');
    expect(html).toContain('Safety');
  });

  it('renders Settings tracking, permission, and external-context controls', async () => {
    const { default: Settings } = await import('@/pages/Settings');
    const html = renderToStaticMarkup(<Settings />);

    expect(html).toContain('Settings');
    expect(html).toContain('Tracking Mode');
    expect(html).toContain('Android Permissions');
    expect(html).toContain('Snap route to roads');
    expect(html).toContain('Automatically get speed limits');
  });
});
