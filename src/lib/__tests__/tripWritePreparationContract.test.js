import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Production write-path preparation contract (Codex closure I1-B / I1-C).
 *
 * Two properties are asserted against the real `create`/`update` callers rather
 * than against `putTrip` in isolation, because the defect this covers was that
 * the callers did their own sanitization first:
 *
 *  - the all-field source preflight runs before the first source-sized
 *    sanitized copy exists, and the record is sanitized exactly once;
 *  - every preparation stage and *both* persistence backends surface
 *    `TripPersistenceFailedError` instead of a raw error.
 *
 * `indexedDB` is deliberately absent so the fallback backend is the one under
 * test; the IndexedDB backend is covered by the repository suite.
 */

const { stages, sanitizeBehavior } = vi.hoisted(() => ({
  stages: [],
  sanitizeBehavior: { throwOnce: null },
}));

/**
 * Stages are tagged with a per-write marker carried on the source object. The
 * repository legitimately sanitizes on other paths too — the read-path drift
 * check and retention both do — so an untagged global sequence cannot tell a
 * duplicated *write* copy from an unrelated one.
 */
const markerOf = (trip) => (trip && typeof trip === 'object' ? trip.__prepMarker : undefined);

vi.mock('@/lib/privacyZones', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    sanitizeTripForPrivacyStorageAsync: async (trip, settings) => {
      stages.push(`sanitize:${markerOf(trip) ?? 'other'}`);
      if (sanitizeBehavior.throwOnce) {
        const error = sanitizeBehavior.throwOnce;
        sanitizeBehavior.throwOnce = null;
        throw error;
      }
      return actual.sanitizeTripForPrivacyStorageAsync(trip, settings);
    },
  };
});

vi.mock('@/lib/tripWriteAdmission', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    measureSourceTrip: (trip, ceiling) => {
      stages.push(`preflight:${markerOf(trip) ?? 'other'}`);
      return actual.measureSourceTrip(trip, ceiling);
    },
  };
});

/** Stage sequence for one marked write, ignoring unrelated repository work. */
const stagesFor = (marker) => stages.filter((stage) => stage.endsWith(`:${marker}`));

/**
 * Assert the write window itself, not the whole session.
 *
 * Reads after a write legitimately sanitize the same record again (the drift
 * check, retention, cache invalidation), so the property to pin is local: no
 * sanitized copy of this source exists *before* its preflight, and exactly one
 * is made immediately after. The defect produced
 * `sanitize:X, preflight:X, sanitize:X`, which the first assertion catches.
 */
const expectPreflightBeforeFirstCopy = (marker) => {
  const preflight = stages.indexOf(`preflight:${marker}`);
  expect(preflight).toBeGreaterThanOrEqual(0);
  expect(stages.slice(0, preflight)).not.toContain(`sanitize:${marker}`);
  expect(stages[preflight + 1]).toBe(`sanitize:${marker}`);
};

const { localTripRepository } = await import('@/lib/localTripRepository');
const { TripPersistenceFailedError } = await import('@/lib/tripWriteAdmission');
const securePayloadCrypto = await import('@/lib/securePayloadCrypto');

const baseTrip = (overrides = {}) => ({
  id: `prep-${Math.random().toString(36).slice(2, 10)}`,
  status: 'completed',
  start_time: '2026-04-01T10:00:00.000Z',
  end_time: '2026-04-01T10:30:00.000Z',
  route_points: [{ lat: 51.5, lng: -0.12, timestamp: '2026-04-01T10:00:00.000Z' }],
  ...overrides,
});

beforeEach(() => {
  stages.length = 0;
  sanitizeBehavior.throwOnce = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('source preflight precedes the first sanitized copy (I1-B)', () => {
  it('create measures the source before sanitizing, and sanitizes once', async () => {
    await localTripRepository.create(baseTrip({ __prepMarker: 'create-1' }));
    // The defect produced ['sanitize', 'preflight', 'sanitize']: the caller's
    // copy was made first and the writer then measured and copied it again.
    expectPreflightBeforeFirstCopy('create-1');
  });

  it('update measures the merged source before sanitizing, and sanitizes once', async () => {
    const created = await localTripRepository.create(baseTrip({ __prepMarker: 'update-base' }));
    await localTripRepository.update(created.id, { __prepMarker: 'update-1', notes: 'edited' });
    expectPreflightBeforeFirstCopy('update-1');
  });

  it('measures the raw source, so an open-shaped field is counted before any copy', async () => {
    // Ordering is only meaningful if the measured object is the caller's. The
    // first toJSON invocation is the preflight's; later ones belong to
    // persistence, so only the first snapshot is evidence.
    let observed = null;
    const probe = {
      toJSON() { observed ??= stagesFor('probe-1').slice(); return 'x'.repeat(4096); },
    };
    await localTripRepository.create(baseTrip({ __prepMarker: 'probe-1', open_shaped_field: probe }));
    expect(observed).toEqual(['preflight:probe-1']);
  });
});

describe('typed complete-save failure boundary (I1-C)', () => {
  const expectTyped = async (run) => {
    let caught = null;
    try { await run(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TripPersistenceFailedError);
    expect(caught.name).toBe('TripPersistenceFailedError');
    return caught;
  };

  it('converts a cyclic source', async () => {
    const trip = baseTrip();
    trip.self = trip;
    const error = await expectTyped(() => localTripRepository.create(trip));
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('converts a BigInt field', async () => {
    const error = await expectTyped(() => localTripRepository.create(baseTrip({ big: 1n })));
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('converts a throwing toJSON', async () => {
    const trip = baseTrip({ hostile: { toJSON() { throw new RangeError('boom'); } } });
    const error = await expectTyped(() => localTripRepository.create(trip));
    expect(error.cause).toBeInstanceOf(RangeError);
    expect(error.cause.message).toBe('boom');
  });

  it('converts a sanitizer fault', async () => {
    sanitizeBehavior.throwOnce = new Error('sanitizer exploded');
    const error = await expectTyped(() => localTripRepository.create(baseTrip()));
    expect(error.cause?.message).toBe('sanitizer exploded');
  });

  it('converts a fallback persistence failure instead of swallowing it', async () => {
    // The fallback is the only backend here, so a failure means the trip was
    // not saved. Reporting success would be the worst possible outcome.
    const spy = vi.spyOn(securePayloadCrypto, 'setEncryptedJson')
      .mockRejectedValue(new Error('quota exceeded'));
    const error = await expectTyped(() => localTripRepository.create(baseTrip()));
    expect(error.cause?.message).toBe('quota exceeded');
    spy.mockRestore();
  });

  it('does not fabricate a record when preparation failed before sanitizing', async () => {
    const trip = baseTrip({ __prepMarker: 'no-copy-1', big: 2n });
    await expectTyped(() => localTripRepository.create(trip));
    // Nothing sanitized means nothing was eligible to be written anywhere.
    expect(stagesFor('no-copy-1')).toEqual(['preflight:no-copy-1']);
  });
});
