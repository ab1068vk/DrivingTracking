# Road Sage Speed, Speed-Limit Fallback, and Voice Alert Documentation

Last reviewed: 2026-06-20

This document explains the current Road Sage speed pipeline: how speed is recorded, cleaned, scored, compared against speed limits, enriched by OpenStreetMap, and spoken through live voice alerts.

It is intentionally a current-state document. It describes what the app does today, including the fallback behavior when `Get Road Data` is not used.

## Quick Answer

When `Get Road Data` is not clicked and automatic road-data fetching is off, Road Sage does not ask OpenStreetMap for speed limits. It uses the app's own GPS-based inferred speed-limit fallback.

The main fallback order is:

1. Posted or estimated limit already stored on the route point.
2. GPS-inferred speed zone from the trip's observed speed pattern.
3. Road-type fallback limit.
4. Global configured fallback threshold.

For most saved trips without road data, speed-limit scoring is labeled as `gps_inferred_speed_limit`, and inferred speeding penalties are half-weighted.

## Local Speed Intelligence

Saved and observed limits now use a shared evidence contract:

- `src/lib/speedLimitConfidence.js` defines source authority, base confidence, scoring weight, freshness windows, and review state.
- `src/lib/speedLimitIntelligence.js` ranks review work, builds correction recommendations, previews affected trips and likely over-limit samples, and summarizes trip coverage.
- Confirmed posted signs and OSM `maxspeed` data remain distinct from estimates and inferred traffic behavior.
- Observed driving speed can request review, but it cannot automatically become legal posted-sign evidence.
- User corrections preserve verification status, evidence count, freshness metadata, and a bounded audit trail.
- The saved-speed map aggregates evidence across matching trips, supports route snapping, split and compatible-section merge preparation, and previews impact before save.
- Speed Analysis reports total limit coverage separately from verified coverage and links uncertain sections back to road-speed review.
- Speed knowledge is stored in the local `drivesense_speed_knowledge` IndexedDB database. Existing `speed_knowledge_v1` local-storage or Capacitor Preference data is migrated automatically and retained as a fallback only when IndexedDB is unavailable.
- User operations keep a bounded local undo/redo history. Grouped split, merge, conflict-review, and bulk actions undo as one operation.
- The full-app backup preserves saved road-speed rules, verification metadata, edit history, and bounded audit trails. The speed page also supports an optional speed-only JSON export and restore for transferring or reviewing speed rules without exposing trips and other app data; speed-only restores can be undone.
- Local health checks flag unresolved conflicts, expired rules, stale learned evidence, invalid geometry, invalid limits, and same-road limit disagreements.
- Saved roads, trip geometry, labels, and editing remain available offline. Standard OpenStreetMap tiles are not bulk-downloaded or persistently cached; the base map requires internet.

Review priority is based on conflict severity, missing posted data, confidence, freshness, affected trips, score impact, and available route samples. These values organize review work; they do not establish the legal speed limit.

## Source Map

| Area | Main files |
| --- | --- |
| Live GPS capture and point normalization | `src/lib/trackingService.js`, `src/lib/tripEngine.js` |
| Trip stats, speed cleanup, inferred zones, events, scoring | `src/lib/tripEngine.js` |
| OSM speed-limit lookup and road-type default tables | `src/lib/speedLimitSource.js` |
| IndexedDB speed-rule persistence and migration | `src/lib/speedKnowledgeRepository.js` |
| Speed-rule health diagnostics | `src/lib/speedKnowledgeHealth.js` |
| Manual `Get Road Data`, OSRM, weather, and trip rescore | `src/lib/openSourceTripContext.js`, `src/lib/roadContextQueue.js` |
| Live dashboard speed checks and posted warnings | `src/pages/Dashboard.jsx` |
| Live coach overlay and speeding notifications | `src/components/LiveCoachOverlay.jsx`, `src/lib/notificationService.js` |
| Voice alert text and speech output | `src/lib/voiceAlertMessages.js`, `src/lib/voiceAlerts.js` |
| Settings defaults and toggles | `src/lib/trackingStore.js`, `src/pages/Settings.jsx` |
| Speed-limit tests | `src/lib/__tests__/speedLimitCompliance.test.js`, `src/lib/tripEngine.test.js`, `src/lib/__tests__/openSourceContext.test.js` |

