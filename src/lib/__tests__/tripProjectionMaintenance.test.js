import { describe, expect, it } from 'vitest';
import {
  CLEANUP_ROWS_PER_TURN,
  MAX_FALLBACK_SUPPRESSION_IDS,
  NATIVE_SUPPRESSION_SAMPLE_MAX,
  clearFallbackSuppression,
  compareMergeRows,
  defaultCleanupState,
  defaultFallbackSuppression,
  defaultNativeErasurePending,
  defaultNativeVisibility,
  fallbackReadable,
  fallbackRowVisible,
  finishCleanupPass,
  nativeImportSuppressed,
  planCleanupTurn,
  recordDeleteForNative,
  resolveNativeVisibility,
  suppressFallbackId,
  tombstoneRemovable,
  verdictIsConsistent,
} from '@/lib/tripProjectionMaintenance';
import { PROJECTION_STALE_VERSION, TRIP_PROJECTION_VERSION } from '@/lib/tripProjectionSchema';

describe('native visibility during a probe outage', () => {
  it.each([100, 1_000, 10_000])('keeps metadata constant across %i deletes', (deletes) => {
    let visibility = defaultNativeVisibility();
    let suppression = { ids: {} };
    for (let index = 0; index < deletes; index += 1) {
      ({ visibility, suppression } = recordDeleteForNative({
        visibility, suppression, tripId: `t${index}`, probe: { ok: false },
      }));
    }
    // One global flag, zero per-id entries: this is the R5 defect that R6 fixed.
    expect(visibility.state).toBe('uncertain');
    expect(visibility.generation).toBe(1);
    expect(Object.keys(suppression.ids)).toHaveLength(0);
  });

  it('creates an exact entry only when the journal actually holds the id', () => {
    let suppression = { ids: {} };
    let visibility = defaultNativeVisibility();
    ({ visibility, suppression } = recordDeleteForNative({
      visibility, suppression, tripId: 'held', probe: { ok: true, present: true },
    }));
    ({ visibility, suppression } = recordDeleteForNative({
      visibility, suppression, tripId: 'not-held', probe: { ok: true, present: false },
    }));
    expect(Object.keys(suppression.ids)).toEqual(['held']);
  });

  it('cannot exceed the journal maximum through ordinary deletes', () => {
    let suppression = { ids: {} };
    let visibility = defaultNativeVisibility();
    for (let index = 0; index < 5_000; index += 1) {
      ({ visibility, suppression } = recordDeleteForNative({
        visibility, suppression, tripId: `t${index}`,
        probe: { ok: true, present: index < NATIVE_SUPPRESSION_SAMPLE_MAX },
      }));
    }
    expect(Object.keys(suppression.ids)).toHaveLength(NATIVE_SUPPRESSION_SAMPLE_MAX);
  });

  it('resolves an outage from the bounded journal snapshot', () => {
    const resolved = resolveNativeVisibility({
      suppression: { ids: {} },
      journalIds: ['a', 'b', 'c'],
      tombstonedIds: ['b', 'c'],
    });
    expect(resolved.visibility.state).toBe('known');
    expect(Object.keys(resolved.suppression.ids).sort()).toEqual(['b', 'c']);
  });

  it('fails native import closed while visibility is uncertain or an erase is pending', () => {
    const suppression = { ids: {} };
    expect(nativeImportSuppressed({
      visibility: { state: 'uncertain' }, erasurePending: defaultNativeErasurePending(),
      suppression, tripId: 'x',
    })).toBe(true);
    expect(nativeImportSuppressed({
      visibility: defaultNativeVisibility(), erasurePending: { pending: true },
      suppression, tripId: 'x',
    })).toBe(true);
    expect(nativeImportSuppressed({
      visibility: defaultNativeVisibility(), erasurePending: defaultNativeErasurePending(),
      suppression, tripId: 'x',
    })).toBe(false);
  });
});

describe('fallback suppression', () => {
  it.each([512, 1_000, 10_000])('never stores more than 512 explicit ids across %i deletes', (deletes) => {
    let state = defaultFallbackSuppression();
    for (let index = 0; index < deletes; index += 1) state = suppressFallbackId(state, `t${index}`);
    expect(Object.keys(state.ids).length).toBeLessThanOrEqual(MAX_FALLBACK_SUPPRESSION_IDS);
    if (deletes > MAX_FALLBACK_SUPPRESSION_IDS) expect(state.saturated).toBe(true);
  });

  it('stops appending at insertion 513 rather than growing', () => {
    let state = defaultFallbackSuppression();
    for (let index = 0; index < MAX_FALLBACK_SUPPRESSION_IDS; index += 1) {
      state = suppressFallbackId(state, `t${index}`);
    }
    expect(Object.keys(state.ids)).toHaveLength(MAX_FALLBACK_SUPPRESSION_IDS);
    expect(state.saturated).toBe(false);
    const saturated = suppressFallbackId(state, 'overflow');
    expect(saturated.saturated).toBe(true);
    expect(Object.keys(saturated.ids)).toHaveLength(MAX_FALLBACK_SUPPRESSION_IDS);
    expect(saturated.ids.overflow).toBeUndefined();
    // Further deletes add nothing at all.
    const more = suppressFallbackId(saturated, 'another');
    expect(Object.keys(more.ids)).toHaveLength(MAX_FALLBACK_SUPPRESSION_IDS);
  });

  it('hides a suppressed row and fails the whole fallback closed when saturated', () => {
    const state = suppressFallbackId(defaultFallbackSuppression(), 'gone');
    expect(fallbackRowVisible(state, 'gone')).toBe(false);
    expect(fallbackRowVisible(state, 'kept')).toBe(true);
    expect(fallbackReadable(state)).toBe(true);
    expect(fallbackReadable({ ...state, saturated: true })).toBe(false);
  });

  it('bumps delete_seq when suppression clears so cleanup wakes', () => {
    const state = suppressFallbackId(defaultFallbackSuppression(), 'gone');
    const { state: cleared, deleteSeq } = clearFallbackSuppression(state, { value: 7 });
    expect(Object.keys(cleared.ids)).toHaveLength(0);
    expect(deleteSeq.value).toBe(8);
  });
});

