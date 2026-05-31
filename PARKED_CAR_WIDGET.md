# Parked Car Widget

## Summary

The Road Sage parked-car widget is a native Android home-screen AppWidget that shows the user's last saved parking location. It displays a compact parked-car card with a map preview, a relative parked timestamp, and a button that opens turn-by-turn navigation to the saved coordinate.

This widget is implemented in the Android layer, not in the React/Vite UI. It uses Android `RemoteViews`, `AppWidgetProvider`, `SharedPreferences`, and WorkManager.

## User Experience

### Normal State

When a valid parked location exists, the widget shows:

- A dark rounded card background.
- A small blue `P` badge in the header.
- Header text: `Car parked here`.
- A map preview centered on the parked coordinate.
- A blue/white parked pin drawn into the center of the fetched map image.
- Status text such as `Parked just now`, `Parked 10m ago`, `Parked 2h ago`, or `Parked 2h 15m ago`.
- A full-width blue button labeled `Navigate to car`.

Interactions:

- Tapping the widget root opens Road Sage through `MainActivity` with the `drivesense://dashboard` deep-link extra.
- Tapping `Navigate to car` launches an Android `geo:` intent:
  - Format: `geo:<lat>,<lng>?q=<lat>,<lng>(Your%20Car)`
  - The receiving app is usually Google Maps or the user's default maps app.

### Empty State

When no parked location is available, or the saved payload is invalid, the widget shows:

- Header text: `Car parked here`.
- Status text: `No parked location saved yet`.
- Empty hint text:

```text
Complete a drive to
save your parking spot
```

The map image and navigation button are hidden. Tapping the widget root still opens Road Sage.

## UI Specification

Main layout file:

- `android/app/src/main/res/layout/widget_parked_car.xml`

Widget provider metadata:

- `android/app/src/main/res/xml/widget_parked_car_info.xml`

### Widget Size

The widget is configured as a resizable home-screen widget:

- Minimum width: `180dp`
- Minimum height: `180dp`
- Target cell width: `2`
- Target cell height: `2`
- Resize mode: horizontal and vertical
- Category: home screen
- Update period: `1800000` ms, or 30 minutes
- Initial and preview layout: `@layout/widget_parked_car`

### Root Container

The root view is a vertical `LinearLayout`:

- ID: `@+id/widget_root`
- Width/height: `match_parent`
- Orientation: vertical
- Padding: `12dp`
- Background: `@drawable/widget_bg_parked`

The background drawable is:

- File: `android/app/src/main/res/drawable/widget_bg_parked.xml`
- Shape: rectangle
- Fill: `#F0101828`
- Corner radius: `20dp`

### Header

The header is a horizontal `LinearLayout`:

- Width: `match_parent`
- Height: `wrap_content`
- Gravity: center vertical

It contains:

- A `20dp x 20dp` badge showing `P`
  - Text color: `#FFFFFFFF`
  - Text size: `12sp`
  - Bold
  - Centered
  - Background: `@drawable/btn_navigate_bg`
- A header `TextView`
  - ID: `@+id/tv_header`
  - Text: `Car parked here`
  - Text color: `#FFFFFFFF`
  - Text size: `12sp`
  - Bold
  - Single line with end ellipsis
  - Start margin: `7dp`

### Map Preview

The map preview uses an `ImageView`:

- ID: `@+id/iv_map`
- Width: `match_parent`
- Height: `0dp`
- Weight: `1`
- Top/bottom margin: `7dp`
- Scale type: `centerCrop`
- Default source/background: `@drawable/widget_map_placeholder`
- Content description: `@string/widget_parked_map_description`

The placeholder drawable is:

- File: `android/app/src/main/res/drawable/widget_map_placeholder.xml`
- Base fill: `#1A2A4A`
- Outer corner radius: `6dp`
- Inner rectangle fill: `#22334A`
- Inner stroke: `1dp`, `#334466`
- Inner corner radius: `4dp`

### Empty Hint

The empty hint uses a `TextView`:

- ID: `@+id/tv_empty_hint`
- Width: `match_parent`
- Height: `0dp`
- Weight: `1`
- Top/bottom margin: `7dp`
- Text: `Complete a drive to\nsave your parking spot`
- Text color: `#FF78AACC`
- Text size: `10sp`
- Gravity: center
- Default visibility: `gone`