## Key Settings

| Setting | Default | Meaning |
| --- | ---: | --- |
| `speed_warning_enabled` | `true` | Enables live dashboard speed checks and posted warnings. |
| `voice_alerts_enabled` | `true` | Enables spoken alerts, including speed checks and posted warnings. |
| `notif_speeding_alert_enabled` | `true` | Enables native speeding notifications. |
| `threshold_speeding_kmh` | `100` | App-level fallback speed threshold. Used mainly for highway/default fallback behavior. |
| `threshold_speed_over_kmh` | `5` | Margin above the selected limit before a warning/event is triggered. |
| `speed_limit_lookup_enabled` | `true` | Allows `Get Road Data` to call OpenStreetMap Overpass for speed limits. |
| `configurable_country_defaults` | `global` | Selects country road-type estimates when OSM returns a road type but no `maxspeed`. |
| `external_context_auto_fetch_enabled` | `false` | If enabled with consent, future trips can fetch speed limits and weather automatically. |
| `map_matching_enabled` | `false` | Optional OSRM route snapping. It does not provide speed limits. |

The configurable settings are merged into trip-engine thresholds through `buildDrivingThresholds`.

```js
export function buildDrivingThresholds(settings = {}) {
  return {
    ...DEFAULT_THRESHOLDS,
    SPEEDING_FALLBACK_KMH: settingNumber(
      settings.threshold_speeding_kmh,
      DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH
    ),
    SPEED_OVER_KMH: settingNumber(
      settings.threshold_speed_over_kmh,
      DEFAULT_THRESHOLDS.SPEED_OVER_KMH
    ),
    // other safety, smoothness, eco, and phone thresholds...
  };
}
```

## Speed Data Model

Route points can carry raw movement, vehicle-speed, and speed-limit fields.

Important point fields:

| Field | Meaning |
| --- | --- |
| `lat`, `lng` | GPS coordinates. |
| `timestamp` | ISO timestamp for the sample. |
| `speed_kmh` | Main speed used by the app, in km/h. |
| `heading` | GPS heading or course. |
| `accuracy` | GPS accuracy radius in meters. |
| `obd_speed_kmh` | Optional OBD-II vehicle speed. |
| `obd_speed_timestamp` | Timestamp for OBD speed. |
| `speed_limit_kmh` | Matched posted/default/inferred speed limit for this point. |
| `speed_limit_source` | `openstreetmap`, `osm_highway_default`, or `inferred`. |
| `speed_limit_default_country` | Country profile used for OSM road-type estimates. |
| `fallback_country` | Preserved fallback profile metadata for reports and backups. |

Completed trips also store `speed_limit_context`, for example:

```js
speed_limit_context: {
  provider: 'openstreetmap_overpass',
  status: 'manual_required',
  coverage: 0,
  source: 'openstreetmap_overpass',
  fallback_country: 'global',
  error: null,
}
```

## Raw Speed Capture

The app stores speed internally as km/h.

Browser and native geolocation provide `coords.speed` in meters per second. Road Sage converts it to km/h in `normalizeLocationPoint`.

```js
export function normalizeLocationPoint(input) {
  const coords = input.coords || input;

  return {
    lat,
    lng,
    speed_kmh: coords.speed != null
      ? Math.max(0, coords.speed * 3.6)
      : input.speed_kmh ?? null,
    heading: coords.heading ?? coords.bearing ?? coords.course ?? input.heading ?? null,
    accuracy: coords.accuracy ?? input.accuracy ?? null,
    timestamp: new Date(timestampMs).toISOString(),
  };
}
```

For live tracking, every point after the first point is rewritten with a calculated reliable speed from the segment between the previous point and the current point.

```js
const segment = calculateSegmentMetrics(previousPoint, point);
const normalizedPoint = previousPoint
  ? {
      ...point,
      speed_kmh: segment.reliableSpeedKmh,
      ...(segment.dt > ROUTE_GAP_SECONDS ? { tracking_gap: true } : {}),
    }
  : { ...point, speed_kmh: point.speed_kmh != null && point.speed_kmh >= 5 ? point.speed_kmh : 0 };
```

This means the main stored speed is not always the phone's reported speed. It can be the movement-derived speed when the GPS speed is missing, zero, or inconsistent with displacement.

## Segment Speed Reliability

