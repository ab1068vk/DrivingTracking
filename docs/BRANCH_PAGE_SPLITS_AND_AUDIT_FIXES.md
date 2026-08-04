# Branch: `refactor/page-splits-and-audit-fixes`

> **Branch name:** `refactor/page-splits-and-audit-fixes`
> **Branched from:** `codex/whatnow` @ `ef4adc2b` — **not** from `main`.
> `main` is at `b8796dd4`, three commits behind that point. Those three
> commits (`ef4adc2b`, `0d1ecb69`, `0d426b2e`) are earlier work that is *not*
> part of this branch and will survive deleting it.

Record of everything changed on this branch, so it can be judged or discarded
as a unit. Written 2026-08-04.

**One-line summary:** a 7-item codebase audit was fixed, 45 unused images were
moved out of the bundle, Android error-swallowing was replaced with logging,
and the three largest pages were split into modules — 3,339 lines moved out of
`Dashboard.jsx`, `SpeedLimits.jsx` and `Settings.jsx` with no behaviour change
intended anywhere.

---

## 1. How to throw this away

All of this work is in **one commit** on
**`refactor/page-splits-and-audit-fixes`**. To discard every bit of it:

```bash
git checkout codex/whatnow
git branch -D refactor/page-splits-and-audit-fixes
npm install          # package.json / package-lock.json changed on the branch
npm run build
```

That returns you to `ef4adc2b`, the state before any of this work — with the
three earlier `codex/whatnow` commits intact. **Do not `git checkout main` for
this**: `main` is three commits further back and would also drop unrelated
earlier work.

To keep the work but undo it in place instead:

```bash
git revert <the commit sha>
```

Confirm you are rid of it with `git log --oneline -1` (should read
`ef4adc2b`) and `git status` (should be clean).

> **Why a branch and not just uncommitted files:** uncommitted changes are not
> attached to any branch — they follow you when you switch and survive a branch
> delete. Committing here is what makes "delete the branch" a real undo.

---

## 2. If something breaks on the phone, is it this branch?

Use this order. The first two are cheap and usually decisive.

**Step 1 — does the same build from `main` break?**
This is the only definitive test.

```bash
git stash -u                 # or commit on this branch first
git checkout main
npm install && npm run android:sync
cd android && ./gradlew.bat assembleDebug
```

Install that APK. Same fault on `main` → not this branch. Fault only on the
branch → it is this branch, and section 6 tells you which stage to suspect.

**Step 2 — match the symptom against what actually changed.**

| Symptom | Could this branch cause it? |
|---|---|
| A screen renders blank, or a card shows `undefined` | **Yes — most likely.** The page splits are the only changes that can do this. Suspect stage 4 or 5. |
| Saved Road Speeds tab is empty or loses state | **Yes.** Stage 4 split those three tabs. |
| Dashboard panel missing in premium *or* standard mode | **Yes.** Stage 5 moved those panels. |
| A Settings control does not save, or a section will not open | **Yes.** Stage 3 moved `SettingRow` / `SettingsSection`. |
| Trip scores changed | **Very unlikely.** `SCORING_VERSION` is unchanged at `67acfb08`, so no scoring constant moved. Nothing in `src/lib/tripEngine.js` was touched. |
| Tracking stops, trips do not start, background service dies | **Very unlikely.** The only Android changes are added log statements — see section 4. |
| Backup import/export fails, or data is lost | **No.** Backup format and migrations were not touched. |
| App will not install / upgrade wipes data | **No.** Package identity, `versionCode` and storage keys unchanged; `npm run recovery:guard` passes. |

**Step 3 — check `adb logcat`.** Because of the Android change in section 4,
failures that used to be silent now log. A `Log.w` from `AutoTrackingService`
and friends is *new visibility of an old problem*, not a new problem.

**The honest caveat:** the JS refactor was verified by 2,181 unit tests, 61
Playwright tests and manual checks in a desktop browser — **not on a device**.
Anything device-specific (WebView version, memory pressure, Android lifecycle)
is unverified. Blank or partly-rendered screens on the phone are the realistic
residual risk. Tracking, scoring and storage are not.

---

## 3. Audit fixes (items 1–7)

Seven findings from a full-codebase review, all fixed.

