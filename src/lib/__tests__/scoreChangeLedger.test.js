import { describe, expect, it } from 'vitest';
import { localTripRepository } from '@/lib/localTripRepository';
import {
  MAX_SCORE_CHANGE_ENTRIES,
  appendScoreChangeEntry,
  buildScoreChangeEntry,
  diffComponentScores,
} from '@/lib/scoring/scoreChangeLedger';

const component = (value) => ({ value, evidence: 'measured' });

describe('diffComponentScores', () => {
  it('reports only components that moved, largest movement first', () => {
    const changes = diffComponentScores(
      { overall: component(70), safety: component(60), smoothness: component(80) },
      { overall: component(74), safety: component(75), smoothness: component(80) }
    );
    expect(changes.map((change) => change.key)).toEqual(['safety', 'overall']);
    expect(changes[0]).toMatchObject({ key: 'safety', from: 60, to: 75, delta: 15 });
    expect(changes[1]).toMatchObject({ key: 'overall', from: 70, to: 74, delta: 4 });
  });

  it('ignores rounding noise below half a point', () => {
    const changes = diffComponentScores(
      { overall: component(70.1) },
      { overall: component(70.3) }
    );
    expect(changes).toEqual([]);
  });

  it('reports a component that gained or lost a value without inventing a delta', () => {
    const changes = diffComponentScores(
      { speed_limit_compliance: component(null) },
      { speed_limit_compliance: component(84) }
    );
    expect(changes).toEqual([
      { key: 'speed_limit_compliance', from: null, to: 84, delta: null },
    ]);
  });

  it('never treats a missing score as zero', () => {
    const changes = diffComponentScores(
      { hill_driving: component(90) },
      { hill_driving: component(null) }
    );
    expect(changes[0]).toMatchObject({ from: 90, to: null, delta: null });
  });

  it('reads legacy bare-number components', () => {
    const changes = diffComponentScores({ overall: 50 }, { overall: 62 });
    expect(changes[0]).toMatchObject({ from: 50, to: 62, delta: 12 });
  });

  it('returns nothing when both sides are absent', () => {
    expect(diffComponentScores({}, {})).toEqual([]);
    expect(diffComponentScores(null, undefined)).toEqual([]);
  });
});

describe('buildScoreChangeEntry', () => {
  it('captures the overall delta and the reason', () => {
    const entry = buildScoreChangeEntry({
      previousTrip: { component_scores: { overall: component(71), speed_limit_compliance: component(71) } },
      nextTrip: { component_scores: { overall: component(78), speed_limit_compliance: component(84) } },
      reason: 'scoring_inputs_changed',
      changedConstants: ['SPEED_OVER_KMH'],
      at: '2026-08-08T10:00:00.000Z',
    });
    expect(entry).toMatchObject({
      at: '2026-08-08T10:00:00.000Z',
      reason: 'scoring_inputs_changed',
      changed_constants: ['SPEED_OVER_KMH'],
      overall_delta: 7,
    });
    expect(entry.changes[0]).toMatchObject({ key: 'speed_limit_compliance', from: 71, to: 84 });
  });

  it('returns null when a re-score changed nothing', () => {
    const scores = { component_scores: { overall: component(80) } };
    expect(buildScoreChangeEntry({ previousTrip: scores, nextTrip: scores })).toBeNull();
  });

  it('leaves overall_delta null when only other components moved', () => {
    const entry = buildScoreChangeEntry({
      previousTrip: { component_scores: { overall: component(80), hill_driving: component(50) } },
      nextTrip: { component_scores: { overall: component(80), hill_driving: component(65) } },
    });
    expect(entry.overall_delta).toBeNull();
    expect(entry.changes).toHaveLength(1);
  });

  it('caps the stored breakdown so a re-score cannot bloat the trip record', () => {
    const previous = {};
    const next = {};
    for (let index = 0; index < 20; index += 1) {
      previous[`component_${index}`] = component(50);
      next[`component_${index}`] = component(50 + index + 1);
    }
    const entry = buildScoreChangeEntry({
      previousTrip: { component_scores: previous },
      nextTrip: { component_scores: next },
    });
    expect(entry.changes).toHaveLength(8);
  });
});