`calculateSegmentMetrics` compares:

- reported speed from GPS or OBD,
- implied speed from distance/time,
- GPS accuracy,
- a movement noise floor.

Simplified logic:

```js
const distanceKm = haversineDistance(previousPoint.lat, previousPoint.lng, point.lat, point.lng);
const impliedSpeedKmh = calculateSpeedKmh(distanceKm, dt);
const reportedSpeedKmh = pointSpeedKmh(point, thresholds);

const tinyMovement = distanceM < noiseFloorM;
const displacementSaysStill = impliedSpeedKmh < stationarySpeed && distanceM < noiseFloorM * 1.5;
const isNoise = tinyMovement || reportedDisagreesWithDisplacement;

let reliableSpeedKmh = impliedSpeedKmh;
if (!isNoise && reportedSpeedKmh != null) {
  reliableSpeedKmh = reportedTooLowForMovement || reportedStationaryWhileMoving
    ? impliedSpeedKmh
    : reportedSpeedKmh;
}
```

Current important speed filters:

| Filter | Value |
| --- | ---: |
| Max GPS accuracy | `50 m` |
| Minimum point movement | `8 m` |
| Minimum trusted GPS speed | `18 km/h` |
| Stationary speed | `5 km/h` |
| Max reasonable GPS speed | `220 km/h` |
| Max reasonable OBD speed | `260 km/h` |
| Speed spike delta | `45 km/h` |
| Speed spike ratio | `1.8x` |
| OBD fallback GPS accuracy boundary | `15 m` |
| OBD max sample age | `2500 ms` |

## GPS vs OBD Speed

If OBD-II Bluetooth speed is present, the trip engine can use it instead of GPS speed.

The source choice is:

1. No OBD speed: use GPS if present.
2. Explicit `speed_source: 'obd'` or `vehicle_speed_source: 'obd'`: use OBD.
3. GPS speed missing: use OBD.
4. GPS accuracy good enough, currently `<= 15 m`: use GPS.
5. GPS weak and OBD timestamp is current enough: use OBD.

```js
export function speedSourceForPoint(point, thresholds = DEFAULT_THRESHOLDS) {
  const gpsSpeed = finiteVehicleSpeed(point.speed_kmh);
  const obdSpeed = finiteVehicleSpeed(point.obd_speed_kmh);
  if (obdSpeed == null) return gpsSpeed == null ? null : 'gps';
  if (point.speed_source === 'obd' || point.vehicle_speed_source === 'obd') return 'obd_bluetooth';
  if (gpsSpeed == null) return 'obd_bluetooth';

  if (Number(point.accuracy) <= fallbackAccuracy) return 'gps';

  return obdMs >= gpsMs || Math.abs(gpsMs - obdMs) <= maxAgeMs
    ? 'obd_bluetooth'
    : 'gps';
}
```

Scoring provenance can include `obd_bluetooth` when OBD speed is used.

## What `Get Road Data` Does

`Get Road Data` is a manual action on Map and Trip Detail. It calls `runRoadContextRefresh`, which builds a patch for one selected trip.

The patch can include:

- OpenStreetMap Overpass speed limits,
- Open-Meteo weather,
- optional OSRM route snapping,
- recalculated stats,
- recalculated events,
- recalculated scores.

Manual refresh uses `immediateRequests: true`, so it does not wait for randomized request obfuscation.

```js
export async function runRoadContextRefresh(trip, settings = localSettings.get(), options = {}) {
  const patch = await buildOpenSourceTripContextPatch(trip, settings, {
    ...options,
    immediateRequests: options.immediateRequests !== false,
  });
  return tripService.update(tripId, patch);
}
```

## When `Get Road Data` Is Not Clicked

At trip completion, if automatic external context is not enabled, Road Sage stores this status:

```js
const speedLimitContext = shouldAutoFetchExternalContext
  ? await annotateRouteSpeedLimits(pts, cfg)
  : {
      routePoints: pts,
      coverage: 0,
      status: 'manual_required',
      source: 'openstreetmap_overpass',
      query_count: 0,
      fallback_country: speedLimitDefaultCountryKey(cfg),
      error: null,
    };
```

That means:

- OSM is not contacted.
- No `speed_limit_kmh` values are added to route points.
- The map shows GPS speed bands and event markers only.
- Scoring still runs, but it uses inferred/fallback speed limits.
- Score provenance labels this as `gps_inferred_speed_limit`.

