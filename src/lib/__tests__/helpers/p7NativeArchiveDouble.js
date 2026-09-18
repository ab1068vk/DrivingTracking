/**
 * A native archive double built **from the extracted Java contract**.
 *
 * P7-IMPL-F05. Every behaviour below is transcribed from
 * `DriveSenseTripArchiveRepository.java` rather than from what the facade would
 * like to receive:
 *
 * | Behaviour | Java source |
 * |---|---|
 * | page row shape | the page `SELECT` columns + `PAGE_PROJECTION_FIELDS` |
 * | page cursor identity | `generation`/`sort`/`status`/`vehicleId`/`range` |
 * | page cursor mismatch | `throw IllegalArgumentException("CURSOR_QUERY_MISMATCH")` |
 * | range | half-open `start_time_ms >= from AND start_time_ms < to` |
 * | aggregate result keys | `aggregateObject` — `liveCount`, not `tripCount` |
 * | aggregate source | `SUM(...) FROM trip_current`, counted in `rowsScanned` |
 * | bucket cap argument | `maxBuckets`, defaulting to 366 |
 * | bucket source | `trip_aggregate_buckets`, counted in `bucketRowsScanned` |
 * | tag context | `{aggregates, recent}` |
 *
 * The counters are what make the boundedness claims falsifiable: a caller that
 * routes a bounded aggregate through the row scan increments `rowsScanned`, and
 * no amount of agreement between the double and the facade hides it.
 */

import { vi } from 'vitest';
import { nativePageRowKeys } from './p7NativeWireContract.js';

const DAY = 86400000;

/** Only the keys a real page row carries — nothing the facade wishes it had. */
const projectRow = (trip, allowed) => {
  const row = {};
  for (const key of Object.keys(trip)) if (allowed.has(key)) row[key] = trip[key];
  // The archive's own column names, which the JS adapter maps back.
  row.distance = trip.distance_km ?? 0;
  row.duration = trip.duration_seconds ?? 0;
  return row;
};

const rangeId = (fromMs, toMs) => (
  `${Number.isFinite(fromMs) ? fromMs : ''}:${Number.isFinite(toMs) ? toMs : ''}`
);

/**
 * @param {object[]} trips the archive's contents
 * @param {{generation?: string, seq?: number, maxItems?: number}} [options]
 */
