/**
 * Replays real trips from a backup export at several PENALTY_SCALE_FACTOR
 * values, so the constant can be chosen against the user's own driving instead
 * of synthetic routes.
 *
 * Not part of the normal suite: it is skipped unless REPLAY_BACKUP_PATH is set.
 * Launch it with `npm run replay:penalty-scale -- --backup <file>`.
 *
 * The headline metric is not the average score, it is *sensitivity*: on what
 * share of trips does removing a single detected event actually move the score.
 * A factor where that share is low has a saturated score, which is the defect
 * this replay exists to measure.
 */
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const backupPath = process.env.REPLAY_BACKUP_PATH || '';
const factors = (process.env.REPLAY_FACTORS || '3,5,8,12,40')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const replayDescribe = backupPath ? describe : describe.skip;

const loadEngineWithFactor = async (factor) => {
  vi.resetModules();
  // tripEngine reads PENALTY_SCALE_FACTOR from appConstants, not from
  // scoringConstants -- mocking the latter silently changes nothing.
  const actual = await vi.importActual('../appConstants');
  vi.doMock('../appConstants', () => ({ ...actual, PENALTY_SCALE_FACTOR: factor }));
  return import('../tripEngine');
};

const readTrips = (path) => {
  const raw = fs.readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path} is not readable JSON. Encrypted backups must be exported without a passphrase for this replay.`
    );
  }
  const trips = Array.isArray(parsed) ? parsed : parsed?.trips;
  if (!Array.isArray(trips)) throw new Error(`${path} has no "trips" array.`);
  return trips.filter((trip) => (
    trip?.status === 'completed' &&
    Array.isArray(trip.route_points) &&
    trip.route_points.length >= 2
  ));
};

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const histogram = (values) => {
  const buckets = new Array(10).fill(0);
  values.forEach((value) => {
    buckets[Math.min(9, Math.max(0, Math.floor(value / 10)))] += 1;
  });
  return buckets;
};

const bar = (count, total) => '#'.repeat(Math.round((count / Math.max(1, total)) * 40));

const scoreTrip = (engine, trip, { dropOneEvent = false } = {}) => {
  const points = trip.route_points;
  const stats = engine.calculateTripStats(
    points,
    trip.start_time,
    trip.end_time,
    engine.DEFAULT_THRESHOLDS
  );
  const detected = engine.detectDrivingEvents(points, engine.DEFAULT_THRESHOLDS, trip.end_time, []);
  const events = dropOneEvent ? detected.events.slice(1) : detected.events;
  const scores = engine.calculateTripScores(
    events,
    stats,
    points,
    engine.DEFAULT_THRESHOLDS,
    stats.duration_seconds,
    detected.phoneUse,
    { endTime: trip.end_time, includeRoadTypeSegments: false }
  );
  return { stats, scores, eventCount: detected.events.length };
};

replayDescribe('penalty scale replay', () => {
  it('reports the score distribution and correction sensitivity per factor', async () => {
    const trips = readTrips(backupPath);
    console.log(`\nReplaying ${trips.length} completed trips from ${backupPath}\n`);
    expect(trips.length).toBeGreaterThan(0);

    for (const factor of factors) {
      const engine = await loadEngineWithFactor(factor);
      const overall = [];
      const safety = [];
      let withEvents = 0;
      let sensitive = 0;
      let atFloor = 0;
      let atCeiling = 0;

      for (const trip of trips) {
        let base;
        try {
          base = scoreTrip(engine, trip);
        } catch {
          continue; // A single unreplayable trip must not abort the sweep.
        }
        if (base.scores.score_overall == null) continue;
        overall.push(base.scores.score_overall);
        if (base.scores.score_safety != null) safety.push(base.scores.score_safety);
        if (base.scores.score_overall <= 5) atFloor += 1;
        if (base.scores.score_overall >= 95) atCeiling += 1;

        if (base.eventCount > 0) {
          withEvents += 1;
          const without = scoreTrip(engine, trip, { dropOneEvent: true });
          if (
            without.scores.score_overall != null &&
            Math.abs(without.scores.score_overall - base.scores.score_overall) >= 1
          ) sensitive += 1;
        }
      }

      const pct = (count, total) => (total ? Math.round((count / total) * 100) : 0);
      console.log(`=== PENALTY_SCALE_FACTOR = ${factor} ===`);
      console.log(`  trips scored      ${overall.length}`);
      console.log(`  median overall    ${median(overall)}   median safety ${median(safety)}`);
      console.log(`  pinned at floor   ${atFloor} (${pct(atFloor, overall.length)}%)`);
      console.log(`  pinned at ceiling ${atCeiling} (${pct(atCeiling, overall.length)}%)`);
      console.log(
        `  CORRECTION SENSITIVITY: ${sensitive}/${withEvents} ` +
        `(${pct(sensitive, withEvents)}%) of trips with events change when one event is removed`
      );
      histogram(overall).forEach((count, index) => {
        console.log(`   ${String(index * 10).padStart(3)}-${String(index * 10 + 9).padStart(3)} ${String(count).padStart(4)} ${bar(count, overall.length)}`);
      });
      console.log('');
    }
  }, 600_000);
});