## Automatic Road Data

Automatic road data is off by default. It only becomes active when:

- `external_context_auto_fetch_enabled === true`, and
- `external_context_auto_fetch_consented_at` contains a saved consent timestamp.

The helper is:

```js
export const isExternalContextAutoFetchEnabled = (settings = {}) => (
  settings.external_context_auto_fetch_enabled === true &&
  typeof settings.external_context_auto_fetch_consented_at === 'string' &&
  settings.external_context_auto_fetch_consented_at.trim().length > 0
);
```

When automatic road data is enabled:

- saved trips can fetch OSM speed limits and weather,
- OSRM route snapping still stays manual,
- location requests can go through request obfuscation unless disabled,
- request obfuscation batches real requests after a random delay,
- optional decoys are off by default and only run when `decoy_traffic_mode` is set to `first_party`.

Current request obfuscation timing:

| Timing | Value |
| --- | ---: |
| Batch delay minimum | `3 min` |
| Batch delay maximum | `9 min` |
| Inter-request delay minimum | `800 ms` |
| Inter-request delay maximum | `3500 ms` |
| Optional first-party decoys | `1` to `3`, only when `decoy_traffic_mode` is `first_party` |

## OpenStreetMap Speed-Limit Lookup

OSM speed limits are fetched from Overpass. The lookup sends privacy-filtered bounding boxes or route corridors, not every raw point.

If `speed_limit_lookup_enabled === false`, the lookup is skipped:

```js
export async function loadOsmSpeedLimitWays(routePoints = [], settings = {}) {
  if (settings.speed_limit_lookup_enabled === false) {
    return { ways: [], status: 'disabled', source: 'openstreetmap_overpass' };
  }

  // privacy-safe bounds, cache, Overpass request...
}
```

OSM lookup statuses include:

| Status | Meaning |
| --- | --- |
| `manual_required` | Road data has not been fetched for this trip. |
| `disabled` | Speed-limit lookup is off in Settings. |
| `empty_route` | Not enough usable GPS points. |
| `bbox_too_large` | Route area is too large for one Overpass lookup. |
| `no_tagged_ways` | OSM returned no usable nearby road tags. |
| `unavailable` | Lookup failed or timed out. |
| `partial_fetched` | Some requests worked, but not all. |
| `cache_hit` | Cached OSM road data was reused. |
| `fetched` | OSM road data was fetched. |

## OSM Posted Limits vs OSM Road-Type Estimates

The app separates two OSM-related sources.

| Source | Meaning |
| --- | --- |
| `openstreetmap` | OSM returned a usable `maxspeed` tag. This is the closest thing the app has to a posted speed limit. |
| `osm_highway_default` | OSM returned a road/highway type, but no `maxspeed`. Road Sage used its own country-profile estimate for that road type. |

`osm_highway_default` is not a legal speed limit lookup. It is an approximate app fallback based on OSM road type.

Regional defaults are useful fallback estimates when posted speed data is unavailable, but they are not proof of the posted speed limit. Posted signs, school zones, construction zones, temporary limits, municipal bylaws, and road-specific exceptions can override them.

A `REGION_DEFAULT` result is more reliable than GPS-only inference because it uses country/province/state and road-context information, but it must still be treated as an estimate unless confirmed by posted data.

## Honest UI Wording

Wording guardrail:
The words "posted", "official", "legal limit", "statutory limit", and "you are speeding" may only be used when `tier === 'POSTED'`.
For `MAP_ESTIMATED`, `LEARNED_LOCAL`, `REGION_DEFAULT`, and `GPS_INFERRED`, use "speed check", "estimated", "usually around", "regional estimate", or "check posted signs."

The parser accepts numeric speed-limit strings and converts mph to km/h.

```js
export function parseMaxspeedKmh(value) {
  const raw = String(value).toLowerCase().trim();
  if (!raw || ['none', 'signals', 'walk', 'variable'].includes(raw)) return null;
  const mph = raw.includes('mph');
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  const parsed = Number(match[1]);
  return Math.round(mph ? parsed * 1.60934 : parsed);
}
```

## OSM Road-Type Default Tables

These estimates are used only when OSM gives a road type but no posted `maxspeed`.