### Parked Status

The parked status uses a `TextView`:

- ID: `@+id/tv_parked_status`
- Width: `match_parent`
- Height: `wrap_content`
- Initial text: `Loading...`
- Normal populated text: `Parked <age>`
- Empty-state text: `No parked location saved yet`
- Text color: `#FFAABBD0`
- Text size: `10sp`
- Single line with end ellipsis

### Navigation Button

The navigation action uses a `Button`:

- ID: `@+id/btn_navigate`
- Width: `match_parent`
- Height: `30dp`
- Top margin: `5dp`
- Text: `Navigate to car`
- Text color: `#FFFFFFFF`
- Text size: `11sp`
- Text all caps: false
- Horizontal padding: `0dp`
- Background: `@drawable/btn_navigate_bg`

The button background drawable is a selector:

- File: `android/app/src/main/res/drawable/btn_navigate_bg.xml`
- Default fill: `#FF3B82F6`
- Pressed fill: `#FF2563EB`
- Corner radius: `8dp`

## Android Registration

The widget receiver is registered in:

- `android/app/src/main/AndroidManifest.xml`

Receiver:

```xml
<receiver
    android:name=".ParkedCarWidgetProvider"
    android:exported="true"
    android:label="Parked Car Locator">
    <intent-filter>
        <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
    </intent-filter>
    <meta-data
        android:name="android.appwidget.provider"
        android:resource="@xml/widget_parked_car_info" />
</receiver>
```

The widget uses app strings from:

- `android/app/src/main/res/values/strings.xml`

Relevant strings:

- `widget_parked_description`: `Shows where you last parked your car`
- `widget_parked_map_description`: `Map showing parked car location`

## Core Classes

### `ParkedCarWidgetProvider`

File:

- `android/app/src/main/java/com/roadsage/app/ParkedCarWidgetProvider.java`

Responsibilities:

- Handles widget updates through `onUpdate`.
- Deletes the per-widget cached map image in `onDeleted`.
- Refreshes every widget through `refreshAll`.
- Reads the saved parked location from `DriveSenseNativeTripStore`.
- Validates latitude, longitude, and timestamp.
- Switches between normal and empty UI states.
- Displays cached map previews when available and fresh.
- Schedules a map fetch when the cached preview is missing or stale.
- Wires root widget taps to the Road Sage dashboard.
- Wires the navigation button to an Android `geo:` intent.

Important methods:

- `onUpdate(Context, AppWidgetManager, int[])`
- `onDeleted(Context, int[])`
- `refreshAll(Context)`
- `updateWidget(Context, AppWidgetManager, int)`
- `formatAge(long)`
- `parkedTimestampMs(JSONObject, long)`
- `showEmptyState(RemoteViews)`
- `setNavigateIntent(Context, RemoteViews, int, double, double)`
- `setDashboardTapIntent(Context, RemoteViews, int)`
- `scheduleMapFetch(Context, int, double, double)`

### `MapTileFetchWorker`

File:

- `android/app/src/main/java/com/roadsage/app/MapTileFetchWorker.java`

Responsibilities:

- Runs a network-backed map fetch through WorkManager.
- Downloads a static map image from `staticmap.openstreetmap.de`.
- Draws a centered parked-car pin onto the bitmap.
- Caches the resulting PNG under Android app files.
- Partially updates the widget image after a successful fetch.

Worker input keys:

- `tile_url`
- `widget_id`
- `lat`
- `lng`

Cache file:

```text
<context files dir>/parked_map_widget_<widgetId>.png
```

The worker uses this HTTP user agent:

```text
RoadSage/1.0 (Android parked car widget)
```

### `DriveSenseNativeTripStore`

File:

- `android/app/src/main/java/com/roadsage/app/DriveSenseNativeTripStore.java`

Responsibilities relevant to the widget:

- Stores native completed trips and diagnostic events.
- Saves the latest parked location after a native trip ends in a parked state.
- Reads parked-location records from native storage.
- Falls back to Capacitor storage keys so web-saved parked locations remain visible to native Android code.
- Migrates old native preferences from `drivesense_native_tracking` to `road_sage_native_tracking`.

