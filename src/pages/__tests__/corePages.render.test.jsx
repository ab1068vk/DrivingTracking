import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCORING_VERSION } from '@/lib/tripEngine';

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
    motion: new Proxy({}, { get: (_target, tag) => passthrough(tag) }),
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
  default: ({ score, label, evidence }) => <div data-evidence={evidence}>{label || 'Score'} {score}</div>,
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
  getAndroidUsageAccessStatus: vi.fn(async () => ({ usageAccessGranted: false })),
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
    delete settings.advanced_safety_detection_enabled;
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
    expect(html).toContain('data-evidence="low"');
    expect(html).toContain('approximate');
  }, 10_000);

  it('labels historical context as estimated and shows its signal breakdown', async () => {
    queryData.set(JSON.stringify(['recent-trips']), Array.from({ length: 5 }, (_, index) => ({
      ...sampleTrip,
      id: `trip-${index + 1}`,
      start_time: new Date(Date.now() - index * 3600000).toISOString(),
    })));
    const { default: Dashboard } = await import('@/pages/Dashboard');
    const html = renderToStaticMarkup(<Dashboard />);

    expect(html).toContain('Estimated historical context');
    expect(html).toContain('Signal contributions');
    expect(html).toContain('Driving-event density');
    expect(html).toContain('not validated against collision or casualty outcomes');
  });

  it('withholds historical context when completed history has no recorded distance', async () => {
    queryData.set(JSON.stringify(['recent-trips']), Array.from({ length: 5 }, (_, index) => ({
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
    expect(html).toContain('Trip map placeholder');
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

    expect(html).toContain('Speed-limit score uses inferred limits');
    expect(html).toContain('half-weighted');
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

  it('renders Settings tracking, permission, and external-context controls', async () => {
    const { default: Settings } = await import('@/pages/Settings');
    const html = renderToStaticMarkup(<Settings />);

    expect(html).toContain('Settings');
    expect(html).toContain('Tracking Mode');
    expect(html).toContain('Android Permissions');
    expect(html).toContain('Snap route to roads');
    expect(html).toContain('Share route samples with OSRM?');
    expect(html).toContain('Automatic road-data fetching');
    expect(html).toContain('Calibration registry');
    expect(html).toContain('Trip penalty scale factor');
    expect(html).toContain('Uncalibrated - scores are self-consistent');
    expect(html).toContain('Status: Provisional');
    expect(html).toContain('Affects score_overall, score_safety');
    expect(html).toContain('approximate');
    expect(html).toContain('Personal-use estimates only');
  });

  it('shows tire-life estimate calibration warning on Vehicles', async () => {
    queryData.set(JSON.stringify(['vehicles']), [{
      id: 'vehicle-1',
      name: 'Commuter',
      fuel_type: 'gasoline',
      fuel_efficiency_l_per_100km: 8.5,
      tire_rotation_interval_km: 10000,
    }]);
    queryData.set(JSON.stringify(['all-trips-vehicles']), [{
      ...sampleTrip,
      vehicle_id: 'vehicle-1',
      trip_tire_wear_units: 220,
      trip_tire_wear_has_missing_speed_data: false,
    }]);
    const { default: Vehicles } = await import('@/pages/Vehicles');
    const html = renderToStaticMarkup(<Vehicles />);

    expect(html).toContain('Tire wear impact');
    expect(html).toContain('Provisional tire estimate');
    expect(html).toContain('estimated tire life reduction');
    expect(html).toContain('Reference-speed model is provisional; not physical tread wear.');
  });

  it('renders only insufficient-data UBI status below the score-card evidence threshold', async () => {
    queryData.set(JSON.stringify(['report-trips']), [{
      ...sampleTrip,
      distance_km: 8.4,
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
    }]);
    const { default: Reports } = await import('@/pages/Report');
    const html = renderToStaticMarkup(<Reports />);

    expect(html).toContain('Driver Score Card');
    expect(html).toContain('Insufficient data');
    expect(html).toContain('Complete at least 50 km');
    expect(html).toContain('NOT AN INSURANCE RATING');
    expect(html).toContain('internal coaching estimate');
    expect(html).not.toContain('Non-preferred');
    expect(html).not.toContain('N/A');
  });

  it('shows the insurance-validation warning beside a scored UBI card', async () => {
    queryData.set(JSON.stringify(['report-trips']), [{
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
    queryData.set(JSON.stringify(['report-trips']), [{
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
  });

  it('gates trip-history score deltas until three prior trips exist', async () => {
    const { scoreDeltaForTrip, SCORE_DELTA_MIN_PREVIOUS_TRIPS } = await import('@/pages/TripHistory');
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
  });
});
