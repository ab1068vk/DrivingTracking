import { describe, expect, it } from 'vitest';
import {
  assertProjectionQuery,
  buildProjectionKeyRange,
  decodeProjectionCursor,
  encodeProjectionCursor,
  ProjectionQueryError,
  querySignature,
} from '@/lib/tripProjectionQuery';

const BOUNDS = { maxLimit: 500, defaultLimit: 100 };

describe('assertProjectionQuery', () => {
  it('defaults sort and limit', () => {
    expect(assertProjectionQuery({}, BOUNDS)).toEqual({
      sort: '-start_time', limit: 100, direction: 'prev',
    });
  });

  it('accepts both supported orderings and maps them to cursor directions', () => {
    expect(assertProjectionQuery({ sort: '-start_time' }, BOUNDS).direction).toBe('prev');
    expect(assertProjectionQuery({ sort: 'start_time' }, BOUNDS).direction).toBe('next');
  });

  it.each(['score', 'distance_km', 'duration_seconds', '-score_overall', 'future_field', ''])(
    'rejects unsupported sort %s rather than reinterpreting it',
    (sort) => {
      expect(() => assertProjectionQuery({ sort }, BOUNDS)).toThrow(ProjectionQueryError);
    }
  );

  it.each([
    ['numeric string', '50'],
    ['null', null],
    ['true', true],
    ['false', false],
    ['boxed number', new Number(50)],
    ['fraction', 50.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['zero', 0],
    ['negative', -1],
    ['over max', 501],
    ['huge', 1e9],
    ['object', {}],
  ])('rejects limit %s', (_label, limit) => {
    expect(() => assertProjectionQuery({ limit }, BOUNDS)).toThrow(ProjectionQueryError);
  });

  it.each([1, 50, 100, 499, 500])('accepts in-range limit %i', (limit) => {
    expect(assertProjectionQuery({ limit }, BOUNDS).limit).toBe(limit);
  });
});

describe('cursor tokens', () => {
  const query = { sort: '-start_time', status: null };

  it('round-trips a position', () => {
    const token = encodeProjectionCursor({ ...query, startTime: '2026-05-01T10:00:00.000Z', id: 'trip_9' });
    expect(decodeProjectionCursor(token, query)).toEqual({
      startTime: '2026-05-01T10:00:00.000Z', id: 'trip_9',
    });
  });

  it('returns null for an absent cursor', () => {
    expect(decodeProjectionCursor(null, query)).toBeNull();
    expect(decodeProjectionCursor('', query)).toBeNull();
  });

  it('rejects a token minted for the opposite direction', () => {
    const token = encodeProjectionCursor({ sort: 'start_time', status: null, startTime: 't', id: 'i' });
    expect(() => decodeProjectionCursor(token, query)).toThrow(ProjectionQueryError);
  });

  it('rejects a token minted for a different status filter', () => {
    const token = encodeProjectionCursor({ sort: '-start_time', status: 'completed', startTime: 't', id: 'i' });
    expect(() => decodeProjectionCursor(token, query)).toThrow(ProjectionQueryError);
  });

  it.each(['not-base64!!', 'YWJj', '', 'e30'])('rejects malformed token %s without restarting', (token) => {
    if (token === '') {
      expect(decodeProjectionCursor(token, query)).toBeNull();
    } else {
      expect(() => decodeProjectionCursor(token, query)).toThrow(ProjectionQueryError);
    }
  });

  it('binds the query signature', () => {
    expect(querySignature({ sort: '-start_time', status: null })).not
      .toBe(querySignature({ sort: '-start_time', status: 'completed' }));
  });
});

describe('key range shapes', () => {
  // Minimal IDBKeyRange stand-in that records the exact bound shape requested.
  const range = {
    bound: (lower, upper, lowerOpen, upperOpen) => ({ kind: 'bound', lower, upper, lowerOpen, upperOpen }),
    upperBound: (upper, open) => ({ kind: 'upperBound', upper, open }),
    lowerBound: (lower, open) => ({ kind: 'lowerBound', lower, open }),
  };

  it('uses a two-element key for the unfiltered index', () => {
    const built = buildProjectionKeyRange(range, {
      status: null, direction: 'prev', cursor: { startTime: 't1', id: 'i1' },
    });
    expect(built).toEqual({ kind: 'upperBound', upper: ['t1', 'i1'], open: true });
  });

  it('uses a three-element key for the status index', () => {
    const built = buildProjectionKeyRange(range, {
      status: 'completed', direction: 'prev', cursor: { startTime: 't1', id: 'i1' },
    });
    expect(built.kind).toBe('bound');
    expect(built.upper).toEqual(['completed', 't1', 'i1']);
    expect(built.upperOpen).toBe(true);
  });

  it('never mixes a two-element bound into the three-element index', () => {
    const built = buildProjectionKeyRange(range, {
      status: 'completed', direction: 'next', cursor: { startTime: 't1', id: 'i1' },
    });
    expect(built.lower).toHaveLength(3);
    expect(built.lowerOpen).toBe(true);
  });

  it('returns an open scan for an unfiltered first page', () => {
    expect(buildProjectionKeyRange(range, { status: null, direction: 'prev', cursor: null })).toBeNull();
  });

  it('bounds a filtered first page to the status prefix', () => {
    const built = buildProjectionKeyRange(range, { status: 'completed', direction: 'prev', cursor: null });
    expect(built.lower).toEqual(['completed']);
  });
});
