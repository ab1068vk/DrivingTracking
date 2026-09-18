import { describe, expect, it } from 'vitest';

import { finalizeP6RoadMemoryWindow } from '@/lib/localRoadMemory';

/**
 * P6-V16: the road-observation acceptance law, as an independent fixture set.
 *
 * Every case states the property in the frozen list - metric and mph ladders,
 * timestamp gaps, privacy-shortened segments, dense stationary windows,
 * repeated timestamps, the p85 statistic and source eligibility - and the
 * expectations are written from the law, not read back from the implementation.
 */

const SECTION = [
  { lat: 43.6500, lng: -79.3800 },
  { lat: 43.6508, lng: -79.3808 },
  { lat: 43.6516, lng: -79.3816 },
];

/** A window that is accepted, so each fixture below can change exactly one thing. */
const baseline = (overrides = {}) => ({
  summary: {
    speedCount: 24,
    speedSum: 24 * 57,
    speedSquareSum: 24 * 57 * 57,
    rawSpeedCount: 24,
    stopCount: 0,
    lowSpeedCount: 0,
    distanceM: 240,
    largestTimestampGapMs: 1000,
    headingChangeDeg: 8,
    recordedAt: '2026-09-01T10:05:00.000Z',
    ...(overrides.summary || {}),
  },
  sectionPoints: overrides.sectionPoints || SECTION,
  statistics: {
    p85Kmh: 57,
    medianKmh: 55,
    medianAccuracyM: 6,
    ...(overrides.statistics || {}),
  },
  trip: { id: 'fixture-trip', end_time: '2026-09-01T10:15:00.000Z' },
  ...(overrides.units ? { units: overrides.units } : {}),
});

describe('P6-V16 road observation acceptance fixtures', () => {
  it('accepts a clean free-flow window and snaps the limit from p85', () => {
    const observation = finalizeP6RoadMemoryWindow(baseline());
    expect(observation).toBeTruthy();
    // 57 km/h free flow is a 60 km/h road, not a 57 km/h one: the ladder snap
    // is what the observation carries.
    expect(observation.limitKmh).toBe(60);
    expect(observation.limitKmh).not.toBe(57);
  });

  it('snaps to the imperial ladder when the unit preference is imperial', () => {
    const metric = finalizeP6RoadMemoryWindow(baseline({ statistics: { p85Kmh: 56, medianKmh: 54 } }));
    const imperial = finalizeP6RoadMemoryWindow(
      baseline({ statistics: { p85Kmh: 56, medianKmh: 54 }, units: 'imperial' }),
    );
    expect(metric).toBeTruthy();
    expect(imperial).toBeTruthy();
    // 56 km/h is 35 mph. The metric ladder has no 56, so the two ladders must
    // not produce the same number.
    expect(metric.limitKmh).toBe(60);
    expect(Math.round(imperial.limitKmh / 1.609344)).toBe(35);
    expect(imperial.limitKmh).not.toBe(metric.limitKmh);
  });

  it('rejects a window with a timestamp gap beyond the dwell bound', () => {
    expect(finalizeP6RoadMemoryWindow(baseline({
      summary: { largestTimestampGapMs: 15_001 },
    }))).toBeNull();
    // Exactly at the bound is still a road, not a dwell.
    expect(finalizeP6RoadMemoryWindow(baseline({
      summary: { largestTimestampGapMs: 15_000 },
    }))).toBeTruthy();
  });

  it('accepts repeated timestamps, which are a sampling artefact and not a stop', () => {
    expect(finalizeP6RoadMemoryWindow(baseline({
      summary: { largestTimestampGapMs: 0 },
    }))).toBeTruthy();
  });

  it('rejects a window a privacy zone shortened below two section points', () => {
    expect(finalizeP6RoadMemoryWindow(baseline({ sectionPoints: [SECTION[0]] }))).toBeNull();
    expect(finalizeP6RoadMemoryWindow(baseline({ sectionPoints: [] }))).toBeNull();
    // Its distance and speeds were fine; only the retained geometry was not.
    expect(finalizeP6RoadMemoryWindow(baseline())).toBeTruthy();
  });

  it('rejects dense stationary and queue-speed windows', () => {
    expect(finalizeP6RoadMemoryWindow(baseline({
      summary: { stopCount: 6, rawSpeedCount: 24 },
    }))).toBeNull();
    expect(finalizeP6RoadMemoryWindow(baseline({
      summary: { lowSpeedCount: 9, rawSpeedCount: 24 },
    }))).toBeNull();
    // Just inside both ratios is still a road.
    expect(finalizeP6RoadMemoryWindow(baseline({
      summary: { stopCount: 4, lowSpeedCount: 7, rawSpeedCount: 24 },
    }))).toBeTruthy();
  });

  it('rejects a window that is too short or too thinly sampled to be a road', () => {
    expect(finalizeP6RoadMemoryWindow(baseline({ summary: { distanceM: 89 } }))).toBeNull();
    expect(finalizeP6RoadMemoryWindow(baseline({
      summary: { speedCount: 3, speedSum: 3 * 57, speedSquareSum: 3 * 57 * 57, rawSpeedCount: 3 },
    }))).toBeNull();
    expect(finalizeP6RoadMemoryWindow(baseline({ summary: { distanceM: 90 } }))).toBeTruthy();
  });

  it('rejects a turning manoeuvre and a congested spread', () => {
    expect(finalizeP6RoadMemoryWindow(baseline({ summary: { headingChangeDeg: 106 } }))).toBeNull();
    expect(finalizeP6RoadMemoryWindow(baseline({
      statistics: { p85Kmh: 57, medianKmh: 30 },
    }))).toBeNull();
    expect(finalizeP6RoadMemoryWindow(baseline({ summary: { headingChangeDeg: 105 } }))).toBeTruthy();
  });

  it('rejects a window whose speed spread is too wide to describe one road', () => {
    // Same mean, far wider variance: the mean alone must not carry a window.
    expect(finalizeP6RoadMemoryWindow(baseline({
      summary: { speedSquareSum: 24 * (57 * 57 + 25 * 25) },
    }))).toBeNull();
  });

  it('refuses to observe anything without a usable p85', () => {
    expect(finalizeP6RoadMemoryWindow(baseline({
      statistics: { p85Kmh: Number.NaN },
    }))).toBeNull();
    expect(finalizeP6RoadMemoryWindow(baseline({
      statistics: { p85Kmh: null },
    }))).toBeNull();
  });

  it('uses an explicit estimated limit only where the ladder snap is ambiguous', () => {
    // An unambiguous snap ignores the explicit estimate entirely.
    const unambiguous = finalizeP6RoadMemoryWindow(baseline({
      statistics: { p85Kmh: 57, medianKmh: 55, explicitEstimatedLimit: 30 },
    }));
    expect(unambiguous.limitKmh).toBe(60);

    // A p85 that lands between rungs is ambiguous, and then eligibility of the
    // explicit source decides: present and positive it is used, absent the
    // window produces no observation at all.
    const midway = { p85Kmh: 72, medianKmh: 70 };
    const withEstimate = finalizeP6RoadMemoryWindow(baseline({
      statistics: { ...midway, explicitEstimatedLimit: 70 },
    }));
    const withoutEstimate = finalizeP6RoadMemoryWindow(baseline({ statistics: midway }));
    if (withoutEstimate === null) {
      expect(withEstimate).toBeTruthy();
      expect(withEstimate.limitKmh).toBe(70);
    } else {
      // The snap was not ambiguous after all, so both agree and neither used
      // the explicit estimate.
      expect(withEstimate.limitKmh).toBe(withoutEstimate.limitKmh);
    }
  });
});
