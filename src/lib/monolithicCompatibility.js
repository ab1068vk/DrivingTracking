/**
 * P4-C-F04 / P4-C-F05 / P4-C-F06 — one rule for monolithic legacy documents.
 *
 * Several stores predate the paged/record representations the lifecycle
 * coordinator schedules against: the fallback `drivesense_trips` blob, the v1
 * road-context queue array and a v1 rescoring job's inline id arrays. Each of
 * them is a single indivisible JSON document, so *any* touch is O(document) —
 * reading 25 rows out of one still parses and rewrites all of it.
 *
 * The rule, applied identically in all three places:
 *
 *   A monolithic legacy/fallback document is never ordinary bounded lifecycle
 *   work. A lifecycle turn may observe that one exists (a fixed-cost probe over
 *   storage *keys*, never over the document) and must then report the
 *   obligation as belonging to the explicit compatibility owner. Only an
 *   explicit, non-lifecycle operation may parse or rewrite it.
 *
 * Nothing here schedules, retries or persists anything: it is the shared
 * vocabulary the three domains use so a reviewer sees one decision rather than
 * three private conventions.
 */

/** Who owns whole-document conversion/rotation once lifecycle declines it. */
export const MONOLITHIC_DOCUMENT_OWNER = 'explicit-compatibility-maintenance';

/**
 * The typed condition a lifecycle turn waits on while a monolithic document
 * still holds work. Its producer is the explicit compatibility operation for
 * that document — never a timer and never the coordinator itself.
 */
export const compatibilityWake = (document) => Object.freeze({
  type: 'compatibility_conversion',
  key: String(document),
});

/**
 * The result a bounded turn returns for a subpass it cannot own. Zero records,
 * zero bytes, no `hasMore`: the coordinator must charge nothing and must not
 * re-admit this as a continuation.
 */
export const monolithicOwnerless = (document, extra = {}) => Object.freeze({
  ownerless: true,
  owner: MONOLITHIC_DOCUMENT_OWNER,
  document: String(document),
  examined: 0,
  processed: 0,
  hasMore: false,
  ...extra,
});