describe('tombstone cleanup', () => {
  const clean = {
    nativeSuppression: { ids: {} },
    nativeVisibility: defaultNativeVisibility(),
    erasurePending: defaultNativeErasurePending(),
    fallbackSuppression: defaultFallbackSuppression(),
  };

  it('removes a tombstone only when no recovery copy can still exist', () => {
    expect(tombstoneRemovable({ tripId: 't', ...clean })).toBe(true);
    expect(tombstoneRemovable({ ...clean, tripId: 't', nativeVisibility: { state: 'uncertain' } })).toBe(false);
    expect(tombstoneRemovable({ ...clean, tripId: 't', erasurePending: { pending: true } })).toBe(false);
    expect(tombstoneRemovable({ ...clean, tripId: 't', nativeSuppression: { ids: { t: {} } } })).toBe(false);
    expect(tombstoneRemovable({
      ...clean, tripId: 't', fallbackSuppression: { ...defaultFallbackSuppression(), ids: { t: {} } },
    })).toBe(false);
    expect(tombstoneRemovable({
      ...clean, tripId: 't', fallbackSuppression: { ...defaultFallbackSuppression(), saturated: true },
    })).toBe(false);
  });

  it('bounds a turn by row count', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, bytes: 1024 }));
    expect(planCleanupTurn(rows).process).toHaveLength(CLEANUP_ROWS_PER_TURN);
  });

  it('processes an oversized first row alone rather than pretending it was prevented', () => {
    // secureDelete can emit 1 MiB of random bytes as a 2 MiB hex string, and the
    // cursor has already materialized it before its size can be charged.
    const rows = [{ id: 'huge', bytes: 3 * 1024 * 1024 }, { id: 'next', bytes: 512 }];
    const turn = planCleanupTurn(rows);
    expect(turn.isolatedOversized).toBe(true);
    expect(turn.process).toHaveLength(1);
    expect(turn.process[0].id).toBe('huge');
  });

  it('stops before exceeding the byte budget on a later row', () => {
    const rows = [{ id: 'a', bytes: 1_500_000 }, { id: 'b', bytes: 1_500_000 }];
    expect(planCleanupTurn(rows).process).toHaveLength(1);
  });

  it('restarts under a new generation when a delete committed behind the cursor', () => {
    const state = { ...defaultCleanupState(), sampledSeqEnd: 5, generation: 2 };
    expect(finishCleanupPass(state, 9)).toMatchObject({ generation: 3, status: 'sweeping', cursor: null });
    expect(finishCleanupPass(state, 5)).toMatchObject({ generation: 2, status: 'idle' });
  });
});

describe('completeness verifier merge', () => {
  const source = { id: 'b', start_time: '2026-01-02', status: 'completed', source_revision: 'r1' };

  it('detects a missing projection and an orphan without relying on counts', () => {
    expect(compareMergeRows(source, null).verdict).toBe('missing_projection');
    expect(compareMergeRows(null, { id: 'z', start_time: '2026-01-03' }).verdict).toBe('orphan_projection');
    // A missing row and a compensating orphan keep counts equal but are caught here.
    expect(compareMergeRows(source, { id: 'c', start_time: '2026-01-02' }).verdict).toBe('missing_projection');
  });

  it('orders equal timestamps by id', () => {
    expect(compareMergeRows(source, { id: 'a', start_time: '2026-01-02' }).advance).toBe('projection');
    expect(compareMergeRows(source, { id: 'c', start_time: '2026-01-02' }).advance).toBe('source');
  });

  it('treats a deterministic marker as accounted, not as a mismatch', () => {
    const marker = { ...source, projection_version: PROJECTION_STALE_VERSION };
    expect(compareMergeRows(source, marker).verdict).toBe('known_marker');
    expect(verdictIsConsistent('known_marker', false)).toBe(true);
  });

  it('flags stale revision, wrong version and column mismatch', () => {
    expect(compareMergeRows(source, { ...source, projection_version: 99 }).verdict).toBe('wrong_version');
    expect(compareMergeRows(source, {
      ...source, projection_version: TRIP_PROJECTION_VERSION, source_revision: 'r2',
    }).verdict).toBe('stale_revision');
    expect(compareMergeRows(source, {
      ...source, projection_version: TRIP_PROJECTION_VERSION, status: 'draft',
    }).verdict).toBe('column_mismatch');
  });

  it('accepts a tombstoned source with no projection as consistent', () => {
    expect(verdictIsConsistent('missing_projection', true)).toBe(true);
    expect(verdictIsConsistent('missing_projection', false)).toBe(false);
  });

  it('matches a healthy pair', () => {
    expect(compareMergeRows(source, {
      ...source, projection_version: TRIP_PROJECTION_VERSION,
    }).verdict).toBe('ok');
  });
});