Global defaults:

| OSM highway type | Default km/h |
| --- | ---: |
| `living_street` | 20 |
| `service` | 30 |
| `residential` | 40 |
| `unclassified`, `road` | 50 |
| `tertiary`, `tertiary_link` | 50 |
| `secondary`, `secondary_link` | 60 |
| `primary`, `primary_link` | 60 |
| `trunk_link`, `motorway_link` | 80 |
| `trunk`, `motorway` | 100 |

Country overrides:

| Country profile | Overrides |
| --- | --- |
| `ca` | motorway 100, trunk 90, residential 40 |
| `us` | motorway 105, trunk 89, primary 72, residential 40, links 72 or 89 |
| `gb` / `uk` | primary 96, residential/unclassified/road 48, trunk/motorway 112 |
| `de` | motorway null, trunk/primary 100, residential 50 |
| `au` | motorway/trunk 100, primary 80, residential 50 |
| `fr` | motorway 130, trunk 110, primary 80, residential 50 |

The source code notes that these are rough estimates, not official legal references.

## GPS-Inferred Speed Zones

If there is no stored point speed limit, Road Sage infers speed zones from GPS behavior.

It uses rolling windows and the 85th-percentile observed speed:

| P85 observed speed | Inferred zone |
| ---: | ---: |
| `< 30 km/h` | `30 km/h` |
| `< 55 km/h` | `50 km/h` |
| `< 80 km/h` | `70 km/h` |
| `< 110 km/h` | `100 km/h` |
| `>= 110 km/h` | `120 km/h` |

```js
function zoneFromP85(p85Speed) {
  if (p85Speed < 30) return { inferredZone: 'zone_30', inferredZoneKmh: 30 };
  if (p85Speed < 55) return { inferredZone: 'zone_50', inferredZoneKmh: 50 };
  if (p85Speed < 80) return { inferredZone: 'zone_60_70', inferredZoneKmh: 70 };
  if (p85Speed < 110) return { inferredZone: 'zone_80_100', inferredZoneKmh: 100 };
  return { inferredZone: 'zone_highway', inferredZoneKmh: 120 };
}
```

For live warnings and speeding events, the inferred zone is then capped by a road-type fallback limit. The speed-limit compliance score has a separate path, described below, and currently uses `zone.inferredZoneKmh` directly when an inferred zone exists.

## Road-Type Fallback Limits

When no real point limit is available, road type decides the fallback limit.

```js
function complianceFallbackLimit(roadType, thresholds = DEFAULT_THRESHOLDS) {
  if (roadType === 'highway') {
    return thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH;
  }
  if (roadType === 'residential') return 40;
  return 60;
}
```

Current road-type fallback values:

| Road type | Fallback limit |
| --- | ---: |
| `residential` | `40 km/h` |
| `urban` | `60 km/h` |
| `highway` | `threshold_speeding_kmh`, default `100 km/h` |

For effective inferred limits, the app uses the lower of:

- the GPS-inferred speed zone, and
- the road-type fallback.

```js
function contextualFallbackLimitKmh(points, index, zone, thresholds, roadTypes) {
  const roadType = roadTypes?.[index] || 'urban';
  const roadLimit = complianceFallbackLimit(roadType, thresholds);
  if (Number.isFinite(Number(zone?.inferredZoneKmh)) && Number(zone.inferredZoneKmh) > 0) {
    return Math.min(Number(zone.inferredZoneKmh), roadLimit);
  }
  return roadLimit;
}
```

## Effective Speed-Limit Resolution

This is the main decision point used by live warnings and event detection.

```js
export function resolveEffectiveSpeedLimitForIndex(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS, options = {}) {
  const speedLimit = speedLimitForIndex(points, index);
  const actualLimitKmh = speedLimit?.limitKmh ?? null;
  const inferredZone = zoneForIndex(index);
  const fallbackLimitKmh = contextualFallbackLimitKmh(points, index, inferredZone, thresholds, roadTypesByPoint);
  const inferredLimitKmh = Number.isFinite(Number(inferredZone?.inferredLimitKmh))
    ? Number(inferredZone.inferredLimitKmh)
    : Number.isFinite(Number(inferredZone?.inferredZoneKmh))
      ? Math.min(Number(inferredZone.inferredZoneKmh), fallbackLimitKmh)
      : fallbackLimitKmh;

  return {
    actualLimitKmh,
    effectiveLimitKmh: actualLimitKmh ?? inferredLimitKmh,
    fallbackLimitKmh,
    inferredLimitKmh,
    limitSource: speedLimit?.source ?? 'inferred',
  };
}
```

