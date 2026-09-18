import { describe, expect, it } from 'vitest';
import {
  MAX_CHUNK_LOGICAL_CHARGE,
  MAX_LOGICAL_WRITE_RECORDS,
  TripWriteAdmissionError,
  assertLogicalWriteBatch,
  chunkCharge,
  measureSourceTrip,
  planWriteChunks,
  singleCharge,
} from '@/lib/tripWriteAdmission';

const tripOfRoughly = (bytes) => ({ id: 't', notes: 'x'.repeat(Math.max(0, bytes - 32)) });

describe('assertLogicalWriteBatch', () => {
  it('accepts up to the public maximum', () => {
    expect(assertLogicalWriteBatch(new Array(MAX_LOGICAL_WRITE_RECORDS).fill({}))).toHaveLength(32);
  });

  it('rejects above the maximum with a typed error', () => {
    expect(() => assertLogicalWriteBatch(new Array(33).fill({}))).toThrow(TripWriteAdmissionError);
  });

  it('tolerates a non-array', () => {
    expect(assertLogicalWriteBatch(undefined)).toEqual([]);
  });
});

describe('all-field preflight', () => {
  it('sees an arbitrary imported field that a shape-based estimator would miss', () => {
    const known = { id: 't', route_points: [], driving_events: [], motion_samples: [] };
    const withBlob = { ...known, imported_blob: 'z'.repeat(4 * 1024 * 1024) };
    expect(measureSourceTrip(known).bytes).toBeLessThan(1_000);
    expect(measureSourceTrip(withBlob).bytes).toBeGreaterThan(4 * 1024 * 1024);
  });

  it('aborts early rather than serializing a huge unknown field', () => {
    const huge = { id: 't', blob: 'z'.repeat(32 * 1024 * 1024) };
    const result = measureSourceTrip(huge, 1024 * 1024);
    expect(result.aborted).toBe(true);
    expect(result.bytes).toBeLessThan(2 * 1024 * 1024);
  });

  it('counts nested and deeply buried fields', () => {
    const nested = { id: 't', a: { b: { c: { d: 'y'.repeat(200_000) } } } };
    expect(measureSourceTrip(nested).bytes).toBeGreaterThan(200_000);
  });
});

describe('planWriteChunks', () => {
  it('bounds a chunk by record count', () => {
    const trips = Array.from({ length: 70 }, () => tripOfRoughly(200));
    const { chunks } = planWriteChunks(trips);
    chunks.forEach((chunk) => expect(chunk.items.length).toBeLessThanOrEqual(MAX_LOGICAL_WRITE_RECORDS));
    expect(chunks.reduce((sum, chunk) => sum + chunk.items.length, 0)).toBe(70);
  });

  it('closes a chunk before preparing an item that would exceed the charge', () => {
    // Each ~4 MiB source charges ~36 MiB, so only two fit a 96 MiB chunk budget.
    const trips = Array.from({ length: 6 }, () => tripOfRoughly(4 * 1024 * 1024));
    const { chunks } = planWriteChunks(trips);
    chunks.forEach((chunk) => expect(chunk.charge).toBeLessThanOrEqual(MAX_CHUNK_LOGICAL_CHARGE));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('isolates a single record whose own charge exceeds the chunk budget', () => {
    const trips = [tripOfRoughly(1024), tripOfRoughly(20 * 1024 * 1024), tripOfRoughly(1024)];
    const { chunks } = planWriteChunks(trips);
    const isolated = chunks.filter((chunk) => chunk.isolated);
    expect(isolated).toHaveLength(1);
    expect(isolated[0].items).toHaveLength(1);
    // The complete source is still written: isolation is not rejection.
    expect(chunks.reduce((sum, chunk) => sum + chunk.items.length, 0)).toBe(3);
  });

  it('preserves input order across chunks', () => {
    const trips = Array.from({ length: 40 }, (_, index) => ({ id: `t${index}`, notes: 'x' }));
    const { chunks } = planWriteChunks(trips);
    const flattened = chunks.flatMap((chunk) => chunk.items.map((trip) => trip.id));
    expect(flattened).toEqual(trips.map((trip) => trip.id));
  });

  it('uses a lower multiplier for the isolated path than for chunked preparation', () => {
    // The summary and projection are not history-sized for one record, and
    // intermediates are released between stages.
    expect(singleCharge(1_000_000)).toBeLessThan(chunkCharge(1_000_000));
  });

  it('handles an empty input', () => {
    expect(planWriteChunks([]).chunks).toEqual([]);
  });
});
