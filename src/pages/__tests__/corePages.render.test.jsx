import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCORING_VERSION } from '@/lib/tripEngine';

// CHANGES (session):
// - Updated TripDetail render expectation to require posted-sign estimate wording.

const navigate = vi.fn();
const queryData = new Map();
const setTripSummaries = (trips) => {
  queryData.set(JSON.stringify(['trip-summaries']), trips);
  queryData.set(JSON.stringify(['trip-summaries', 'limited', 50]), trips);
  queryData.set(JSON.stringify(['trip-summaries', 'limited', 12]), trips);
  queryData.set(JSON.stringify(['trip-summaries', 'limited', 30]), trips);
  queryData.set(JSON.stringify(['trip-summaries', 'limited', 100]), trips);
};
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
  score_safety_confidence: 'developing',
  score_smoothness: 86,
  score_smoothness_confidence: 'low',
  score_eco: 84,
  score_eco_confidence: 'high',
  component_scores: {
    braking_efficiency: { value: 68, evidence: 'developing', dataSource: ['gps'] },
    speed_limit_compliance: { value: 79, evidence: 'developing', dataSource: ['osm_speed_limit'] },
    eco_driving: { value: 84, evidence: 'high', dataSource: ['gps'] },
  },
  score_provenance: {
    computed_at: '2026-05-24T17:23:44.000Z',
    scoring_version: SCORING_VERSION,
    components: { overall: 'developing', safety: 'developing' },
    constants_snapshot: { PENALTY_SCALE_FACTOR: 40 },
  },
  score_provenance_change: {
    previous_scoring_version: '2.0.0',
    current_scoring_version: SCORING_VERSION,
    reason: 'scoring_inputs_changed',
    changed_constants: ['PENALTY_SCALE_FACTOR'],
  },
  avg_speed_kmh: 42,
  avg_running_speed_kmh: 48,
  max_speed_kmh: 74,
  harsh_brakes_count: 1,
  sharp_turns_count: 0,
  speeding_events_count: 1,
  close_proximity_count: 0,
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
    MotionConfig: ({ children }) => <>{children}</>,
    motion: new Proxy({}, { get: (_target, tag) => passthrough(tag) }),
    useReducedMotion: () => false,
  };
});

vi.mock('recharts', () => {
  const Box = ({ children }) => <div>{children}</div>;
  const Chart = () => <svg />;
  return {
    Area: Box,
    AreaChart: Chart,
    Bar: Box,
    BarChart: Chart,
    CartesianGrid: Box,
    Cell: Box,
    Line: Box,
    LineChart: Chart,
    Pie: Box,
    PieChart: Chart,
    PolarAngleAxis: Box,
    PolarGrid: Box,
    Radar: Box,
    RadarChart: Chart,
    ResponsiveContainer: Box,
    Tooltip: Box,
    XAxis: Box,
    YAxis: Box,
  };
});

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: Symbol('keepPreviousData'),
  useQuery: ({ queryKey }) => {
    const value = queryData.get(JSON.stringify(queryKey));
    const error = value instanceof Error ? value : null;
    return {
      data: error ? undefined : value ?? [],
      isLoading: false,
      isFetching: false,
      isError: Boolean(error),
      error,
      refetch: vi.fn(),
    };
  },
  useQueries: ({ queries = [] }) => queries.map(({ queryKey }) => ({
    data: queryData.get(JSON.stringify(queryKey)) ?? null,
    isLoading: false,
    isError: false,
  })),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    prefetchQuery: vi.fn(() => Promise.resolve()),
    setQueryData: vi.fn(),
  }),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => navigate,
  useParams: () => ({ id: 'trip-1' }),
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),
}));

vi.mock('@/components/ScoreRing', () => ({
  default: ({ score, label, evidence }) => <div data-evidence={evidence}>{label || 'Score'} {score}</div>,
}));

vi.mock('@/components/TripMap', () => ({
  default: () => <div>Trip map placeholder</div>,
}));

vi.mock('@/components/TripPlayback', () => ({
  default: () => <div>Trip playback placeholder</div>,
}));

vi.mock('@/components/TripDrive3D', () => ({
  default: () => <div>Trip drive 3D placeholder</div>,
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
  DialogFooter: ({ children }) => <div>{children}</div>,
  DialogHeader: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children }) => <h2>{children}</h2>,
}));

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked }) => <input readOnly type="checkbox" checked={checked} />,
}));

vi.mock('@/components/ui/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/lib/trackingStore', () => ({
  ACTIVE_TRIP_KEY: 'drivesense_active_trip',
  ACTIVE_TRIP_CHANGED_EVENT: 'roadsage-active-trip-changed',
  LAST_PARKED_KEY: 'drivesense_last_parked',
  SETTINGS_KEY: 'drivesense_settings',
  VOICE_ALERT_STYLE_VALUES: ['mode_default', 'coaching', 'technical'],
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
  clearSettingsMemoryForErasure: vi.fn(),
  saveLastParkedLocation: vi.fn(),
  validateSettingsPatch: vi.fn(() => ({ valid: true, errors: [] })),
}));

