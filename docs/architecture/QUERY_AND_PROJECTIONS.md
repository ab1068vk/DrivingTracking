# Query, Projections and Caching

Canonical sources: `src/api/trips.js` (authority selection),
`src/lib/queryContracts/nativeProjection.js` (projection field owner),
`src/lib/nativeTripQueryFacade.js`, `src/lib/localTripRepository.js`,
`src/lib/trackingTripSubject.js` (explicit detail identity), and the
`useBoundedTripWindow` / `useTripHistoryPageData` / `useTripHistoryTotals` hooks.

## Why History does not load the archive

A driving history grows without bound. Any surface that loads "all trips" becomes slower every
week and eventually fails on device. The query layer therefore guarantees that user-visible reads
are **bounded pages** whose cost depends on page size, not on how long someone has used the app.

Three separate concerns are kept distinct:

| Concern | Answer source | Cost |
|---|---|---|
| "Show me some trips" | Bounded page | Page size |
| "How many trips exist?" | Scalar count | Single indexed/PK read |
| "Show me this specific trip" | Direct identity resolution | One record |

Conflating these is the defect this layer exists to prevent — in particular presenting a page as
a population, or finding a specific trip by paging until it appears.

## Page contract

A page result carries:

- requested limit and returned row count,
- continuation state (whether more rows exist),
- completeness — exact or partial,
- the source authority, generation, revision and query identity.

Callers are expected to surface continuation honestly. A UI that shows "20 trips" when the window
returned 20 of 900 is misreporting.

## Population contract

Population totals are separate and **conditional**:

- Browser authority: scalar `count()` on the trip store.
- Native authority: `archive_meta.live_count`, a maintained counter read by primary key.

Both re-read the query snapshot before and after. If generation or revision moved, the result is
refused with a reason rather than published. Where a total genuinely is not indexed — for example
a status-partitioned completed count under native authority — the layer reports that it is not
available instead of deriving it by scanning.

## Projection parity

List and analytics surfaces read a **projection**: a fixed field set, not whole records. The field
list has a single owner, `src/lib/queryContracts/nativeProjection.js`, mirrored by
`PAGE_PROJECTION_FIELDS` in `DriveSenseTripArchiveRepository.java`.

The two lists must not diverge. `p7NativeWireContract.test.js` fails if they do. When adding a
projected field, update both sides in the same change.

Projection deliberately excludes route geometry and other heavy payloads; those load only for a
trip the user is actually viewing, subject to privacy and expiry rules.

## Detail identity

An explicitly requested trip must resolve directly. `trackingTripSubject.js` owns reading and
validating the requested identity (`readRequestedTripId`, `resolveTrackingTripSubject`) so
destination screens honour the subject they were given rather than substituting the first or
newest row in a loaded page.

## Cache and invalidation

Query caching is React Query based. Durable background updates — road context, weather, speed
enrichment — publish a source-change signal that invalidates the affected consumers so a mounted
screen converges rather than holding a stale value indefinitely.

Caches are keyed by the request that produced them; two different requests must not share a cache
identity merely because they read the same store.

## Authority selection

`src/api/trips.js` chooses the repository. `shouldUseLocalStore()` returns `true` unconditionally
for trips, so no trip read reaches a network API. `P35_NATIVE_AUTHORITY_ENABLED`
(`VITE_P35_NATIVE_AUTHORITY`) selects the native archive facade instead of the browser repository.

## Failure semantics

| Condition | Result |
|---|---|
| Store unavailable | Population unavailable with reason |
| Snapshot moved mid-count | Count refused |
| Partial page | Reported partial |
| Unknown requested identity | Reported as not found, not silently substituted |
| Projection divergence | Build-time/test failure via the wire contract suite |

## Testing

`p7NativeWireContract`, the P7 query/paging suites, `canonicalDetailIdentityWave5`,
`trackingSubjectWave5.render`, and the repository paging suites.
