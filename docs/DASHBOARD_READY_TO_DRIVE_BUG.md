# Dashboard Tracking Readiness

Last reviewed: 2026-06-05

## Status

Resolved. The Dashboard idle trip card no longer says `Ready to drive?` when tracking is paused or required setup is incomplete.

The current implementation is in `src/pages/Dashboard.jsx`. It derives both the detailed readiness panel and the primary idle card from the same `trackingReadiness` object.

## Current States

| State | Label | Title | Primary action |
| --- | --- | --- | --- |
| Ready | `Ready to drive?` | `Start a new trip` | Starts manual tracking. |
| Paused | `Tracking is paused` | `Unpause to start` | Opens Settings. |
| Setup blocked | `<count> setup item(s) need(s) attention` | `Check tracking setup` | Opens Settings. |

The ready state is shown only when every applicable readiness check passes.

## Readiness Checks

`trackingReadiness` evaluates:

- tracking mode is not paused
- foreground location is recorded as granted
- Android Physical Activity is recorded as granted
- background location is granted for `background_auto`
- notification permission is granted for `background_auto`
- Android battery optimization is unrestricted for `background_auto`
- the native Android tracking service is armed for `background_auto`

Non-applicable checks are treated as ready. For example, background location, battery setup, and native service state do not block manual tracking.

## Card Behavior

The idle card computes:

```jsx
const paused = effectiveTrackingMode === 'paused';
const blocked = !trackingReadiness.ready;
const needsSetup = paused || blocked;
```

When `needsSetup` is true:

- the card uses amber warning styling
- the helper text shows the first blocking readiness detail
- the button uses a Settings icon
- the accessible name is `Open Settings to fix tracking setup`
- clicking the button navigates to `/settings`

When setup is ready:

- the card shows `Ready to drive?`
- the button uses the Play icon
- the accessible name is `Start trip`
- clicking starts the normal `handleStartTrip()` flow

`TrackingHealthChip` remains visible under the card copy and can provide additional native tracking context without contradicting the headline.

## Detailed Readiness Panel

The Dashboard also renders a separate readiness panel while no trip is active. It shows:

- `Tracking is ready` when all checks pass
- a blocker count when one or more checks need attention
- one card per readiness check
- a `Fix` button for actionable blocked checks

Fix actions can request or open:

- foreground location
- Physical Activity
- background location
- notifications
- battery settings
- native auto-tracking startup

After an action, the Dashboard refreshes permission, battery, native-service, and diagnostics state.

## Regression Coverage

`e2e/00-app-shell.spec.js` covers the visible idle-card states:

- ready manual state shows `Ready to drive?`
- paused state does not show `Ready to drive?`
- incomplete setup does not show `Ready to drive?`
- blocked/paused states expose the Settings action instead of starting a trip

Unit and integration coverage for permission normalization and monitoring lives under:

- `src/lib/__tests__/permissionStateMachine.test.js`
- `src/hooks/__tests__/usePermissionMonitor.test.js`
- `src/features/settings/hooks/__tests__/useSettingsSections.test.js`

## Maintenance Rule

Any new requirement that can block or materially degrade trip start must be added to:

1. the `trackingReadiness` checks
2. the detailed readiness panel
3. the idle-card blocked-state copy/action
4. Dashboard E2E coverage
5. the permission/onboarding contract when the requirement is permission-related
