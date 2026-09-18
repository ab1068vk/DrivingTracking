import { describe, expect, it } from 'vitest';
import {
  classifyProjectionRows,
  mintSourceRevision,
  projectionEncryptionContext,
  projectionFailureMarkerFor,
  projectionRecordFor,
} from '@/lib/tripProjectionStore';
import { PROJECTION_STALE_VERSION, TRIP_PROJECTION_VERSION } from '@/lib/tripProjectionSchema';
import { payloadKindForContext } from '@/lib/p0Schema';

const row = (over = {}) => ({
  id: 't1', start_time: '2026-05-01T10:00:00.000Z', status: 'completed', source_revision: 'rev1', ...over,
});

const current = (over = {}) => ({
  id: 't1', start_time: '2026-05-01T10:00:00.000Z', status: 'completed',
  projection_version: TRIP_PROJECTION_VERSION, source_revision: 'rev1',
  encrypted_payload: { encrypted: true }, ...over,
});

describe('projection AAD', () => {
  it('keeps P0 trip_summary attribution while separating the record type', () => {
    const context = projectionEncryptionContext('trip_9');
    expect(context).toBe('trip-summary:projection:trip_9');
    expect(payloadKindForContext(context)).toBe('trip_summary');
    // A legacy summary uses a different AAD, so ciphertext cannot cross-authenticate.
    expect(context).not.toBe('trip-summary:trip_9');
  });
});

describe('source revision', () => {
  it('mints distinct opaque 128-bit tokens', () => {
    const values = new Set(Array.from({ length: 200 }, () => mintSourceRevision()));
    expect(values.size).toBe(200);
    values.forEach((value) => expect(value).toMatch(/^[0-9a-f]{32}$/));
  });
});

describe('classifyProjectionRows', () => {
  it('accepts a current projection whose revision matches its source', () => {
    const result = classifyProjectionRows([row()], new Map([['t1', current()]]));
    expect(result.usable).toHaveLength(1);
    expect(result.needsBuild).toHaveLength(0);
  });

  it('rebuilds when the projection is missing', () => {
    const result = classifyProjectionRows([row()], new Map());
    expect(result.needsBuild).toHaveLength(1);
  });

  it('rebuilds on a stale source revision rather than trusting the cache', () => {
    const result = classifyProjectionRows([row({ source_revision: 'rev2' })], new Map([['t1', current()]]));
    expect(result.needsBuild).toHaveLength(1);
    expect(result.usable).toHaveLength(0);
  });

  // Derived from the current version so the case set stays correct across a
  // schema bump: the stale sentinel, the immediately previous version (which is
  // exactly what a bump leaves on disk), and a version from the future.
  it.each([0, TRIP_PROJECTION_VERSION - 1, 99])('rebuilds on projection_version %i', (version) => {
    const record = current({ projection_version: version });
    const result = classifyProjectionRows([row()], new Map([['t1', record]]));
    expect(result.usable).toHaveLength(0);
  });

  it('treats a matching deterministic failure marker as known, not as a rebuild', () => {
    const marker = {
      ...current({ projection_version: PROJECTION_STALE_VERSION, encrypted_payload: undefined }),
      failure_class: 'envelope_oversize',
      failed_source_revision: 'rev1',
      failed_target_projection_version: TRIP_PROJECTION_VERSION,
    };
    const result = classifyProjectionRows([row()], new Map([['t1', marker]]));
    expect(result.deterministicFailures).toHaveLength(1);
    expect(result.needsBuild).toHaveLength(0);
    expect(result.usable).toHaveLength(0);
  });

  it('retries a deterministic failure once the source revision changes', () => {
    const marker = {
      ...current({ projection_version: PROJECTION_STALE_VERSION }),
      failure_class: 'envelope_oversize',
      failed_source_revision: 'rev1',
      failed_target_projection_version: TRIP_PROJECTION_VERSION,
    };
    const result = classifyProjectionRows([row({ source_revision: 'rev2' })], new Map([['t1', marker]]));
    expect(result.needsBuild).toHaveLength(1);
    expect(result.deterministicFailures).toHaveLength(0);
  });

  it('retries a deterministic failure once the target projection version changes', () => {
    const marker = {
      ...current({ projection_version: PROJECTION_STALE_VERSION }),
      failure_class: 'envelope_oversize',
      failed_source_revision: 'rev1',
      failed_target_projection_version: TRIP_PROJECTION_VERSION + 1,
    };
    const result = classifyProjectionRows([row()], new Map([['t1', marker]]));
    expect(result.needsBuild).toHaveLength(1);
  });

  it('never inspects ciphertext for a marker row', () => {
    const marker = {
      id: 't1', start_time: '2026-05-01T10:00:00.000Z', status: 'completed',
      projection_version: PROJECTION_STALE_VERSION, source_revision: 'rev1',
      failure_class: 'envelope_oversize', failed_source_revision: 'rev1',
      failed_target_projection_version: TRIP_PROJECTION_VERSION,
      get encrypted_payload() { throw new Error('ciphertext must not be touched for a marker'); },
    };
    expect(() => classifyProjectionRows([row()], new Map([['t1', marker]]))).not.toThrow();
  });

  it('stays O(page) with 50,000 deterministic failures in the store', () => {
    // The page selects 50 rows; the store's total failure count is irrelevant
    // because state is per-row and point-read, never an aggregate meta object.
    const projections = new Map();
    for (let i = 0; i < 50_000; i += 1) {
      projections.set(`t${i}`, {
        id: `t${i}`, start_time: 's', status: 'completed',
        projection_version: PROJECTION_STALE_VERSION, source_revision: 'rev1',
        failure_class: 'envelope_oversize', failed_source_revision: 'rev1',
        failed_target_projection_version: TRIP_PROJECTION_VERSION,
      });
    }
    const page = Array.from({ length: 50 }, (_, i) => row({ id: `t${i}` }));
    const result = classifyProjectionRows(page, projections);
    expect(result.deterministicFailures).toHaveLength(50);
    expect(result.usable.length + result.needsBuild.length).toBe(0);
  });
});

describe('record shapes', () => {
  it('mirrors current source columns onto the failure marker', () => {
    const marker = projectionFailureMarkerFor(
      row({ start_time: '2026-06-02T00:00:00.000Z', status: 'draft', source_revision: 'revX' }),
      'envelope_oversize'
    );
    expect(marker.start_time).toBe('2026-06-02T00:00:00.000Z');
    expect(marker.status).toBe('draft');
    expect(marker.projection_version).toBe(PROJECTION_STALE_VERSION);
    expect(marker.encrypted_payload).toBeUndefined();
  });

  it('writes the current version and revision on a built record', () => {
    const record = projectionRecordFor(
      { id: 't1', start_time: 's', status: 'completed', source_revision: 'rev1' },
      { encrypted: true }
    );
    expect(record.projection_version).toBe(TRIP_PROJECTION_VERSION);
    expect(record.source_revision).toBe('rev1');
  });
});