1. **Weather "confirm locally" / "get weather" did nothing and never saved.**
   `enqueueLocationRequest` in `src/lib/requestObfuscator.js` now takes an
   `options` argument so a caller can pass the settings it is acting on;
   heightened-privacy mode still wins over any caller-supplied value.
   `src/lib/weatherContext.js` gained `isUsableWeatherObservation()` and
   `resolveWeatherContextAfterLookup()`.
2. **Silent backup-restore failures.** `Settings.jsx` used an exclusive
   if/else chain that reported only the first problem, hiding calibration-label
   and speed-knowledge restore failures. Extracted to
   `src/lib/dataBackupPresentation.js` (`collectBackupImportIssues`,
   `describeBackupImportResult`), which collects every issue.
3. **Lint gaps.** `eslint.config.js`: the React ruleset now also covers
   `src/hooks/**` and `src/lib/**/*.jsx`; `react-hooks/exhaustive-deps` raised
   to `error`; `ignoreRestSiblings` enabled. All resulting violations fixed.
4. **Unused imports/vars** removed across the tree.
5. **God files** — the page splits. See section 6.
6. **Suspected duplicate components** — investigated and found *not* to be
   duplicates. `TripCard` delegates to `PremiumTripCard` (a deliberate router
   pattern) and `TrackingTripDetail` is a different product surface from
   `TripDetail`. No change made. The genuinely dead
   `PremiumSavedRoadSpeeds.jsx` was deleted (with its test).
7. **CI dependency gate.** `npm audit` replaced with
   `scripts/check-dependency-audit.mjs`, which fails on unreviewed advisories
   *and* on exceptions that have gone stale. Three documented `react-router`
   exceptions.

**Two real bugs found by the new tests**, both the same root cause —
`Number(null) === 0` turning a privacy-redacted coordinate into a real point at
0,0: fixed in `src/lib/commuteMatching.js` and `src/lib/activityRecognition.js`.

**Two more found while extracting helpers:**

- `tripLabel` fell back to `|| 0`, which builds a valid epoch date, so an
  untimed trip rendered as `1970-01-01` and the `Trip <id>` branch was
  unreachable. Fixed.
- `distanceMeters` treated `null`/`''`/`[]` coordinates as 0. Fixed with an
  explicit guard. Both have regression tests naming the trap.

---

## 4. Android / Java changes

**12 files, +160/−48, and every line is logging.** The pattern

```java
} catch (Exception ignored) {}
```

became

```java
} catch (Exception error) {
    Log.w(TAG, "Could not …", error);
}
```

plus the `import android.util.Log` and `TAG` constant each file needed. Two
variables were renamed (`fallbackError`, `placeholderError`) because the new
name shadowed an existing one — caught by `gradlew compileDebugJavaWithJavac`.

Files: `AppExperienceWatchdog`, `DriveSenseActiveTripCheckpointStore`,
`DriveSenseActivityRecognitionPlugin`, `DriveSenseAutoTrackingService`,
`DriveSenseAutoTrackingTileService`, `DriveSenseBootReceiver`,
`DriveSenseCompletedTripJournal`, `DriveSenseNativeTripStore`,
`DriveSenseParkingResolver`, `DriveSensePhoneUsageTracker`,
`ParkingReviewNotifier`, `PrivacyZoneChecker`.

**No control flow changed.** If the phone misbehaves in tracking, this is not
a plausible cause — but it will now tell you more in `logcat` than it used to.

---

## 5. Asset cleanup

45 unreferenced PNGs moved from `src/assets/` to `assets-unused/` (with a
README explaining why). They are still in the repo, just out of the bundle.
`src/index.css` lost 2,804 lines of dead CSS belonging to the deleted
`PremiumSavedRoadSpeeds` component; brace balance was verified after the cut.

---

## 6. The page splits (stages 1–5)

Every stage was **move-only**: code was cut and pasted, with `export` added.
No renaming, no reformatting, no "while I'm here" fixes.

| Page | Before | After | Change |
|---|---|---|---|
| `src/pages/Settings.jsx` | 6,887 | 6,576 | −311 |
| `src/pages/SpeedLimits.jsx` | 5,607 | 3,709 | −1,898 |
| `src/pages/Dashboard.jsx` | 5,125 | 3,995 | −1,130 |