Practical result:

| Situation | Effective source |
| --- | --- |
| OSM `maxspeed` already stored | `openstreetmap` |
| OSM road type default already stored | `osm_highway_default` |
| No road data | `inferred` |
| No inferred zone possible | road-type fallback or configured fallback |

## Speeding Event Detection

Speeding events are created in `detectDrivingEvents`.

The event requires sustained speeding for at least `3 seconds`.

The threshold is:

```js
const contextualSpeedingThreshold = effectiveLimitKmh != null
  ? effectiveLimitKmh + speedOverKmh
  : configuredSpeedThreshold + speedOverKmh;

if (speed2 > contextualSpeedingThreshold) {
  speedingAccumSeconds += dt;
}
```

With defaults, that means:

| Effective limit | Event threshold |
| ---: | ---: |
| 40 km/h | `> 45 km/h` |
| 50 km/h | `> 55 km/h` |
| 60 km/h | `> 65 km/h` |
| 70 km/h | `> 75 km/h` |
| 100 km/h | `> 105 km/h` |

Speeding severity uses how far the peak speed exceeds the effective limit:

```js
const speedingSeverity = (speed, limit = null) => (
  limit != null
    ? speed > limit + 30 ? 'high' : speed > limit + 20 ? 'medium' : 'low'
    : speed > 160 ? 'high' : speed > 140 ? 'medium' : 'low'
);
```

Speeding events store the chosen limit and source:

```js
{
  type: EVENT_TYPES.SPEEDING,
  speed_kmh: Math.round(speedingPeakSpeed),
  speed_limit_kmh: eventLimitKmh,
  speed_limit_source: speedingZone?.limitSource ?? null,
  speed_limit_default_country: speedingZone?.speedLimitDefaultCountry ?? null,
  inferred_zone_kmh: speedingZone?.inferredZoneKmh ?? null,
  zone_confidence: speedingZone?.confidence ?? null,
}
```

## Speed-Limit Compliance Score

`calculateSpeedLimitCompliance` buckets moving points by road type:

- highway,
- urban,
- residential.

For each moving point, it chooses:

1. stored point speed limit,
2. inferred zone limit,
3. road-type fallback limit.

```js
const speedLimit = speedLimitForIndex(points, index);
const limit = speedLimit?.limitKmh
  ?? zone?.inferredZoneKmh
  ?? complianceFallbackLimit(roadType, thresholds);

if (speed > limit + speedOver) bucket.overLimitPoints++;
```

Each bucket records coverage:

- `actual_limit_coverage`,
- `osm_maxspeed_coverage`,
- `osm_highway_default_coverage`,
- `limit_source`.

If the limit source is inferred, the penalty is half-weighted:

```js
const penaltyWeight = limitSource === 'inferred' ? 0.5 : 1;
return {
  score: Math.round(100 - ((100 - rawScore) * penaltyWeight)),
  penalty_weight: penaltyWeight,
  limit_source: limitSource,
};
```

The trip component score adds an explanatory note when inferred limits were used:

```js
const inferredSpeedLimitNote =
  'Speed-limit compliance used inferred road-type limits because no posted OpenStreetMap maxspeed was available; speeding penalties are half-weighted.';
```

## Live Dashboard Speed Warning

During an active trip, `Dashboard.jsx` checks the newest point. It uses the same speed-limit resolver, then speaks if the speed exceeds limit plus margin.

```js
const speedLimitKmh =
  currentInferredLimit
  ?? speedLimitContext.effectiveLimitKmh
  ?? (Number.isFinite(fallbackSpeedLimitKmh) ? fallbackSpeedLimitKmh : 100);

if (
  latestSettings.speed_warning_enabled !== false &&
  latestSettings.voice_alerts_enabled !== false &&
  speed > speedLimitKmh + speedMarginKmh
) {
  speakSafetyAlertOnce(
    'speeding',
    buildVoiceAlertMessage('speeding', {
      speedKmh: speed,
      speedLimitKmh,
      speedLimitSource,
      limitIsEstimated: speedLimitSource === 'inferred',
    }),
    latestSettings,
    60 * 1000
  );
}
```

