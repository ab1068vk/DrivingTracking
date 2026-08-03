/**
 * Rebuild saved-rule editor drafts from the latest persisted rows while
 * preserving only fields the user is actively editing. Removed rows are
 * intentionally dropped so Undo, restore, and cross-tab updates cannot leave
 * a stale form capable of re-applying an old value.
 *
 * @param {{
 *   current?: Record<string, any>,
 *   rows?: any[],
 *   dirtyKeys?: Set<string>,
 *   keyForRow?: (row:any) => string | undefined,
 *   draftForRow?: (row:any) => Record<string, any>
 * }} options
 */
export function reconcileSavedSpeedDrafts({
  current = {},
  rows = [],
  dirtyKeys = new Set(),
  keyForRow,
  draftForRow,
} = {}) {
  /** @type {Record<string, any>} */
  const next = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = keyForRow?.(row);
    if (!key) continue;
    next[key] = dirtyKeys?.has?.(key) && current[key]
      ? current[key]
      : draftForRow?.(row) || {};
  }
  return next;
}

/**
 * Return only drafts that still differ from the persisted version they were
 * opened from. This lets a user edit a value and then put it back without the
 * form remaining permanently "dirty" and masking later Undo/cross-tab data.
 *
 * @param {{
 *   current?: Record<string, any>,
 *   baselines?: Record<string, any>,
 *   rows?: any[],
 *   keyForRow?: (row:any) => string | undefined,
 *   normalizeDraft?: (draft:any) => string
 * }} options
 */
export function changedSavedSpeedDraftKeys({
  current = {},
  baselines = {},
  rows = [],
  keyForRow,
  normalizeDraft = JSON.stringify,
} = {}) {
  const changed = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = keyForRow?.(row);
    if (!key || !current[key] || !baselines[key]) continue;
    if (normalizeDraft(current[key]) !== normalizeDraft(baselines[key])) changed.add(key);
  }
  return changed;
}
