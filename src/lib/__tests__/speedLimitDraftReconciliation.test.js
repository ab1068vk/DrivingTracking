import { describe, expect, it } from 'vitest';
import {
  changedSavedSpeedDraftKeys,
  reconcileSavedSpeedDrafts,
} from '@/lib/speedLimitDraftReconciliation';

const reconcile = (current, rows, dirtyKeys = new Set()) => reconcileSavedSpeedDrafts({
  current,
  rows,
  dirtyKeys,
  keyForRow: (row) => row.id,
  draftForRow: (row) => ({ limitKmh: String(row.limitKmh), note: row.note || '' }),
});

describe('saved speed draft reconciliation', () => {
  it('refreshes a pristine same-id form after Undo or an external update', () => {
    expect(reconcile(
      { road: { limitKmh: '80', note: 'stale' } },
      [{ id: 'road', limitKmh: 50, note: 'restored' }]
    )).toEqual({ road: { limitKmh: '50', note: 'restored' } });
  });

  it('preserves an actively edited draft during a background refresh', () => {
    const draft = { limitKmh: '70', note: 'unsaved user edit' };
    expect(reconcile(
      { road: draft },
      [{ id: 'road', limitKmh: 50, note: 'external update' }],
      new Set(['road'])
    )).toEqual({ road: draft });
  });

  it('drops drafts for rules removed by Undo, restore, or another tab', () => {
    expect(reconcile(
      { removed: { limitKmh: '90' }, kept: { limitKmh: '40' } },
      [{ id: 'kept', limitKmh: 50 }],
      new Set(['removed'])
    )).toEqual({ kept: { limitKmh: '50', note: '' } });
  });

  it('stops treating a touched draft as dirty after every value is restored', () => {
    const rows = [{ id: 'road', limitKmh: 50, note: 'persisted' }];
    const baselines = { road: { limitKmh: '50', note: 'persisted' } };
    const normalizeDraft = (draft) => JSON.stringify(draft);

    expect(changedSavedSpeedDraftKeys({
      current: { road: { limitKmh: '70', note: 'persisted' } },
      baselines,
      rows,
      keyForRow: (row) => row.id,
      normalizeDraft,
    })).toEqual(new Set(['road']));

    expect(changedSavedSpeedDraftKeys({
      current: { road: { limitKmh: '50', note: 'persisted' } },
      baselines,
      rows,
      keyForRow: (row) => row.id,
      normalizeDraft,
    })).toEqual(new Set());
  });
});