**Stage 0 — safety nets (no production code).**
`src/lib/__tests__/helpers/pageSourceBundle.js` is the important one. Several
tests read page source as raw text and assert `not.toContain(...)`; once
content moves to a new file those assertions pass while scanning nothing. The
helper bundles each page with its extraction directory so those contracts keep
reading the same text. Also `e2e/speed-limits-workspaces.spec.js` (new
Playwright cover for all three tabs) and a widened exclusion in
`numericDisplayConsistency.test.js`.

**Stage 1 — Dashboard module helpers** → `src/components/dashboard/`
`dashboardHelpers.js` (247), `dashboardSpeedPlanner.js` (220).

**Stage 2 — SpeedLimits helpers** → `src/components/speedLimits/`
`speedRuleFormatting.js` (173), `speedRuleDrafts.js` (270),
`speedRuleGeometry.js` (69), `speedRuleSections.js` (34). 57 new unit tests.

**Stage 3 — Settings primitives** → `src/components/settings/`
`SettingsPrimitives.jsx` (107) — `SectionTitle`, `SettingsSubheading`,
`SettingsSection`, `SettingRow`, and four helpers — plus
`settingsSectionManifest.js` (248) holding all 14 `SETTINGS_SECTIONS` entries.

**Stage 4 — SpeedLimits workspaces** (the largest win)
`SpeedLimitSavedWorkspace.jsx` (618, 30 props),
`SpeedLimitReviewWorkspace.jsx` (386, 25 props),
`SpeedLimitMapWorkspace.jsx` (822, 61 props).

**Stage 5 — Dashboard panels**
`DashboardRiskPanel.jsx` (354) and `DashboardSummaryPanels.jsx` (442, 24 props).

Each JSX extraction was done in two steps: first convert the block into a
props-threaded component *in the same file* (where lint and `tsc` can catch a
stale closure or a missed binding), verify, then cut it to its own file.
Free-variable sets were computed with a `@babel/parser` pass, not by eye, and a
second parser pass confirmed every declared prop is actually passed.

---

## 7. Two placement rules that must not be "tidied"

1. **Extracted page code lives under `src/components/`, never `src/lib/`.**
   `jsconfig.json` typechecks `src/components/**` but not `src/lib/**`, and
   ESLint gives `src/components/**` the full React ruleset. Moving these to
   `src/lib/` silently drops both. This caught three real bugs during the work.
2. **The SpeedLimits workspaces stay in `src/components/speedLimits/` with a
   `SpeedLimit*` filename.** The directory is what `pageSourceBundle.js`
   bundles (section 6); the filename prefix is what keeps
   `numericDisplayConsistency`'s exemption applying. Moving them to
   `src/components/` root breaks the first; renaming breaks the second.

Both files carry header comments saying this.

---

## 8. Deliberately not changed

- **`src/lib/tripEngine.js`** (7,869 lines). Its scoring cluster is mutually
  recursive with hoisted functions and hidden mutable state, and the only
  behavioural guard is two golden fixtures. `SCORING_VERSION` hashes only
  `scoringConstants.js`, so a scoring regression would ship with no version
  bump. If this file must shrink, the right first investment is 10–15 more
  golden fixtures, not a split.
- **`DriveSenseAutoTrackingService.java`** structure (5,166 lines) — only the
  logging above.
- **`handleEndTrip`** (~1,050 lines) and **`handleStartTrip`** in
  `Dashboard.jsx` — orchestration across ~24 closures, no test executes them.
- **Settings section bodies** — out of agreed scope.

---

## 9. Verification status

| Check | Result |
|---|---|
| `npm run lint` | pass (exit 0) |
| `npm run typecheck` | pass (exit 0) |
| `npm test` | 2,181 passed, 3 skipped |
| `npm run build` | pass |
| `npx playwright test` | 61 passed, 1 skipped |
| `npm run recovery:guard` | pass |
| `npm run scoring:version:check` | `67acfb08` current |
| Manual, desktop browser | 3 SpeedLimits tabs, premium toggle, Settings page — clean console |
| **On a physical device** | **not done** |

Test count went 2,124 → 2,181; every pre-existing test still passes.

Run the whole set with:

```bash
npm run lint && npm run typecheck && npm test && npm run build && npx playwright test
```

`npx playwright test` serves the prebuilt `dist/` — always `npm run build`
first or you are testing a stale bundle.
