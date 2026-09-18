# Performance

This document describes the performance model as implemented. The June 2026 lag incident
playbook that preceded it is retained at
[../historical/UI_LOADING_PERFORMANCE_PLAYBOOK.md](../historical/UI_LOADING_PERFORMANCE_PLAYBOOK.md);
its measurements are historical and its proposed changes have been implemented.

## Design rules

1. **Reads are bounded pages.** History, detail and analytics surfaces request a page with an
   explicit limit and consume continuation state. No screen loads whole history to render.
2. **Counts are scalar.** Population totals come from an indexed store count or a scalar archive
   counter, never from materialising rows.
3. **Explicit identity resolves directly.** A screen asked for a specific trip resolves that
   trip, rather than scanning or enlarging a page window until it appears.
4. **Heavy work is deferred and coordinated.** Background maintenance, enrichment and rescoring
   run as bounded turns through the work coordinator rather than at cold start.
5. **Long lists virtualise.** Trip history and saved road speeds render windows, not full
   collections.
6. **Loaded content stays visible.** Background refreshes should not blank content that is
   already on screen.

## What this protects against

The dominant historical regressions were whole-history reads on a user-visible path: a
maintenance pass at cold launch, and a saved-road-speeds screen requesting a large trip batch to
build a map model. Both classes are now structurally excluded by the bounded-page and scalar-count
rules above.

## Cost expectations

Cost should stay flat as trip history grows. A page read is proportional to the page size, not
the archive size. Status and readiness reads are fixed-cardinality lookups. Route geometry is
only materialised for a trip the user is actually viewing, subject to privacy and expiry rules.

Structural boundedness is covered by retained regression suites that assert page limits, absence
of whole-history materialisation, and fixed ceilings across dataset sizes.

## When adding a screen

- Request a bounded page and surface continuation honestly; do not present a page as a total.
- Prefer a scalar count over deriving a total from loaded rows.
- Keep derived map or geometry models out of the render path unless the user needs them.
- Route recurring background work through the coordinator rather than component effects.

## Measuring

Use the Diagnostics report for structural evidence: it distinguishes current-session from
retained performance history and reports the bounded window and population metadata separately.
See [../architecture/DIAGNOSTICS.md](../architecture/DIAGNOSTICS.md).

Real responsiveness on device hardware at realistic history sizes is a device-qualification
obligation; see [../operations/DEVICE_QUALIFICATION.md](../operations/DEVICE_QUALIFICATION.md).