export function createNativeArchiveDouble(trips, options = {}) {
  const allowed = nativePageRowKeys();
  const counters = { rowsScanned: 0, bucketRowsScanned: 0, pageRowsVisited: 0, bridgeCalls: 0 };
  const state = {
    generation: options.generation ?? 'gen-7',
    seq: options.seq ?? 4211,
    recoveryState: 'HEALTHY',
    sentinelMatches: true,
  };

  /** `trip_aggregate_buckets`: one pre-rolled row per (day, vehicle, status). */
  const buckets = () => {
    const byKey = new Map();
    for (const trip of trips) {
      const at = Date.parse(trip.start_time);
      const day = Math.floor(at / DAY) * DAY;
      const key = `${day}|${trip.vehicle_id}|${trip.status}`;
      const bucket = byKey.get(key) ?? {
        day, vehicle_id: trip.vehicle_id, status: trip.status,
        tripCount: 0, totalDistance: 0, totalDuration: 0, scoreSum: 0, scoreCount: 0,
      };
      bucket.tripCount += 1;
      bucket.totalDistance += trip.distance_km ?? 0;
      bucket.totalDuration += trip.duration_seconds ?? 0;
      if (Number.isFinite(trip.score_overall)) {
        bucket.scoreSum += trip.score_overall;
        bucket.scoreCount += 1;
      }
      byKey.set(key, bucket);
    }
    return [...byKey.values()];
  };

  const archive = {
    counters,
    state,
    health: vi.fn(async () => {
      counters.bridgeCalls += 1;
      return {
        archiveGeneration: state.generation, lastCommittedSeq: state.seq,
        recoveryState: state.recoveryState, sentinelMatches: state.sentinelMatches,
        authorityState: 'NATIVE',
      };
    }),

    queryHistoryPage: vi.fn(async (request = {}) => {
      counters.bridgeCalls += 1;
      const {
        maxItems = 100, sort = '-start_time', status = '', vehicleId = '',
        cursor = null, fromMs = null, toMs = null,
      } = request;
      const hasFrom = Number.isFinite(fromMs);
      const hasTo = Number.isFinite(toMs);
      const range = rangeId(hasFrom ? fromMs : null, hasTo ? toMs : null);

      let decoded = null;
      if (cursor) {
        decoded = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
        if (decoded.generation !== state.generation || decoded.sort !== sort
          || decoded.status !== status || (decoded.vehicleId ?? '') !== vehicleId
          || (decoded.range ?? '') !== range) {
          throw new Error('CURSOR_QUERY_MISMATCH');
        }
      }

      const descending = String(sort).startsWith('-');
      const direction = descending ? -1 : 1;
      let rows = trips
        .filter((trip) => (!status || trip.status === status))
        .filter((trip) => (!vehicleId || String(trip.vehicle_id) === String(vehicleId)))
        // Half-open [from, to), exactly as the SQL binds it.
        .filter((trip) => {
          const at = Date.parse(trip.start_time);
          if (hasFrom && at < fromMs) return false;
          if (hasTo && at >= toMs) return false;
          return true;
        })
        .sort((left, right) => {
          const leftAt = Date.parse(left.start_time);
          const rightAt = Date.parse(right.start_time);
          if (leftAt !== rightAt) return (leftAt > rightAt ? 1 : -1) * direction;
          return (String(left.id) > String(right.id) ? 1 : -1) * direction;
        });

      if (decoded) {
        // `start_time_ms <op> ? OR (start_time_ms = ? AND trip_id <op> ?)`, so
        // the boundary row itself is excluded by the strict id comparison.
        rows = rows.filter((trip) => {
          const at = Date.parse(trip.start_time);
          if (at !== decoded.start) return (at > decoded.start ? 1 : -1) === direction;
          if (String(trip.id) === String(decoded.id)) return false;
          return (String(trip.id) > String(decoded.id) ? 1 : -1) === direction;
        });
      }

      const slice = rows.slice(0, maxItems);
      counters.pageRowsVisited += Math.min(rows.length, maxItems + 1);
      const more = rows.length > slice.length;
      const last = slice[slice.length - 1];
      return {
        archiveGeneration: state.generation,
        canonicalSeq: state.seq,
        items: slice.map((trip) => projectRow(trip, allowed)),
        itemCount: slice.length,
        nextCursor: more && last
          ? Buffer.from(JSON.stringify({
            v: 1, generation: state.generation, sort, status, vehicleId, range,
            start: Date.parse(last.start_time), id: String(last.id),
          }), 'utf8').toString('base64')
          : null,
      };
    }),

    aggregates: vi.fn(async (request = {}) => {
      counters.bridgeCalls += 1;
      const { fromMs, toMs, status = '', vehicleId = '' } = request;
      const unfiltered = fromMs === undefined && toMs === undefined && !status && !vehicleId;
      const rows = unfiltered ? trips : trips.filter((trip) => {
        const at = Date.parse(trip.start_time);
        return (!status || trip.status === status)
          && (!vehicleId || String(trip.vehicle_id) === String(vehicleId))
          && (!Number.isFinite(fromMs) || at >= fromMs)
          && (!Number.isFinite(toMs) || at <= toMs);
      });
      // `SUM(...) FROM trip_current` visits one row per matching drive. This is
      // exactly the work a bounded Q4 must not perform.
      if (!unfiltered) counters.rowsScanned += rows.length;
      const scored = rows.filter((trip) => Number.isFinite(trip.score_overall));
      return {
        liveCount: rows.length,
        totalDistance: rows.reduce((sum, trip) => sum + (trip.distance_km ?? 0), 0),
        totalDuration: rows.reduce((sum, trip) => sum + (trip.duration_seconds ?? 0), 0),
        scoreSum: scored.reduce((sum, trip) => sum + trip.score_overall, 0),
        scoreCount: scored.length,
        scoreAverage: scored.length
          ? scored.reduce((sum, trip) => sum + trip.score_overall, 0) / scored.length
          : null,
        throughSeq: state.seq,
      };
    }),

    chartBuckets: vi.fn(async (request = {}) => {
      counters.bridgeCalls += 1;
      const { fromMs, toMs, granularity = 'day', status = '', vehicleId = '' } = request;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
        throw new Error('Invalid range');
      }
      const max = Math.min(1000, Math.max(1, Number(request.maxBuckets ?? 366)));
      const unit = granularity === 'day' ? DAY : granularity === 'week' ? 7 * DAY : 31 * DAY;
      if ((toMs - fromMs) / unit > max * 2) throw new Error('Range exceeds bucket bound');

      const matching = buckets().filter((bucket) => (
        bucket.day >= fromMs && bucket.day <= toMs
        && (!status || bucket.status === status)
        && (!vehicleId || String(bucket.vehicle_id) === String(vehicleId))
      ));
      counters.bucketRowsScanned += matching.length;
      const byStart = new Map();
      for (const bucket of matching) {
        const start = Math.floor(bucket.day / unit) * unit;
        const rolled = byStart.get(start) ?? {
          startMs: start, tripCount: 0, totalDistance: 0, totalDuration: 0,
          scoreSum: 0, scoreCount: 0, throughSeq: state.seq,
        };
        rolled.tripCount += bucket.tripCount;
        rolled.totalDistance += bucket.totalDistance;
        rolled.totalDuration += bucket.totalDuration;
        rolled.scoreSum += bucket.scoreSum;
        rolled.scoreCount += bucket.scoreCount;
        byStart.set(start, rolled);
      }
      const items = [...byStart.values()].sort((a, b) => a.startMs - b.startMs).slice(0, max);
      return { granularity, items, itemCount: items.length };
    }),

    adjacent: vi.fn(async (tripId, direction) => {
      counters.bridgeCalls += 1;
      const ordered = [...trips].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time));
      const index = ordered.findIndex((trip) => String(trip.id) === String(tripId));
      const target = direction === 'next' ? index - 1 : index + 1;
      const found = ordered[target];
      return found ? projectRow(found, allowed) : null;
    }),

    // The plugin composes this one itself: `{aggregates, recent}`, plus the
    // identity `tagContextPage` captured in the SAME statement as its rows.
    tagContext: vi.fn(async (maxRecent = 50) => {
      counters.bridgeCalls += 1;
      const recent = [...trips]
        .sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time))
        .slice(0, Math.max(1, Math.min(100, maxRecent)))
        .map((trip) => projectRow(trip, allowed));
      return {
        aggregates: await archive.aggregates({}),
        recent,
        // Atomic with the selection above: one statement, one snapshot.
        archiveGeneration: state.generation,
        canonicalSeq: state.seq,
      };
    }),

    overview: vi.fn(async (tripId, maxPoints = 900) => {
      counters.bridgeCalls += 1;
      const trip = trips.find((entry) => String(entry.id) === String(tripId));
      return { points: (trip?.route_points ?? []).slice(0, maxPoints), tripId, maxPoints };
    }),
  };

  return archive;
}