Parked-location storage keys:

- Native prefs name: `road_sage_native_tracking`
- Old native prefs name: `drivesense_native_tracking`
- Native key: `last_parked_location`
- Capacitor prefs name: `CapacitorStorage`
- Current Capacitor fallback key: `road_sage_last_parked`
- Legacy Capacitor fallback key: `drivesense_last_parked`

Saved native parked-location JSON shape:

```json
{
  "lat": 43.65,
  "lng": -79.38,
  "timestamp": "2026-05-31T04:00:00Z",
  "timestamp_ms": 1780200000000,
  "tripId": "native_trip_...",
  "source": "native_parking_stop"
}
```

## Data Flow

### Native Trip Ending

1. `RoadSageAutoTrackingService` finishes a trip.
2. If the stop reason is parked-like, it reads the final route point.
3. It calls `DriveSenseNativeTripStore.saveLastParkedLocation(...)`.
4. It calls `ParkedCarWidgetProvider.refreshAll(this)`.
5. `refreshAll` clears stale per-widget map cache files.
6. Each widget is updated with the new coordinate and timestamp.
7. The widget schedules `MapTileFetchWorker` to fetch a fresh map preview.

The native source field is:

- `native_parking_stop` when using the final trip point directly.
- `native_trimmed_parked_tail` when trimmed tail points affected the parked endpoint.

### Web/App Parking Saves

The React app stores parked locations through:

- `src/lib/trackingStore.js`

Function:

- `saveLastParkedLocation({ lat, lng, timestamp, tripId, address, source })`

The web record shape is:

```json
{
  "lat": 43.65,
  "lng": -79.38,
  "timestamp": "2026-05-31T04:00:00Z",
  "tripId": "trip-id",
  "address": null,
  "source": "trip_end"
}
```

The native widget can read Capacitor-stored parked records through fallback keys. If only an ISO timestamp exists, the widget parses it with `Instant.parse(...)`. If neither `timestamp_ms` nor a valid ISO `timestamp` is available, it falls back to the current update time.

## Update Logic

Widget update behavior:

1. Create `RemoteViews` from `R.layout.widget_parked_car`.
2. Load parked location with `DriveSenseNativeTripStore.getLastParkedLocation(context)`.
3. If missing, show empty state and set dashboard tap intent.
4. Read `lat`, `lng`, and timestamp.
5. If coordinates are invalid or timestamp is invalid, show empty state.
6. Show the map, status, and navigation button.
7. Format status as `Parked <relative age>`.
8. If cached map file exists and is newer than or equal to the parked timestamp, decode and show it.
9. Otherwise show placeholder and schedule `MapTileFetchWorker`.
10. Set button and root tap intents.
11. Call `manager.updateAppWidget(widgetId, views)`.

Age formatting:

- Under 1 minute: `just now`
- Under 60 minutes: `<minutes>m ago`
- Whole hours: `<hours>h ago`
- Hours plus minutes: `<hours>h <minutes>m ago`

## Static Map Fetching

The widget fetches map previews from:

```text
https://staticmap.openstreetmap.de/staticmap.php?center=<lat>,<lng>&zoom=16&size=300x150
```

WorkManager details:

- Worker class: `MapTileFetchWorker`
- Work tag: `parked_map`
- Unique work name: `parked_car_map_<widgetId>`
- Existing work policy: `REPLACE`
- Network constraint: `NetworkType.CONNECTED`

After download:

- The image is copied to an ARGB bitmap.
- A centered pin is drawn:
  - White outer circle with shadow, radius `22f`
  - Blue inner circle `#FF3B82F6`, radius `16f`
  - White bold `P`, text size `20f`
- The result is saved as PNG at quality `90`.
- The widget image is updated with `manager.partiallyUpdateAppWidget(widgetId, views)`.

Retry/failure behavior:

- Missing URL or widget ID returns `Result.failure()`.
- Fetch failure returns `Result.retry()`.
- Cache write failure returns `Result.retry()`.
- If the static map is unavailable, the widget keeps showing the local placeholder until a later successful fetch.