Current behavior:

- Requires `speed_warning_enabled !== false`.
- Requires `voice_alerts_enabled !== false`.
- Uses a 60-second cooldown for the `'speeding'` voice key.
- Says `estimated` when the source is inferred.

## Live Coach Overlay Speed Warning

`LiveCoachOverlay.jsx` also checks speed during active trips.

It can warn from:

- latest raw/effective speed limit context,
- latest detected speeding event.

```js
if (settings.speed_warning_enabled !== false &&
    latestSpeed > (latestSpeedLimit ?? thresholds.SPEEDING_FALLBACK_KMH ?? 100) +
    (thresholds.SPEED_OVER_KMH ?? 5)) {
  nextMessage = {
    text: `${resolved.tier === 'POSTED' ? 'Speed warning' : 'Speed check'}. ${Math.round(latestSpeed)} km/h...`,
    voiceKey: 'speeding',
    voiceText: buildVoiceAlertMessage('speeding', {
      speedKmh: latestSpeed,
      speedLimitKmh: latestSpeedLimit,
      speedLimitSource: latestSpeedLimitContext.limitSource,
    }),
    voiceCooldownMs: VOICE_COOLDOWNS_MS.speeding,
  };
}
```

The overlay cooldown for `speeding` is also `60000 ms`.

## Voice Alert Message

Speed voice messages are built in `voiceAlertMessages.js`.

The speed alert catalog has two message variants:

```js
speeding: Object.freeze({
  title: 'Speed check',
  messages: Object.freeze([
    (context) => buildSpeedingMessage(context, 'Speed check. Ease off and check posted signs.'),
    (context) => buildSpeedingMessage(context, 'Speed check. Bring your speed down smoothly and check posted signs.'),
  ]),
});
```

If the speed and limit are known, the message includes both:

```js
function buildSpeedingMessage(context, fallback) {
  const speed = formatKmh(context.speedKmh);
  const limit = formatKmh(context.speedLimitKmh);

  if (speed && limit) {
    if (context.speedLimitSource === 'openstreetmap' || context.speedLimitSource === 'user_confirmed_posted_sign') {
      return `Speed warning. You are at ${speed} in a posted ${limit} zone. Ease off smoothly.`;
    }
    return `Speed check. You are at ${speed} in an estimated ${limit} zone. Check posted signs.`;
  }

  return fallback;
}
```

Example spoken messages:

- `Speed warning. You are at 78 kilometers per hour in a posted 60 kilometers per hour zone. Ease off smoothly.`
- `Speed check. You are at 78 kilometers per hour in an estimated 60 kilometers per hour zone. Check posted signs.`
- `Speed check. Ease off and check posted signs.`

## Speech Output

Speech output is handled by `voiceAlerts.js`.

The app tries native speech first on native platforms, then falls back to Web Speech.

```js
export async function speakSafetyAlert(text, settings = localSettings.get(), speechParams = {}) {
  if (!message || !isVoiceAlertEnabled(settings)) return false;

  if (isNativePlatform()) {
    try {
      await NativeSpeech.speakText(payload);
      return true;
    } catch {
      // fall through to Web Speech
    }
  }

  if (!window.speechSynthesis) return false;
  window.speechSynthesis.speak(utterance);
  return true;
}
```

Cooldown is tracked by key:

```js
export async function speakSafetyAlertOnce(key, text, settings, cooldownMs, now = Date.now()) {
  if (!canSpeakSafetyAlert(key, cooldownMs, now)) return false;
  const spoken = await speakSafetyAlert(text, settings);
  if (spoken && key) markSafetyAlertSpoken(key, now);
  return spoken;
}
```

## Native Speeding Notification

Native speeding notifications are separate from voice alerts.

They are controlled by:

- `notifications_enabled`,
- `notif_safety_alerts_enabled`,
- `notif_speeding_alert_enabled`,
- quiet hours.

