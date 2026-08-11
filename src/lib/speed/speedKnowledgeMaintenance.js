/**
 * Housekeeping for the on-device saved road speeds: how long learned evidence
 * is kept, how big the store has grown, and the one cleanup sequence.
 *
 * The retention window used to be the literal `180` inside Saved Road Speeds'
 * cleanup button, reachable from exactly one screen and adjustable from none.
 * It is a setting now, and both screens resolve it here so they cannot drift.
 */
import { SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT } from '@/lib/appConstants';
import { clamp } from '@/lib/mathUtils';

export const MIN_SPEED_KNOWLEDGE_RETENTION_DAYS = 30;
export const MAX_SPEED_KNOWLEDGE_RETENTION_DAYS = 730;

/** The retention window in days, clamped to the range the setting allows. */
export function speedKnowledgeRetentionDays(settings = {}) {
  const stored = settings?.speed_knowledge_retention_days;
  // Number('') and Number(null) are both 0, so a cleared input would otherwise
  // clamp to the 30-day minimum and quietly delete five months of evidence.
  if (stored === '' || stored == null) return SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT;
  const raw = Number(stored);
  if (!Number.isFinite(raw)) return SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT;
  return Math.round(clamp(
    raw,
    MIN_SPEED_KNOWLEDGE_RETENTION_DAYS,
    MAX_SPEED_KNOWLEDGE_RETENTION_DAYS
  ));
}

/**
 * What the store currently holds.
 *
 * `approximateBytes` is the serialized size of the decrypted document, which is
 * what the resolver actually reads on a cold load — not the on-disk ciphertext
 * length. It is a magnitude, not an accounting figure, and is reported as such.
 */
export function summarizeSpeedKnowledgeStorage(data) {
  const corrections = Array.isArray(data?.corrections) ? data.corrections : [];
  const candidates = Array.isArray(data?.roadMemory?.candidates)
    ? data.roadMemory.candidates
    : [];
  const cellCount = data?.cells && typeof data.cells === 'object'
    ? Object.keys(data.cells).length
    : 0;

  let approximateBytes = 0;
  try {
    approximateBytes = JSON.stringify(data ?? {}).length;
  } catch {
    // A cyclic or otherwise unserializable document is not a reason to fail the
    // whole panel; the counts above are still worth showing.
    approximateBytes = 0;
  }

  return {
    // Historical versions are retained deliberately when a rule's limit changes,
    // so they are counted apart from the rules currently in force.
    ruleCount: corrections.filter((entry) => entry?.historicalVersion !== true).length,
    historicalRuleCount: corrections.filter((entry) => entry?.historicalVersion === true).length,
    learnedRoadCount: candidates.length,
    cellCount,
    excludedSectionCount: Array.isArray(data?.excludedSections) ? data.excludedSections.length : 0,
    approximateBytes,
  };
}

/** Human-readable size for `approximateBytes`. */
export function formatApproximateBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 KB';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Drop expired temporary rules and learned evidence older than the window.
 *
 * `rescore` receives the before/after documents so the caller can re-run the
 * trips whose scores depended on what was just removed. Saved Road Speeds wraps
 * that call in its own progress chrome and Settings does not, which is the only
 * reason it is a callback rather than being done here.
 *
 * @param {{exportData: () => Promise<any>, prune: (days: number) => Promise<any>}} knowledge
 * @param {{retentionDays?: number, rescore?: ((before: any, after: any) => Promise<any>) | null}} options
 */
export async function pruneSpeedKnowledge(knowledge, { retentionDays, rescore = null } = {}) {
  const days = speedKnowledgeRetentionDays({ speed_knowledge_retention_days: retentionDays });
  const before = await knowledge.exportData();
  await knowledge.prune(days);
  const after = await knowledge.exportData();
  const updatedTrips = typeof rescore === 'function' ? await rescore(before, after) : null;
  return {
    retentionDays: days,
    before,
    after,
    updatedTrips: Array.isArray(updatedTrips) ? updatedTrips : null,
    storage: summarizeSpeedKnowledgeStorage(after),
  };
}