vi.mock('@/lib/activityRecognition', () => ({
  AUTO_START_GPS_FALLBACK_SECONDS: 2,
  AUTO_START_IN_VEHICLE_CONFIDENCE: 65,
  AUTO_START_IN_VEHICLE_SECONDS: 2,
  AUTO_START_SPEED_KMH: 5,
  computeGpsPositionDrift: vi.fn(() => null),
  clearNativeDiagnostics: vi.fn(async () => {}),
  getAndroidBatteryOptimizationStatus: vi.fn(async () => ({ batteryOptimizationIgnored: true })),
  getAndroidPhoneUsageSummary: vi.fn(async () => ({})),
  getAndroidUsageAccessStatus: vi.fn(async () => ({ usageAccessGranted: false })),
  getNativeAutoTrackingStatus: vi.fn(async () => ({ enabled: false, recordingActive: false, activeTrip: null })),
  normalizeNativeActiveTrip: vi.fn((status) => status?.recordingActive ? status.activeTrip : null),
  endNativeActiveTrip: vi.fn(async () => true),
  getNativeDiagnostics: vi.fn(async () => ({ enabled: false, events: [] })),
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

vi.mock('@/lib/sensorFusionModel', () => ({
  buildMotionSensorDiagnostics: vi.fn(() => ({
    crashDetectionActive: false,
    evidenceSource: 'none',
    inactiveReasons: ['motion permission unknown'],
    permissionState: 'not_requested',
    quality: 'none',
    sampleCount: 0,
    sensorAvailable: true,
    supportNote: 'Motion diagnostics unavailable in this render test.',
  })),
  getMotionSensorSupport: vi.fn(() => ({
    available: true,
    secureContext: true,
    status: 'not_requested',
  })),
  requestMotionSensorPermission: vi.fn(async () => 'granted'),
}));

describe('core page component renders', () => {
  beforeEach(async () => {
    const { activeTripStore } = await import('@/lib/trackingStore');
    activeTripStore.get.mockReturnValue(null);
    queryData.clear();
    delete settings.advanced_safety_detection_enabled;
    settings.premium_visual_experience = false;
    settings.experience_mode = 'coaching';
    settings.voice_alert_style = 'mode_default';
    settings.predictive_route_risk_enabled = true;
    setTripSummaries([sampleTrip]);
    queryData.set(JSON.stringify(['vehicles']), [{ id: 'vehicle-1', name: 'Commuter', fuel_type: 'gasoline' }]);
    queryData.set(JSON.stringify(['trip', 'trip-1']), sampleTrip);
    queryData.set(JSON.stringify(['settings-trips']), [sampleTrip]);
    queryData.set(JSON.stringify(['settings-vehicles']), [{ id: 'vehicle-1', name: 'Commuter' }]);
    queryData.set(JSON.stringify(['tracking-speed-console-trips']), [sampleTrip]);
    queryData.set(JSON.stringify(['tracking-speed-console-knowledge']), { cells: {}, corrections: [] });
    queryData.set(JSON.stringify(['tracking-reports-trips']), [sampleTrip]);
    queryData.set(JSON.stringify(['tracking-reports-speed-knowledge']), { cells: {}, corrections: [] });
    queryData.set(JSON.stringify(['tracking-reports-system-logs']), []);
    queryData.set(JSON.stringify(['tracking-reports-native-diagnostics']), { events: [] });
    queryData.set(JSON.stringify(['tracking-replay-pro-trips']), [
      { ...sampleTrip, id: 'trip-1', route_replay_available: true },
      {
        ...sampleTrip,
        id: 'trip-2',
        start_time: '2026-01-02T12:00:00.000Z',
        distance_km: 8.6,
        avg_speed_kmh: 45,
        route_replay_available: true,
        route_points: sampleTrip.route_points.map((point, index) => ({
          ...point,
          lat: point.lat + 0.00005,
          lng: point.lng + 0.00005,
          timestamp: new Date(Date.parse(point.timestamp) + index * 1000).toISOString(),
        })),
        driving_events: [{ type: 'speeding', timestamp: '2026-01-02T12:06:00.000Z', speed_kmh: 72, speed_limit_kmh: 60 }],
      },
    ]);
  });

  it('renders Dashboard readiness and recent-trip surfaces', async () => {
    const { default: Dashboard } = await import('@/pages/Dashboard');
    const html = renderToStaticMarkup(<Dashboard />);

    expect(html).toContain('Dashboard');
    expect(html).toContain('Tracking is ready');
    expect(html).toContain('Why tracking did or did not start');
    expect(html).toContain('trip-1');
    expect(html).toContain('data-evidence="low"');
    expect(html).toContain('approximate');
  }, 10_000);

  it('renders the Driving Coach mission shell with secondary tools collapsed', async () => {
    const { default: DrivingCoach } = await import('@/pages/DrivingCoach');
    const html = renderToStaticMarkup(<DrivingCoach />);

    expect(html).toContain('Driving Coach');
    expect(html).toContain('Today');
    expect(html).toContain('Program');
    expect(html).toContain('Patterns');
    expect(html).toContain('Driver Model');
    expect(html).toContain('<details');
    expect(html).toContain('Open your supporting weekly goals');
    expect(html).toContain('Open the local evidence assistant');
  });


  it('renders TrackingOverview empty state without trips', async () => {
    const { activeTripStore } = await import('@/lib/trackingStore');
    activeTripStore.get.mockReturnValue(null);
    setTripSummaries([]);
    const { default: TrackingOverview } = await import('@/pages/TrackingOverview');
    const html = renderToStaticMarkup(<TrackingOverview />);

    expect(html).toContain('Track your next drive');
    expect(html).toContain('No completed trips');
    expect(html).toContain('No route data available');
    expect(html).toContain('GPS permission');
    expect(html).toContain('Advanced tracking insights');
    expect(html).toContain('Waiting for drives');
  });

  it('renders TrackingOverview loaded and active-trip state', async () => {
    const { activeTripStore } = await import('@/lib/trackingStore');
    activeTripStore.get.mockReturnValue({
      ...sampleTrip,
      id: 'active-trip',
      end_time: null,
      start_source: 'manual',
      route_points: sampleTrip.route_points,
      driving_events: sampleTrip.driving_events,
    });
    setTripSummaries([sampleTrip]);
    const { default: TrackingOverview } = await import('@/pages/TrackingOverview');
    const html = renderToStaticMarkup(<TrackingOverview />);

    expect(html).toContain('Recording active');
    expect(html).toContain('Live drive telemetry');
    expect(html).toContain('Drive');
    expect(html).toContain('Route');
    expect(html).toContain('Signals');
    expect(html).toContain('Speed unavailable');
    expect(html).toContain('Route points retained');
    expect(html).toContain('Score estimate');
    expect(html).toContain('~88');
    expect(html).toContain('trip-1');
    expect(html).toContain('Route retention');
    expect(html).toContain('100%');
  });

  it('renders each advanced live telemetry cockpit view from a deterministic snapshot', async () => {
    const { LiveTrackingCockpit } = await import('@/pages/TrackingOverview');
    const snapshot = {
      state: 'recording',
      gps: { tone: 'good', label: 'GPS ±7 m', key: 'strong', accuracyM: 7, fixAgeSeconds: 1 },
      updateAgeSeconds: 1,
      currentSpeedKmh: 48,
      speedLimitKmh: 50,
      speedLimitSource: 'user_confirmed_posted_sign',
      speedDeltaKmh: -2,
      routePreview: [
        { lat: 43.65, lng: -79.38, speed_kmh: 30 },
        { lat: 43.651, lng: -79.379, speed_kmh: 48 },
      ],
      eventCounts: { harsh_brake: 1 },
      events: [{ title: 'Braking threshold exceeded', timestamp: new Date().toISOString(), speedKmh: 42 }],
      latestEvent: { title: 'Braking threshold exceeded', timestamp: new Date().toISOString(), speedKmh: 42 },
      possibleIncidentActive: false,
      durationSeconds: 300,
      distanceKm: 3.25,
      averageSpeedKmh: 39,
      maxSpeedKmh: 71,
      stoppedSeconds: 22,
      routePointCount: 90,
      routeMaskedCount: 0,
      routeGapCount: 1,
      gapSeconds: 3,
      headingDeg: 32,
      altitudeM: 92,
      accelerationMs2: -1.2,
      lateralG: 0.1,
      headingRateDegS: 2,
      linearMotionMagnitudeMs2: 1.3,
      rotationMagnitudeDegS: 3,
      activityType: 'in_vehicle',
      activityConfidence: 90,
      motionSampleCount: 400,
      linearAccelerationSensorReady: true,
      gyroscopeSensorReady: true,
      maxDriftSinceStopM: 2,
    };
    const props = { snapshot, onViewChange: vi.fn(), nativeActive: true, ending: false, onEnd: vi.fn() };

    const drive = renderToStaticMarkup(<LiveTrackingCockpit {...props} view="drive" />);
    const route = renderToStaticMarkup(<LiveTrackingCockpit {...props} view="route" />);
    const signals = renderToStaticMarkup(<LiveTrackingCockpit {...props} view="signals" />);
    const imperialDrive = renderToStaticMarkup(<LiveTrackingCockpit {...props} units="imperial" view="drive" />);

    expect(drive).toContain('Current speed');
    expect(drive).toContain('Braking threshold exceeded');
    expect(drive).toContain('3.3 km');
    expect(drive).toContain('39 km/h');
    expect(imperialDrive).toContain('2.0 mi');
    expect(imperialDrive).toContain('30');
    expect(imperialDrive).toContain('mph');
    expect(route).toContain('API-free route view');
    expect(route).toContain('It does not require map tiles, routing services, or a paid API.');
    expect(signals).toContain('GPS evidence');
    expect(signals).toContain('Motion evidence');
    expect(signals).toContain('Recorder state');
  });

  it('renders TrackingOverview trip-loading error with an in-place retry', async () => {
    queryData.set(JSON.stringify(['trip-summaries']), new Error('Local store unavailable'));
    const { default: TrackingOverview } = await import('@/pages/TrackingOverview');
    const html = renderToStaticMarkup(<TrackingOverview />);

    expect(html).toContain('Recent trips could not be loaded');
    expect(html).toContain('Retry loading trips');
    expect(html).toContain('Your recordings are still stored locally');
  });

  it('renders Milestones with a prioritized next step and advanced progression details', async () => {
    const { default: Achievements } = await import('@/pages/Achievements');
    const html = renderToStaticMarkup(<Achievements />);

    expect(html).toContain('Milestones');
    expect(html).toContain('Recommended next step');
    expect(html).toContain('Adaptive missions');
    expect(html).toContain('How XP is earned');
    expect(html).toContain('Mastery');
    expect(html).toContain('Records');
    expect(html).toContain('History');
  });

  it('renders a retry state when Milestones trip history cannot be loaded', async () => {
    queryData.set(JSON.stringify(['trip-summaries', 'limited', 50]), new Error('Local store unavailable'));
    queryData.set(JSON.stringify(['trip-summaries']), new Error('Local store unavailable'));
    const { default: Achievements } = await import('@/pages/Achievements');
    const html = renderToStaticMarkup(<Achievements />);

    expect(html).toContain('Milestones could not be loaded');
    expect(html).toContain('Retry loading milestones');
    expect(html).not.toContain('Your progression starts with a real trip');
  });

  it('renders linked TrackingTripDetail analytics and comparison controls', async () => {
    settings.experience_mode = 'tracking';
    const { default: TrackingTripDetail } = await import('@/pages/TrackingTripDetail');
    const html = renderToStaticMarkup(<TrackingTripDetail />);

    expect(html).toContain('Advanced drive details');
    expect(html).toContain('Compare speed profile');
    expect(html).toContain('Linked telemetry analysis');
    expect(html).toContain('Speed and recorded limit');
    expect(html).toContain('Acquisition quality');
    expect(html).toContain('Observation timeline');
  });

  it('renders TrackingMapWorkspace empty state without trips', async () => {
    setTripSummaries([]);
    const { default: TrackingMapWorkspace } = await import('@/pages/TrackingMapWorkspace');
    const html = renderToStaticMarkup(<TrackingMapWorkspace />);

    expect(html).toContain('Route Map');
    expect(html).toContain('No completed trips match');
    expect(html).toContain('No route selected');
    expect(html).toContain('Timeline tracks');
  });

  it('renders TrackingMapWorkspace privacy-masked event details without raw coordinates', async () => {
    const privateTrip = {
      ...sampleTrip,
      route_points: [
        ...sampleTrip.route_points,
        {
          timestamp: '2026-01-01T12:08:00.000Z',
          lat: null,
          lng: null,
          privacy_gap: true,
          masked_for_privacy: true,
          privacy_zone_label: 'Home',
        },
      ],
      driving_events: [{
        type: 'speeding',
        timestamp: '2026-01-01T12:04:00.000Z',
        speed_kmh: 72,
        speed_limit_kmh: 50,
        source: 'gps',
        lat: null,
        lng: null,
        privacy_event_redacted: true,
        masked_for_privacy: true,
        privacy_zone_label: 'Home',
      }],
    };
    setTripSummaries([privateTrip]);
    queryData.set(JSON.stringify(['trip', 'trip-1']), privateTrip);
    const { default: TrackingMapWorkspace } = await import('@/pages/TrackingMapWorkspace');
    const html = renderToStaticMarkup(<TrackingMapWorkspace />);

    expect(html).toContain('Route Map');
    expect(html).toContain('Trip map placeholder');
    expect(html).toContain('Speeding');
    expect(html).toContain('privacy masked');
    expect(html).toContain('Raw coordinates are not shown');
    expect(html).not.toContain('43.65');
  });

  it('renders TrackingEvents empty state without trip events', async () => {
    const quietTrip = {
      ...sampleTrip,
      driving_events: [],
      phone_use_events: [],
      route_points: [
        { lat: 43.65, lng: -79.38, speed_kmh: 42, timestamp: '2026-01-01T12:00:00.000Z' },
        { lat: 43.651, lng: -79.381, speed_kmh: 46, timestamp: '2026-01-01T12:00:30.000Z' },
        { lat: 43.652, lng: -79.382, speed_kmh: 40, timestamp: '2026-01-01T12:01:00.000Z' },
      ],
    };
    setTripSummaries([quietTrip]);
    queryData.set(JSON.stringify(['trip', 'trip-1']), quietTrip);
    const { default: TrackingEvents } = await import('@/pages/TrackingEvents');
    const html = renderToStaticMarkup(<TrackingEvents />);

    expect(html).toContain('Drive Event Timeline');
    expect(html).toContain('Recorded events');
    expect(html).toContain('No events recorded for the selected filters.');
  });

  it('renders TrackingEvents loaded telemetry rows and inspector labels', async () => {
    const eventTrip = {
      ...sampleTrip,
      driving_events: [
        ...sampleTrip.driving_events,
        {
          type: 'phone_use',
          source: 'gps_proxy',
          diagnostic_only: true,
          timestamp: '2026-01-01T12:06:00.000Z',
          durationS: 15,
          confidence: 0.7,
        },
      ],
    };
    setTripSummaries([eventTrip]);
    queryData.set(JSON.stringify(['trip', 'trip-1']), eventTrip);
    const { default: TrackingEvents } = await import('@/pages/TrackingEvents');
    const html = renderToStaticMarkup(<TrackingEvents />);

    expect(html).toContain('Drive Event Timeline');
    expect(html).toContain('Hard braking event');
    expect(html).toContain('Phone-use window detected');
    expect(html).toContain('GPS diagnostic proxy');
    expect(html).toContain('diagnostic / not scored');
    expect(html).toContain('Why Detected');
  });

  it('renders TrackingSpeedConsole source confidence and edit-flow links', async () => {
    const speedTrip = {
      ...sampleTrip,
      route_points: [
        { lat: 43.65, lng: -79.38, speed_kmh: 42, speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' },
        { lat: 43.651, lng: -79.381, speed_kmh: 72, speed_limit_kmh: 60, speed_limit_source: 'region_default_estimate' },
      ],
    };
    queryData.set(JSON.stringify(['tracking-speed-console-trips']), [speedTrip]);
    queryData.set(JSON.stringify(['tracking-speed-console-knowledge']), {
      cells: {
        dpz83f: { limitKmh: 50, source: 'trip_consensus', confidence: 0.55 },
      },
      corrections: [{
        id: 'posted-rule',
        roadName: 'King Street',
        limitKmh: 40,
        source: 'user_confirmed_posted_sign',
      }],
    });
    const { default: TrackingSpeedConsole } = await import('@/pages/TrackingSpeedConsole');
    const html = renderToStaticMarkup(<TrackingSpeedConsole />);

    expect(html).toContain('Speed Intelligence');
    expect(html).toContain('Posted signs override app estimates');
    expect(html).toContain('Your confirmed posted sign');
    expect(html).toContain('Local learned estimate');
    expect(html).toContain('/speed-limits?view=review');
    expect(html).toContain('/trips/trip-1/speed');
    expect(html).toContain('threshold exceeded');
    expect(html).not.toMatch(/speeding bad/i);
  });

  it('renders TrackingPrivacyConsole authentication gate without exposing privacy details', async () => {
    const { default: TrackingPrivacyConsole } = await import('@/pages/TrackingPrivacyConsole');
    const html = renderToStaticMarkup(<TrackingPrivacyConsole />);

    expect(html).toContain('Unlock Trip Privacy');
    expect(html).toContain('local device authentication');
    expect(html).not.toContain('43.65');
    expect(html).not.toContain('Outbound Road Data');
  });

  it('renders TrackingAlertsLab shared voice alert controls', async () => {
    settings.experience_mode = 'tracking';
    settings.voice_alert_style = 'mode_default';
    const { default: TrackingAlertsLab } = await import('@/pages/TrackingAlertsLab');
    const html = renderToStaticMarkup(<TrackingAlertsLab />);

    expect(html).toContain('Driving Alerts');
    expect(html).toContain('Speed Tier Cooldowns');
    expect(html).toContain('Ownership Rules');
    expect(html).toContain('Hard braking event recorded.');
    expect(html).toContain('Speed threshold exceeded: 74 km/h in posted 60 km/h zone.');
  });

  it('renders TrackingEvidenceConsole data quality rows', async () => {
    settings.experience_mode = 'tracking';
    queryData.set(JSON.stringify(['trip', 'trip-1']), {
      ...sampleTrip,
      route_points_raw_count: 4,
      route_points_map_count: 3,
      obd_powertrain_sample_count: 0,
      phone_use_score_status: 'android_usage_access',
      phone_use_window_count: 2,
    });
    const { default: TrackingEvidenceConsole } = await import('@/pages/TrackingEvidenceConsole');
    const html = renderToStaticMarkup(<TrackingEvidenceConsole />);

    expect(html).toContain('Data Quality');
    expect(html).toContain('Evidence Rows');
    expect(html).toContain('GPS route samples');
    expect(html).toContain('Scoring version');
    expect(html).toContain('provisional notes visible');
    expect(html).toContain('What data exists and how reliable it is');
  });

  it('renders TrackingReportsLab technical export options', async () => {
    settings.experience_mode = 'tracking';
    const { default: TrackingReportsLab } = await import('@/pages/TrackingReportsLab');
    const html = renderToStaticMarkup(<TrackingReportsLab />);

    expect(html).toContain('Share and Export Trips');
    expect(html).toContain('Trip event CSV');
    expect(html).toContain('Route point quality summary');
    expect(html).toContain('Speed-source audit CSV');
    expect(html).toContain('Privacy-safe technical PDF');
    expect(html).toContain('Signed technical manifest');
    expect(html).toContain('Private coords');
    expect(html).toContain('not exported');
  });

  it('renders TrackingReplayPro compare and chapter surfaces', async () => {
    settings.experience_mode = 'tracking';
    const { default: TrackingReplayPro } = await import('@/pages/TrackingReplayPro');
    const html = renderToStaticMarkup(<TrackingReplayPro />);

    expect(html).toContain('Compare Drive Replays');
    expect(html).toContain('Primary trip');
    expect(html).toContain('Comparison trip');
    expect(html).toContain('Speed timeline overlay');
    expect(html).toContain('Event timeline overlay');
    expect(html).toContain('Route gap comparison');
    expect(html).toContain('Privacy gap indicators');
    expect(html).toContain('3D Replay Event Chapters');
    expect(html).toContain('Trip playback placeholder');
  });

  it('labels historical context as estimated and shows its signal breakdown', async () => {
    setTripSummaries(Array.from({ length: 5 }, (_, index) => ({
      ...sampleTrip,
      id: `trip-${index + 1}`,
      start_time: new Date(Date.now() - index * 3600000).toISOString(),
    })));
    const { default: Dashboard } = await import('@/pages/Dashboard');
    const html = renderToStaticMarkup(<Dashboard />);

    expect(html).toContain('Pre-trip readiness planner');
    expect(html).toContain('Before you start');
    expect(html).toContain('Better window');
    expect(html).toContain('Saved speed checks');
    expect(html).toContain('Watch road areas');
    expect(html).toContain('Estimated historical context');
    expect(html).toContain('Signal contributions');
    expect(html).toContain('Driving-event density');
    expect(html).toContain('not validated against collision or casualty outcomes');
  });

  it('withholds historical context when completed history has no recorded distance', async () => {
    setTripSummaries(Array.from({ length: 5 }, (_, index) => ({
      ...sampleTrip,
      id: `zero-trip-${index + 1}`,
      distance_km: 0,
      start_time: new Date(Date.now() - index * 3600000).toISOString(),
    })));
    const { default: Dashboard } = await import('@/pages/Dashboard');
    const html = renderToStaticMarkup(<Dashboard />);

    expect(html).toContain('Historical context');
    expect(html).toContain('Not enough driving history');
    expect(html).not.toContain('Estimated historical context');
    expect(html).not.toContain('Signal contributions');
  });

  it('removes historical context from readiness when the setting is disabled', async () => {
    settings.predictive_route_risk_enabled = false;
    setTripSummaries(Array.from({ length: 5 }, (_, index) => ({
      ...sampleTrip,
      id: `risky-trip-${index + 1}`,
      score_overall: 20,
      harsh_brakes_count: 8,
      speeding_events_count: 6,
      sharp_turns_count: 4,
      start_time: new Date(Date.now() - index * 3600000).toISOString(),
    })));
    const { default: Dashboard } = await import('@/pages/Dashboard');
    const html = renderToStaticMarkup(<Dashboard />);

    expect(html).not.toContain('Estimated historical context');
    expect(html).not.toContain('Signal contributions');
    expect(html).not.toContain('Historical context estimate looks elevated');
  });

  it('renders TripDetail with road, weather, and feedback sections', async () => {
    queryData.set(JSON.stringify(['trip', 'trip-1']), {
      ...sampleTrip,
      hill_driving_score: 80,
      distraction_score: 88,
      distraction_score_confidence: 'low',
      climb_distance_km: 0.7,
      descent_distance_km: 0.4,
      estimated_private_distance_km: 0.4,
    });
    const { default: TripDetail } = await import('@/pages/TripDetail');
    const html = renderToStaticMarkup(<TripDetail />);

    expect(html).toContain('Back');
    expect(html).toContain('Loading trip map');
    expect(html).toContain('OpenStreetMap');
    expect(html).toContain('Open-Meteo');
    expect(html).toContain('Safety');
    expect(html).not.toContain('developing evidence');
    expect(html).toContain('low evidence');
    expect(html).not.toContain('high evidence');
    expect(html).toContain('Scoring provenance');
    expect(html).toContain('approximate');
    expect(html).not.toContain(`Version ${SCORING_VERSION}`);
    expect(html).toContain('Updated constants: PENALTY_SCALE_FACTOR.');
    expect(html).toContain('GPS altitude estimate');
    expect(html).toContain('Hill-driving limitation');
    expect(html).toContain('GPS and altitude-derived estimate only');
    expect(html).toContain('traveled within privacy zones (estimated)');
    expect(html).toContain('legitimate uphill manoeuvre');
    expect(html).toContain('attention-pattern estimate');
    expect(html).toContain('What shaped this score');
    expect(html).toContain('does not reconstruct exact point deductions');
    expect(html).toContain('Braking efficiency');
    expect(html).toContain('Does this trip score look fair?');
    expect(html).toContain('<h2 class="min-w-0 text-sm font-semibold leading-tight">Does this trip score look fair?</h2>');
    expect(html).toContain('>Review<');
    expect(html).not.toContain('What made the score seem too harsh?');
    expect(html).not.toContain('Three consistent eligible reviews');
    expect(html).not.toContain('Focus Score');
  });

  it('labels inferred speed-limit scoring at score level on TripDetail', async () => {
    queryData.set(JSON.stringify(['trip', 'trip-1']), {
      ...sampleTrip,
      route_points: sampleTrip.route_points.map((point) => ({
        ...point,
        speed_limit_source: 'inferred',
      })),
      urban_compliance: {
        score: 88,
        limit_source: 'inferred',
        penalty_weight: 0.5,
        inferred_limit_kmh: 50,
        max_excess_kmh: 12,
        rate: 0.9,
      },
      component_scores: {
        overall: { value: 88, evidence: 'developing', dataSource: ['gps', 'gps_inferred_speed_limit'], sampleCount: 3 },
        safety: { value: 91, evidence: 'developing', dataSource: ['gps', 'gps_inferred_speed_limit'], sampleCount: 3 },
        speed_limit_compliance: { value: 88, evidence: 'developing', dataSource: ['gps_inferred_speed_limit'], sampleCount: 3 },
      },
    });
    const { default: TripDetail } = await import('@/pages/TripDetail');
    const html = renderToStaticMarkup(<TripDetail />);

    expect(html).toContain('Speed-limit score uses estimated limits');
    expect(html).toContain('not proof of the posted speed limit');
    expect(html).toContain('REGION_DEFAULT is more reliable than GPS-only inference');
    expect(html).toContain('Sources');
    expect(html).toContain('GPS-inferred speed limit');
    expect(html).toContain('3 samples');
  });

  it('shows brake onset smoothness data collection state on TripDetail', async () => {
    queryData.set(JSON.stringify(['trip', 'trip-1']), {
      ...sampleTrip,
      brake_onset_smoothness_score: null,
      brake_onset_smoothness_confidence: 'low',
      brake_onset_sequence_count: 1,
    });
    const { default: TripDetail } = await import('@/pages/TripDetail');
    const html = renderToStaticMarkup(<TripDetail />);

    expect(html).toContain('Brake onset smoothness: 1 of 2 qualifying brake events recorded.');
  });

  it('surfaces heading diagnostics on TripDetail when Advanced Safety is off', async () => {
    settings.advanced_safety_detection_enabled = false;
    queryData.set(JSON.stringify(['trip', 'trip-1']), {
      ...sampleTrip,
      heading_deviation_available: true,
      heading_deviation_scoring_enabled: false,
      heading_deviation_count: 1,
      driving_events: [
        { type: 'heading_deviation', timestamp: '2026-01-01T12:05:00.000Z', value: 4.2, speed_kmh: 82 },
      ],
    });
    const { default: TripDetail } = await import('@/pages/TripDetail');
    const html = renderToStaticMarkup(<TripDetail />);

    expect(html).toContain('Heading Events (Beta)');
    expect(html).toContain('Enable Advanced Safety to include this in your score');
    expect(html).toContain('Diagnostic-Only Events (Not Scored)');
  });

  it('shows public OSRM demo provenance on TripDetail', async () => {
    queryData.set(JSON.stringify(['trip', 'trip-1']), {
      ...sampleTrip,
      map_matching_context: {
        provider: 'osrm',
        status: 'matched',
        snapped_coverage: 100,
        isOsrmDemoUrl: true,
      },
    });
    const { default: TripDetail } = await import('@/pages/TripDetail');
    const html = renderToStaticMarkup(<TripDetail />);

    expect(html).toContain('Road-matched via public OSRM demo');
  });

  it('renders unavailable parking score instead of a fabricated perfect score', async () => {
    queryData.set(JSON.stringify(['trip', 'trip-1']), {
      ...sampleTrip,
      parking_approach_score: null,
      parking_approach_score_confidence: 'unavailable',
    });
    const { default: TripDetail } = await import('@/pages/TripDetail');
    const html = renderToStaticMarkup(<TripDetail />);
    const parkingIndex = html.indexOf('Parking');
    const parkingSlice = html.slice(parkingIndex, parkingIndex + 500);

    expect(parkingIndex).toBeGreaterThanOrEqual(0);
    expect(parkingSlice).toContain('Unavailable');
    expect(parkingSlice).not.toContain('>100<');
  });

  it('renders Settings as a compact settings-area hub', async () => {
    const { default: Settings } = await import('@/pages/Settings');
    const html = renderToStaticMarkup(<Settings />);

    expect(html).toContain('Settings');
    expect(html).toContain('Settings areas');
    expect(html).toContain('Choose an area to configure');
    expect(html).toContain('Driving &amp; Device');
    expect(html).toContain('Preferences');
    expect(html).toContain('Coaching &amp; Detection');
    expect(html).toContain('Select a settings area');
    expect(html).toContain('Search settings, permissions, tracking, privacy');
    expect(html).not.toContain('Choose a settings area');
    expect(html).toContain('Tracking');
    expect(html).toContain('Android Permissions');
    expect(html).toContain('Advanced Models');
    expect(html).toContain('Speed &amp; Road Data');
    expect(html).toContain('Privacy &amp; Data');
    expect(html).not.toContain('Tracking Mode');
    expect(html).not.toContain('Snap route to roads');
    expect(html).toContain('Share route samples with OSRM?');
    expect(html).toContain('Personal-use informational estimates only');
  });

  it('explains map trips hidden by raw GPS retention using the retention count', async () => {
    const expiredByRetention = {
      ...sampleTrip,
      id: 'expired-by-retention-1',
      route_points: [],
      route_points_raw_count: 72,
      route_data_expired_at: '2026-06-01T00:00:00.000Z',
      route_data_expiration_reason: 'raw_gps_retention_policy',
    };
    const secondExpiredByRetention = {
      ...expiredByRetention,
      id: 'expired-by-retention-2',
      route_points_raw_count: 48,
    };
    const summaryOnlyWithoutRetention = {
      ...sampleTrip,
      id: 'summary-only-without-retention',
      route_points: [],
      route_points_raw_count: 0,
      route_data_expired_at: undefined,
      route_data_expiration_reason: undefined,
    };
    setTripSummaries([
      sampleTrip,
      expiredByRetention,
      secondExpiredByRetention,
      summaryOnlyWithoutRetention,
    ]);

    const { default: MapScreen } = await import('@/pages/MapScreen');
    const html = renderToStaticMarkup(<MapScreen />);

    expect(html).toContain('Show all filtered trips');
    expect(html).toContain('2 completed trip summaries are not shown here because raw GPS retention removed route coordinates for map/playback. Summaries stay saved in Trip History.');
    expect(html).not.toContain('because route GPS is unavailable');
    expect(html).not.toContain('3 completed trip summaries are hidden');
  });

  it('uses summary map point counts on the map trip list', async () => {
    setTripSummaries([{
      ...sampleTrip,
      id: 'summary-map-count',
      route_points: undefined,
      route_points_raw_count: 72,
      route_points_map_count: 64,
      route_replay_available: true,
    }]);

    const { default: MapScreen } = await import('@/pages/MapScreen');
    const html = renderToStaticMarkup(<MapScreen />);

    expect(html).toContain('72 GPS readings - 64 map/playback points');
    expect(html).not.toContain('72 GPS readings - 0 map/playback points');
  });

  it('renders Diagnostics recovery compatibility as read-only identity facts', async () => {
    queryData.set(JSON.stringify(['diagnostics-trips']), [sampleTrip]);
    const { buildRecoveryCompatibilitySnapshot, default: Diagnostics } = await import('@/pages/Diagnostics');
    const html = renderToStaticMarkup(<Diagnostics />);

    expect(buildRecoveryCompatibilitySnapshot({ tracking_mode: 'background_auto' }, true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Android package', value: 'com.drivesense.app' }),
        expect.objectContaining({ label: 'Settings key', value: 'drivesense_settings' }),
        expect.objectContaining({ label: 'Trip database', value: 'drivesense_mobile' }),
      ])
    );
    expect(html).toContain('Recovery Compatibility');
    expect(html).toContain('com.drivesense.app');
    expect(html).toContain('drivesense_settings');
    expect(html).toContain('drivesense_mobile');
    expect(html).toContain('No writes');
  });

  it('renders the system logs page with export controls and retention text', async () => {
    const { default: SystemLogs } = await import('@/pages/SystemLogs');
    const html = renderToStaticMarkup(<SystemLogs />);

    expect(html).toContain('System Logs');
    expect(html).toContain('Export JSON');
    expect(html).toContain('Export CSV');
    expect(html).toContain('Load failures');
    expect(html).toContain('Privacy logging is kept for 24 hours');
    expect(html).toContain('other system entries expire after 3 days');
  });

  it('keeps legacy tire estimates out of the Vehicles driving-load advisory', async () => {
    queryData.set(JSON.stringify(['vehicles']), [{
      id: 'vehicle-1',
      name: 'Commuter',
      fuel_type: 'gasoline',
      fuel_efficiency_l_per_100km: 8.5,
      tire_rotation_interval_km: 10000,
    }]);
    setTripSummaries([{
      ...sampleTrip,
      vehicle_id: 'vehicle-1',
      trip_tire_wear_units: 220,
      trip_tire_wear_has_missing_speed_data: false,
    }]);
    const { default: Vehicles } = await import('@/pages/Vehicles');
    const html = renderToStaticMarkup(<Vehicles />);

    expect(html).toContain('Driving-load advisory');
    expect(html).toContain('GPS driving-event proxy only');
    expect(html).toContain('does not measure oil condition, tread depth, brake thickness');
    expect(html).toContain('never changes a manufacturer due date');
    expect(html).not.toContain('Tire wear impact');
    expect(html).not.toContain('Provisional tire estimate');
    expect(html).not.toContain('estimated tire life reduction');
    expect(html).not.toContain('Reference-speed model is provisional');
  });

  it('renders only insufficient-data UBI status below the score-card evidence threshold', async () => {
    setTripSummaries([{
      ...sampleTrip,
      distance_km: 8.4,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
    }]);
    const { default: Reports } = await import('@/pages/Report');
    const html = renderToStaticMarkup(<Reports />);

    expect(html).toContain('Driver Score Card');
    expect(html).toContain('Insufficient data');
    expect(html).toContain('Add at least 50 km');
    expect(html).toContain('Export score card PDF with the current insufficient-data status');
    expect(html).toContain('NOT AN INSURANCE RATING');
    expect(html).toContain('internal coaching estimate');
    expect(html).not.toContain('Non-preferred');
    expect(html).not.toContain('N/A');
  });

  it('shows the insurance-validation warning beside a scored UBI card', async () => {
    setTripSummaries([{
      ...sampleTrip,
      distance_km: 60,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
    }]);
    const { default: Reports } = await import('@/pages/Report');
    const html = renderToStaticMarkup(<Reports />);

    expect(html).toContain('Scores are estimates');
    expect(html).toContain('not validated against real-world crash data');
    expect(html).toContain('NOT AN INSURANCE RATING');
    expect(html).toContain('Not insurance');
    expect(html).toContain('Visible limitation');
    expect(html).toContain('Not insurer validated');
    expect(html).toContain('must not be used for insurance eligibility');
    expect(html).toContain('Internal estimate:');
    expect(html).toContain('approximate');
    expect(html).not.toContain('Insufficient data');
  });

  it('labels report fuel outputs as estimates and withholds savings without an assigned vehicle', async () => {
    queryData.set(JSON.stringify(['vehicles']), []);
    setTripSummaries([{
      ...sampleTrip,
      vehicle_id: null,
      distance_km: 60,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
    }]);
    const { default: Reports } = await import('@/pages/Report');
    const html = renderToStaticMarkup(<Reports />);

    expect(html).toContain('Estimated Fuel Cost');
    expect(html).toContain('Estimated Fuel Saved');
    expect(html).toContain('Unavailable');
    expect(html).toContain('Assign vehicles to trips to unlock CO2 savings estimates.');
    expect(html).toContain('Export package');
    expect(html).toContain('CSV trip table');
    expect(html).toContain('This Week PDF');
    expect(html).toContain('Driver score card PDF');
    expect(html).toContain('do not modify trips, settings, backups, storage names, or permissions');
  });

  it('summarizes report export scope without changing export formats', async () => {
    const { buildReportExportSummary } = await import('@/pages/Report');
    const summary = buildReportExportSummary([
      { start_time: '2026-01-02T12:00:00.000Z' },
      { start_time: '2026-01-01T12:00:00.000Z' },
    ], 'month');

    expect(summary).toMatchObject({
      periodLabel: 'This Month',
      tripCount: 2,
      description: '2 completed trips included',
      formats: ['CSV trip table', 'This Month PDF', 'Driver score card PDF'],
    });
    expect(summary.dateRangeLabel).toContain('to');
  });

  it('gates trip-history score deltas until three prior trips exist', async () => {
    const { buildTripHistorySummary, scoreDeltaForTrip, SCORE_DELTA_MIN_PREVIOUS_TRIPS } = await import('@/pages/TripHistory');
    const ordered = [
      { id: 'newest', score_overall: 90 },
      { id: 'prior-1', score_overall: 70 },
      { id: 'prior-2', score_overall: 72 },
      { id: 'prior-3', score_overall: 75 },
    ];

    expect(SCORE_DELTA_MIN_PREVIOUS_TRIPS).toBe(3);
    expect(scoreDeltaForTrip(ordered[0], ordered.slice(0, 2))).toMatchObject({
      delta: null,
      direction: 'flat',
      insufficientBaseline: true,
      sampleCount: 1,
    });
    expect(scoreDeltaForTrip(ordered[0], ordered)).toMatchObject({
      direction: 'up',
      insufficientBaseline: false,
      sampleCount: 3,
    });

    expect(buildTripHistorySummary([
      { distance_km: 10, duration_seconds: 600, score_overall: 80, is_favorite: true },
      { distance_km: 5, duration_seconds: 300, score_overall: 90, night_driving: true },
    ], 'metric')).toMatchObject({
      count: 2,
      totalDistanceKm: 15,
      totalDurationSeconds: 900,
      averageScore: 85,
      totalDistanceLabel: '15.0 km',
      totalDurationLabel: '15m 0s',
      averageScoreLabel: '85',
      favoriteCount: 1,
      nightCount: 1,
    });
  });

  it('renders a read-only trip-history snapshot for the current filters', async () => {
    setTripSummaries([
      sampleTrip,
      {
        ...sampleTrip,
        id: 'trip-2',
        distance_km: 5,
        duration_seconds: 300,
        score_overall: 72,
        is_favorite: true,
        start_time: '2026-01-02T12:00:00.000Z',
      },
    ]);
    const { default: TripHistory } = await import('@/pages/TripHistory');
    const html = renderToStaticMarkup(<TripHistory />);

    expect(html).toContain('Filtered snapshot');
    expect(html).toContain('2 matching trips');
    expect(html).toContain('13.4 km');
    expect(html).toContain('17m');
    expect(html).toContain('Avg score');
  });
  it('renders only 30 Trip cards per page with Map-style arrow controls', async () => {
    setTripSummaries(Array.from({ length: 57 }, (_, index) => ({
      ...sampleTrip,
      id: 'paged-trip-' + index,
      start_time: new Date(Date.UTC(2026, 6, 14, 12, index)).toISOString(),
    })));
    const { default: TripHistory, TRIP_HISTORY_PAGE_SIZE } = await import('@/pages/TripHistory');
    const html = renderToStaticMarkup(<TripHistory />);

    expect(TRIP_HISTORY_PAGE_SIZE).toBe(30);
    expect((html.match(/<article>/g) || [])).toHaveLength(30);
    expect(html).toContain('Showing');
    expect(html).toContain('of <b class="text-foreground">57</b> matching trips');
    expect(html).toContain('aria-label="Previous 30 trips"');
    expect(html).toContain('aria-label="Next 30 trips"');
    expect(html).toContain('1 / 2');
  });

  it('matches combined month, date, distance, duration, score, event, and vehicle searches', async () => {
    const { matchesTripSearchText } = await import('@/pages/TripHistory');
    const { buildTripSearchText } = await import('@/lib/tripMetadata');
    const indexed = buildTripSearchText({
      id: 'smart-search-trip',
      status: 'completed',
      start_time: '2026-07-14T18:30:00.000Z',
      start_address: 'Toronto',
      end_address: 'Mississauga',
      distance_km: 20.4,
      duration_seconds: 1500,
      avg_speed_kmh: 49,
      score_overall: 88,
      harsh_brakes_count: 2,
      notes: 'School pickup',
    }, {
      name: 'Family SUV',
      make: 'Honda',
      model: 'CR-V',
    });

    expect(matchesTripSearchText(indexed, 'july 14 20 km')).toBe(true);
    expect(matchesTripSearchText(indexed, 'score 88 toronto')).toBe(true);
    expect(matchesTripSearchText(indexed, '25 minutes 2 harsh brake')).toBe(true);
    expect(matchesTripSearchText(indexed, 'family suv school pickup')).toBe(true);
    expect(matchesTripSearchText(indexed, 'august 90 km')).toBe(false);
  });
  it('filters trips by practical calendar ranges with inclusive custom dates', async () => {
    const { matchesTripDateFilter } = await import('@/pages/TripHistory');
    const now = new Date();
    const old = new Date(now);
    old.setDate(old.getDate() - 40);

    expect(matchesTripDateFilter({ start_time: now.toISOString() }, 'today')).toBe(true);
    expect(matchesTripDateFilter({ start_time: now.toISOString() }, 'last_7')).toBe(true);
    expect(matchesTripDateFilter({ start_time: old.toISOString() }, 'last_30')).toBe(false);
    expect(matchesTripDateFilter(
      { start_time: '2026-04-10T18:30:00.000Z' },
      'exact_day',
      '2026-04-10'
    )).toBe(true);
    expect(matchesTripDateFilter(
      { start_time: '2026-04-11T18:30:00.000Z' },
      'exact_day',
      '2026-04-10'
    )).toBe(false);
    expect(matchesTripDateFilter(
      { start_time: '2026-04-10T18:30:00.000Z' },
      'custom',
      '2026-04-10',
      '2026-04-10'
    )).toBe(true);
    expect(matchesTripDateFilter(
      { start_time: '2026-04-12T18:30:00.000Z' },
      'custom',
      '2026-04-10',
      '2026-04-11'
    )).toBe(false);
  });

  it('keeps premium trip and map chrome theme-aware and distinguishable', async () => {
    settings.premium_visual_experience = true;

    const { default: TripDetail } = await import('@/pages/TripDetail');
    const tripHtml = renderToStaticMarkup(<TripDetail />);
    expect(tripHtml).toContain('premium-trip-detail-on');
    expect(tripHtml).toContain('trip-detail-identity');

    const { default: MapScreen } = await import('@/pages/MapScreen');
    const mapHtml = renderToStaticMarkup(<MapScreen />);
    expect(mapHtml).toContain('app-page-header premium-map-heading');
    expect(mapHtml.match(/data-map-tab="mode"/g)).toHaveLength(2);
    expect(mapHtml).toContain('data-map-tab="utility"');
  });

  it('gates the premium trip-history surfaces behind the persisted appearance setting', async () => {
    setTripSummaries([
      sampleTrip,
      { ...sampleTrip, id: 'trip-2', start_time: '2026-01-02T12:00:00.000Z' },
    ]);
    settings.premium_visual_experience = true;
    const { default: TripHistory } = await import('@/pages/TripHistory');
    const premiumHtml = renderToStaticMarkup(<TripHistory />);

    expect(premiumHtml).toContain('premium-trip-history-on');
    expect(premiumHtml).toContain('premium-history-filter');
    expect(premiumHtml).toContain('premium-history-snapshot');
    expect(premiumHtml).toContain('premium-history-results');
    expect(premiumHtml).toContain('aria-label="Filter trips by date"');
    expect(premiumHtml).toContain('aria-label="Filter trips by type"');
    expect(premiumHtml).toContain('Showing <strong>1–2</strong> of <strong>2</strong> matching trips');
    expect(premiumHtml.indexOf('aria-label="Virtualized trip history list"'))
      .toBeLessThan(premiumHtml.indexOf('aria-label="Matching trip result pages"'));

    settings.premium_visual_experience = false;
    const standardHtml = renderToStaticMarkup(<TripHistory />);
    expect(standardHtml).not.toContain('premium-trip-history-on');
    expect(standardHtml).toContain('aria-label="Paginated trip history"');
  });
});
