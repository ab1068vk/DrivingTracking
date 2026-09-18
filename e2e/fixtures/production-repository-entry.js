/**
 * Browser entry for the production DB-v3 conformance spec.
 *
 * Re-exports the shipped repository module unchanged so the Chromium test drives
 * production code — the migration runner, the bounded query, the projection
 * writer and the maintenance runners — not a re-implementation of them.
 */
export {
  localTripRepository,
  runProjectionMaintenance,
  DB_NAME,
  DB_VERSION,
} from '@/lib/localTripRepository';

/**
 * P6 surfaces for the real-browser E4 and derived-schema spec. Same rule: these
 * are the shipped modules, so Chromium drives the production migration runner,
 * the production E4 fence and the production readiness vocabulary.
 */
export {
  P6_SPEED_SCOPED_READ_REQUIRED,
  P6_SPEED_STORES,
  SPEED_KNOWLEDGE_DB_NAME,
  SPEED_KNOWLEDGE_STORAGE_KEY,
  SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
  beginP6BrowserSpeedMigration,
  cancelP6BrowserSpeedMigrationTurn,
  isP6BrowserSpeedV2Authority,
  queryP6BrowserSpeedEditorItems,
  readP6BrowserSpeedAuthority,
  readP6BrowserSpeedBuckets,
  speedKnowledgeStore,
  stepP6BrowserSpeedMigration,
} from '@/lib/speedKnowledgeRepository';
export { P6_TRIP_DERIVED_STORES, openP6TripDerivedDatabase } from '@/lib/localTripRepository';
export { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
export { readP6TripDomainReadiness } from '@/lib/p6TripDerivedState';
export { stepP6RoadMemoryUpdate } from '@/lib/p6RoadMemoryState';

/**
 * P7-IMPL-F06 — the **production** query path, for the real-storage campaign.
 *
 * The first campaign built a production-shaped database and then ran its own
 * copy of the keyset trace. That proves IndexedDB behaves; it does not prove
 * the shipping read does. These are the shipped entry points, so the Chromium
 * campaign drives production Q1, production projection materialization and the
 * production decrypt path, and observes them from outside.
 */
export {
  __projectionCountersForTests,
  __resetProjectionCountersForTests,
  queryTripHistoryPage,
  queryTripAdjacent,
} from '@/lib/localTripRepository';
export { queryTripReducer } from '@/lib/tripQueryReducers';