## Cache Lifecycle

Each widget instance has its own cached map file:

```text
parked_map_widget_<widgetId>.png
```

Cache is used when:

- The cache file exists.
- Its `lastModified()` value is greater than or equal to the parked-location timestamp.
- The bitmap decodes successfully.

Cache is cleared when:

- A widget instance is deleted.
- `ParkedCarWidgetProvider.refreshAll(...)` runs after a native parked location update.

## Privacy And Network Behavior

The widget may disclose the saved parked coordinate to `staticmap.openstreetmap.de` when it needs a refreshed map preview. This happens only when:

- A widget instance exists.
- A valid saved parked coordinate exists.
- The cached map image is missing or stale.
- Network is connected.

The navigation button sends the parked coordinate to the user's chosen Android maps/navigation app through a `geo:` intent.

The root widget tap stays inside Road Sage and sends only a local `MainActivity` intent with the dashboard deep-link extra.

## Permissions And Dependencies

Relevant Android permissions:

- `android.permission.INTERNET`
- `android.permission.ACCESS_NETWORK_STATE`

Relevant dependency:

- `androidx.work:work-runtime:2.9.0`

The widget also depends on normal Android AppWidget APIs and the app's existing Capacitor Android shell.

## Test Coverage

Unit tests in:

- `android/app/src/test/java/com/roadsage/app/RoadSageAutoTrackingServiceTest.java`

Covered widget-related behavior:

- `ParkedCarWidgetProvider.formatAge(...)`
- `ParkedCarWidgetProvider.parkedTimestampMs(...)`

Instrumentation tests in:

- `android/app/src/androidTest/java/com/roadsage/app/DriveSenseNativeTripStoreInstrumentedTest.java`

Covered widget-adjacent storage behavior:

- Package name matches app ID.
- Native trip store recovers from malformed completed-trip storage.
- Last parked location falls back to Capacitor storage.
- Invalid parked-location payload returns `null`.

Useful commands:

```powershell
.\gradlew.bat test
.\gradlew.bat connectedAndroidTest
```

Run these from the `android` directory.

## Important Files

| File | Purpose |
| --- | --- |
| `android/app/src/main/java/com/roadsage/app/ParkedCarWidgetProvider.java` | Main AppWidget provider, state rendering, tap intents, refresh scheduling |
| `android/app/src/main/java/com/roadsage/app/MapTileFetchWorker.java` | Static map fetch, pin drawing, cache write, partial widget update |
| `android/app/src/main/java/com/roadsage/app/DriveSenseNativeTripStore.java` | Native and fallback parked-location storage |
| `android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java` | Saves parked location after parked trip completion and refreshes widgets |
| `android/app/src/main/res/layout/widget_parked_car.xml` | RemoteViews widget UI |
| `android/app/src/main/res/xml/widget_parked_car_info.xml` | Widget size, update, category, and preview metadata |
| `android/app/src/main/res/drawable/widget_bg_parked.xml` | Widget card background |
| `android/app/src/main/res/drawable/btn_navigate_bg.xml` | Header badge and navigate button background selector |
| `android/app/src/main/res/drawable/widget_map_placeholder.xml` | Local placeholder while no map is available |
| `android/app/src/main/res/values/strings.xml` | Widget description and map accessibility string |
| `android/app/src/main/AndroidManifest.xml` | Widget receiver registration and permissions |
| `src/lib/trackingStore.js` | Web-side last parked location save/read helpers |

## Known Behavior And Constraints

- The widget is Android-only.
- It uses `RemoteViews`, so UI elements are intentionally simple and must use AppWidget-compatible Android views.
- The widget does not render the React app UI.
- The map preview is static, not interactive.
- Map refreshes are per widget ID.
- If multiple widget instances exist, each has a separate cached image and WorkManager job.
- The map cache is stored in app-private files, not shared external storage.
- If the external static-map service fails, the widget remains usable but shows the placeholder map.
- The 30-minute `updatePeriodMillis` is a system hint; Android may batch or defer periodic widget updates.
- Immediate refresh after native trip completion is handled explicitly by `ParkedCarWidgetProvider.refreshAll(...)`.
