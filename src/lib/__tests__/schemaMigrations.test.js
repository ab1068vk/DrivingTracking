import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS } from '@/lib/migrations';
import {
  REQUIRED_TRIP_FIELDS,
  TRIP_SCHEMA_DESCRIPTION,
  missingRequiredTripFields,
} from '@/lib/schema/tripSchema';
import { TRIP_SCHEMA_VERSION } from '@/lib/localTripRepository';

const buildMinimalTripV1 = () => ({
  id: 'trip-schema-v1',
  schema_version: TRIP_SCHEMA_VERSION,
  status: 'completed',
  start_time: '2026-01-01T12:00:00.000Z',
  end_time: '2026-01-01T12:05:00.000Z',
  updated_at: '2026-01-01T12:05:00.000Z',
  route_points: [],
  distance_km: 0,
  duration_seconds: 300,
  score_overall: null,
  score_safety: null,
  score_smoothness: null,
  score_eco: null,
  component_scores: {},
  score_provenance: {
    scoring_version: null,
    components: {},
    constants_snapshot: {},
  },
  driving_events: [],
  vehicle_id: null,
  nickname: null,
  notes: null,
  tags: [],
  is_favorite: false,
});

describe('canonical trip schema', () => {
  it('documents every required trip field', () => {
    for (const field of REQUIRED_TRIP_FIELDS) {
      expect(TRIP_SCHEMA_DESCRIPTION, field).toHaveProperty(field);
    }
  });

  it('reports missing required trip fields', () => {
    expect(missingRequiredTripFields(buildMinimalTripV1())).toEqual([]);
    expect(missingRequiredTripFields({ id: 'partial' })).toEqual(
      expect.arrayContaining(['schema_version', 'status', 'route_points'])
    );
  });
});

describe('backup migration trip schema preservation', () => {
  it('every migration preserves all required trip fields', () => {
    let backup = {
      app: 'Road Sage',
      version: 1,
      vehicles: [],
      trips: [buildMinimalTripV1()],
    };

    for (const migration of ALL_MIGRATIONS) {
      backup = {
        ...migration.migrate(backup),
        version: migration.to,
      };
      const [trip] = backup.trips;

      for (const field of REQUIRED_TRIP_FIELDS) {
        expect(
          Object.prototype.hasOwnProperty.call(trip, field),
          `Migration to v${migration.to} dropped required field '${field}'`
        ).toBe(true);
      }
    }
  });
});