```js
export async function notifySpeedingAlert(opts = {}, settings = localSettings.get()) {
  if (settings.notifications_enabled === false ||
      settings.notif_safety_alerts_enabled === false ||
      settings.notif_speeding_alert_enabled === false) return null;

  if (now - readNumber(SPEEDING_NOTIF_LAST_KEY) < 60000) return null;

  const limit = Number(opts.limitKmh) || Number(settings.threshold_speeding_kmh) || 100;
  const id = durationS < 60
    ? NOTIFICATION_IDS.SPEEDING_WARNING
    : NOTIFICATION_IDS.SPEEDING_ESCALATION;
}
```

Notification body:

```js
body: `${Math.round(currentSpeed)} km/h - ${Math.max(0, Math.round(currentSpeed - limit))} km/h over the estimated limit.`
```

## Map and Trip Detail Display

Before road data:

- Map uses GPS speed bands and event markers.
- Trip Detail says speed limits have not been fetched.
- Speed compliance may show inferred limits.

After road data:

- Route points can contain `speed_limit_kmh`.
- The speed-limit layer can color by under/over limit.
- Trip Detail summarizes posted OSM, OSM road-type estimate, and inferred coverage.

Trip Detail labels inferred events as:

```text
Inferred limit - may not reflect actual limit; half-weight score penalty
```

For OSM defaults:

```text
OSM road-type estimate (... profile) - not proof of the posted speed limit
```

## Privacy Behavior

Road data lookup avoids sending privacy-zone coordinates.

For OSM speed-limit lookup:

- privacy-zone points are removed,
- bounds that overlap privacy zones are blocked,
- all-private routes return `all_points_private`,
- privacy overlap returns `privacy_bounds_overlap`.

For OSRM:

- privacy-zone interiors are converted into gaps,
- OSRM is skipped if the public route has too few usable points,
- OSRM never adds speed limits,
- OSRM only changes route geometry when configured and manually requested.

## Backup, Export, and Provenance

Speed-limit provenance is preserved in:

- route points,
- driving events,
- `speed_limit_context`,
- component score data sources,
- backups, including local speed-knowledge cells and saved user corrections,
- CSV/PDF/report paths.

Important provenance names:

| Name | Meaning |
| --- | --- |
| `openstreetmap` | Posted OSM `maxspeed` on a matched way. |
| `osm_highway_default` | App estimate from OSM highway type and country profile. |
| `inferred` | App GPS/road-type fallback. |
| `osm_speed_limit` | Component-score data source when any OSM posted/default limit was observed. |
| `gps_inferred_speed_limit` | Component-score data source when scoring used inferred limits. |
| `obd_bluetooth` | Vehicle speed evidence came from OBD. |
| `gps` | GPS speed/route evidence. |

## End-to-End Flow

### Live active trip

1. Location watcher emits a point.
2. `normalizeLocationPoint` converts speed to km/h.
3. `shouldAcceptLocationPoint` filters bad points.
4. `calculateSegmentMetrics` computes reliable segment speed.
5. Active trip stores `speed_kmh`.
6. Live warning resolves current speed limit.
7. If speed is above limit plus margin, voice alert may speak.

### Completed trip without road data

1. Trip ends.
2. Route points are cleaned.
3. Automatic road data is checked.
4. If off, `speed_limit_context.status = 'manual_required'`.
5. Stats are calculated.
6. Events are detected with inferred/fallback limits.
7. Scores are calculated with `gps_inferred_speed_limit`.
8. Inferred speed-limit penalties are half-weighted.

### Completed trip with `Get Road Data`

1. User taps `Get Road Data`.
2. Enabled services run for that selected trip.
3. OSM can add `speed_limit_kmh` and `speed_limit_source`.
4. Weather can adjust weather context.
5. OSRM can snap route geometry if configured and consented.
6. Trip stats, events, and scores are recalculated.
7. Provenance is updated.

## Current Test Coverage

Relevant speed-limit tests cover:

- empty route points,
- single route point,
- deterministic residential speeding,
- compliant highway vs over-limit highway,
- stable doubled samples,
- actual point speed limits,
- OSM highway defaults as a separate source,
- inferred speed-limit provenance,
- half-weight inferred penalties,
- manual required road-data status,
- speed alert message construction.

Useful test files:

- `src/lib/__tests__/speedLimitCompliance.test.js`
- `src/lib/tripEngine.test.js`
- `src/lib/__tests__/openSourceContext.test.js`
- `src/lib/__tests__/voiceAlertMessages.test.js`
- `src/lib/__tests__/voiceAlerts.test.js`
