import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStaleTripIds } from '@/hooks/useStaleTripDetection';
import { getCurrentSettingsVersion } from '@/hooks/useSettingsVersion';
import {
  buildDrivingThresholds,
  buildScoreConstantsSnapshot,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
  SCORING_VERSION,
} from '@/lib/tripEngine';
import { DEFAULT_SETTINGS } from '@/lib/trackingStore';

const TRIPS_KEY = 'road_sage_trips';
const OLD_SCORING_VERSION = '00000000';

const routePoint = (index, startMs = Date.UTC(2026, 4, 20, 12, 0, 0)) => ({
  lat: 43.65 + index * 0.00025,
  lng: -79.38,
  timestamp: new Date(startMs + index * 2000).toISOString(),
  speed_kmh: index === 15 ? 105 : 72,
  heading: 0,
  accuracy: 8,
});

const completeScoreFields = (routePoints, settings = DEFAULT_SETTINGS) => {
  const thresholds = buildDrivingThresholds(settings);
  const stats = calculateTripStats(routePoints, routePoints[0].timestamp, routePoints.at(-1).timestamp, thresholds);
  const detection = detectDrivingEvents(routePoints, thresholds, routePoints.at(-1).timestamp);
  const scores = calculateTripScores(detection.events, stats, routePoints, thresholds, stats.duration_seconds, {}, {
    endTime: routePoints.at(-1).timestamp,
    includeRoadTypeSegments: false,
  });
  return {
    ...stats,
    ...scores,
    co2_saved_kg: 0,
    phone_use_score: 100,
    phone_use_risk: 'none',
    dominant_road_type: scores.dominant_road_type || 'urban',
  };
};

const completedTrip = (id, { stale = false, daysAgo = 1 } = {}) => {
  const startMs = Date.now() - daysAgo * 86400000;
  const route_points = Array.from({ length: 40 }, (_, index) => routePoint(index, startMs));
  const scoreFields = completeScoreFields(route_points);
  const thresholds = buildDrivingThresholds(DEFAULT_SETTINGS);
  const settingsVersion = getCurrentSettingsVersion(DEFAULT_SETTINGS);
  return {
    id,
    status: 'completed',
    start_time: route_points[0].timestamp,
    end_time: route_points.at(-1).timestamp,
    route_points,
    ...scoreFields,
    schema_version: 23,
    scored_with_settings_version: stale ? 'old-settings-hash' : settingsVersion,
    score_provenance: {
      ...scoreFields.score_provenance,
      scoring_version: stale ? OLD_SCORING_VERSION : SCORING_VERSION,
      settings_version: stale ? 'old-settings-hash' : settingsVersion,
      constants_snapshot: buildScoreConstantsSnapshot(thresholds),
    },
  };
};

const installWindowProbe = () => {
  const events = [];
  const target = new EventTarget();
  target.addEventListener('road-sage:rescore-progress', (event) => events.push(event.detail));
  vi.stubGlobal('window', target);
  vi.stubGlobal('CustomEvent', class TestCustomEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  });
  return events;
};

const loadRepositoryWithMemoryStorage = async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', undefined);
  const [{ localTripRepository }, { removeJson, setJson }] = await Promise.all([
    import('@/lib/localTripRepository'),
    import('@/lib/mobileStorage'),
  ]);
  await removeJson(TRIPS_KEY);
  return { localTripRepository, setJson, removeJson };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stale trip detection and migration', () => {
  it('identifies trips scored with older scoring versions or settings fingerprints', () => {
    const trips = [
      completedTrip('stale-version', { stale: true }),
      completedTrip('current'),
      { ...completedTrip('candidate', { stale: true }), status: 'candidate' },
    ];

    expect(getStaleTripIds(trips, DEFAULT_SETTINGS)).toEqual(['stale-version']);
  });

  it('updates provenance after a repository re-score', async () => {
    const { localTripRepository, setJson, removeJson } = await loadRepositoryWithMemoryStorage();
    await setJson(TRIPS_KEY, [completedTrip('needs-rescore', { stale: true })]);

    const [rescored] = await localTripRepository.listAll({ sort: 'start_time' });

    expect(rescored.score_provenance.scoring_version).toBe(SCORING_VERSION);
    expect(rescored.score_provenance.settings_version).not.toBe('old-settings-hash');
    expect(rescored.score_provenance_change).toMatchObject({
      previous_scoring_version: OLD_SCORING_VERSION,
      current_scoring_version: SCORING_VERSION,
    });
    await removeJson(TRIPS_KEY);
  });

  it('broadcasts auto-rescore progress when more than 20 percent of recent trips are stale', async () => {
    const broadcasts = installWindowProbe();
    const { localTripRepository, setJson, removeJson } = await loadRepositoryWithMemoryStorage();
    const trips = [
      ...Array.from({ length: 3 }, (_, index) => completedTrip(`stale-${index}`, { stale: true })),
      ...Array.from({ length: 7 }, (_, index) => completedTrip(`current-${index}`)),
    ];
    await setJson(TRIPS_KEY, trips);

    const listed = await localTripRepository.listAll({ sort: 'start_time' });

    expect(listed.filter((trip) => trip.score_provenance.scoring_version === SCORING_VERSION)).toHaveLength(10);
    expect(broadcasts.some((event) => event?.reason === 'auto_provenance' && event.status === 'running')).toBe(true);
    expect(broadcasts.some((event) => event?.reason === 'auto_provenance' && event.status === 'complete')).toBe(true);
    await removeJson(TRIPS_KEY);
  });
});