describe('appendScoreChangeEntry', () => {
  it('puts the newest entry first and bounds the history', () => {
    let ledger = [];
    for (let index = 0; index < MAX_SCORE_CHANGE_ENTRIES + 5; index += 1) {
      ledger = appendScoreChangeEntry(ledger, { at: `entry-${index}`, reason: 'x', changes: [] });
    }
    expect(ledger).toHaveLength(MAX_SCORE_CHANGE_ENTRIES);
    expect(ledger[0].at).toBe(`entry-${MAX_SCORE_CHANGE_ENTRIES + 4}`);
  });

  it('leaves the history untouched for a null entry', () => {
    const ledger = [{ at: 'a', reason: 'x', changes: [] }];
    expect(appendScoreChangeEntry(ledger, null)).toEqual(ledger);
  });

  it('tolerates a missing or malformed prior ledger', () => {
    expect(appendScoreChangeEntry(undefined, { at: 'a' })).toEqual([{ at: 'a' }]);
    expect(appendScoreChangeEntry('not-an-array', { at: 'a' })).toEqual([{ at: 'a' }]);
  });
});

const feedbackKey = (event, index) => [
  event?.type || 'event',
  event?.timestamp || index,
  Number.isFinite(Number(event?.value)) ? Number(event.value).toFixed(2) : '',
].join('|');

describe('score change ledger through the real re-score path', () => {
  // Long enough to actually score: a four-point trip leaves every component
  // null, so nothing can move and the test would pass without proving anything.
  const buildRoute = () => {
    const points = [];
    const start = Date.parse('2026-03-01T13:00:00.000Z');
    let lat = 43.6500;
    for (let index = 0; index < 150; index += 1) {
      const braking = index === 60 || index === 100;
      const speed = braking ? 25 : 85;
      points.push({
        lat: Number(lat.toFixed(7)),
        lng: -79.3800,
        speed_kmh: speed,
        accuracy: 5,
        altitude: 100,
        timestamp: new Date(start + index * 1000).toISOString(),
      });
      lat += (speed / 3.6) / 111320;
    }
    return points;
  };
  const routePoints = buildRoute();

  it('records what marking an event wrong changed, matching the reported before/after', async () => {
    const [initial] = await localTripRepository.upsertMany([{
      id: `ledger_${Math.random().toString(36).slice(2)}`,
      status: 'completed',
      start_time: routePoints[0].timestamp,
      end_time: routePoints[routePoints.length - 1].timestamp,
      route_points: routePoints,
      needs_rescore: true,
      schema_version: 0,
    }]);
    // A first scoring pass must not produce an entry: nothing changed, the trip
    // simply gained scores it never had.
    expect(initial.score_change_ledger).toBeUndefined();

    // The trip must genuinely score, otherwise "nothing changed" is vacuous.
    expect(initial.component_scores?.overall?.value).toEqual(expect.any(Number));

    const reviewedIndex = initial.driving_events.findIndex((event) => event.type !== 'phone_use');
    const reviewedEvent = initial.driving_events[reviewedIndex];
    expect(reviewedEvent).toBeTruthy();

    await localTripRepository.update(initial.id, {
      event_feedback: {
        [feedbackKey(reviewedEvent, reviewedIndex)]: {
          type: reviewedEvent.type,
          value: reviewedEvent.value,
          verdict: 'wrong',
        },
      },
      needs_rescore: true,
    });

    const result = await localTripRepository.rescoreTripById(initial.id, { reason: 'test_ledger' });
    const ledger = result.updatedTrip.score_change_ledger;

    expect(Array.isArray(ledger)).toBe(true);
    expect(ledger.length).toBe(1);
    expect(ledger[0].changes.length).toBeGreaterThan(0);
    // The ledger must agree with the before/after the re-score already reports;
    // two disagreeing accounts of the same change would be worse than none.
    const overallChange = ledger[0].changes.find((change) => change.key === 'overall');
    if (overallChange && overallChange.delta != null) {
      expect(result.after.overall - result.before.overall).toBeCloseTo(overallChange.delta, 1);
      expect(ledger[0].overall_delta).toBeCloseTo(overallChange.delta, 1);
    }
  });
});
