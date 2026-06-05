# Road Sage Complete Backup Import Reference

Last verified against the repository on June 5, 2026.

This document is the complete developer and user reference for Road Sage full-backup import. It covers the UI flow, supported files, backup schema, encryption, migrations, sanitization, merge behavior, return values, errors, integration snippets, testing, and extension checklist.

## Quick Summary

Road Sage imports full backups through:

```js
import { importDriveSenseBackup } from '@/lib/dataBackup';
```

The normal portable backup format is an encrypted `.rsbackup` file. Legacy `.json` backups are accepted for compatibility.

An import can merge:

- Trips
- Route points
- Driving events
- Event feedback and scoring evidence
- Vehicles and maintenance items
- Safe settings
- Saved Trip History filters
- Privacy-zone metadata without private coordinates

An import does not blindly replace the database. Trips and vehicles are upserted: matching IDs are updated and new IDs are added.

## Source Files

| Responsibility | File |
| --- | --- |
| Main import/export API, schema migrations, sanitizers | `src/lib/dataBackup.js` |
| AES-GCM backup encryption and password validation | `src/lib/backupEncryption.js` |
| Settings allowlist, clamping, and unsafe-key removal | `src/lib/trackingStore.js` |
| Settings page import controller and messages | `src/pages/Settings.jsx` |
| Import file input | `src/settings/sections/PrivacySettings.jsx` |
| Trip persistence/upsert | `src/api/trips.js`, `src/lib/localTripRepository.js` |
| Vehicle persistence/upsert | `src/api/vehicles.js`, `src/lib/localVehicleRepository.js` |
| Saved-filter storage | `src/lib/mobileStorage.js` |
| Backup security tests | `src/lib/__tests__/dataBackupImportSecurity.test.js` |
| Settings import security tests | `src/lib/__tests__/settingsImportSecurity.test.js` |
| Android UI regression | `tests/android-uiautomator-backup-import.mjs` |
| Android instrumentation UI test | `android/app/src/androidTest/java/com/roadsage/app/uitest/tests/T13_SettingsBackupImportTest.kt` |

## User Import Flow

1. Open **Settings**.
2. Open **Privacy & Data**.
3. Select **Import Backup**.
4. Choose a `.rsbackup` or legacy `.json` file.
5. Confirm that the backup should be merged.
6. Enter the backup password when importing an encrypted file.
7. Confirm note truncation if any trip note exceeds 10,000 characters.
8. Wait for the **Import complete** message.
9. Re-add privacy-zone locations if the backup contained coordinate-stripped privacy zones.

The file picker accepts:

```html
accept="application/json,application/octet-stream,.json,.rsbackup"
```

The confirmation explains that matching IDs are updated and new records are added. A legacy `.json` file also displays an unencrypted-data warning.

## Import Pipeline

```text
Selected File
  -> Reject files larger than 50 MiB
  -> Read text and remove an optional UTF-8 BOM
  -> Detect encrypted backup
     -> Request password when missing
     -> PBKDF2 key derivation
     -> AES-256-GCM decryption
  -> Otherwise inspect legacy plaintext HMAC seal
     -> Reject a present but invalid seal
  -> Parse JSON
  -> Validate Road Sage backup identity
  -> Migrate schema one version at a time to v6
  -> Sanitize trips, vehicles, nested values, and settings
  -> Request confirmation if trip notes will be truncated
  -> Protect old trips from retention deletion
  -> Upsert trips
  -> Upsert vehicles
  -> Apply safe settings
  -> Restore sanitized saved filters
  -> Refresh UI queries and show the result
```

## Basic Import Snippet

```js
import { importDriveSenseBackup } from '@/lib/dataBackup';

export async function importBackupFile(file, password) {
  const result = await importDriveSenseBackup(file, {
    password,
    includeSettings: true,
    acknowledgeTruncation: false,
  });

  if (result.error === 'password_required') {
    return { needsPassword: true };
  }

  if (result.error === 'wrong_password') {
    throw new Error('Wrong backup password.');
  }

  if (result.error === 'integrity_check_failed') {
    throw new Error('The legacy backup integrity check failed.');
  }

  if (result.requiresAcknowledgement) {
    return {
      needsTruncationConfirmation: true,
      affectedTrips: result.truncatedNoteTripCount,
      warnings: result.warnings,
    };
  }

  return result;
}
```

## Complete Import Controller Snippet

This example handles passwords, truncation acknowledgement, and all normal result states:

```js
import {
  BACKUP_INTEGRITY_ERROR,
  BACKUP_TOO_LARGE_MESSAGE,
  importDriveSenseBackup,
  MAX_BACKUP_BYTES,
} from '@/lib/dataBackup';

export async function runBackupImport({
  file,
  password = null,
  confirmTruncation = async () => false,
}) {
  if (!file) throw new Error('Choose a backup file.');
  if (Number(file.size) > MAX_BACKUP_BYTES) {
    throw new Error(BACKUP_TOO_LARGE_MESSAGE);
  }

  let result = await importDriveSenseBackup(file, {
    password,
    includeSettings: true,
  });

  if (result?.error === 'password_required') {
    return { status: 'password_required' };
  }

  if (result?.error === 'wrong_password') {
    return { status: 'wrong_password' };
  }

  if (result?.error === BACKUP_INTEGRITY_ERROR) {
    return { status: 'integrity_check_failed' };
  }

  if (result?.requiresAcknowledgement) {
    const approved = await confirmTruncation({
      tripCount: result.truncatedNoteTripCount,
      warnings: result.warnings,
    });

    if (!approved) return { status: 'cancelled' };

    result = await importDriveSenseBackup(file, {
      password,
      includeSettings: true,
      acknowledgeTruncation: true,
    });
  }

  return {
    status: 'complete',
    ...result,
  };
}
```

## React File Input Snippet

```jsx
import { useRef, useState } from 'react';
import { importDriveSenseBackup } from '@/lib/dataBackup';

export function BackupImporter() {
  const inputRef = useRef(null);
  const [message, setMessage] = useState('');

  async function onFileSelected(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const result = await importDriveSenseBackup(file);

      if (result.error === 'password_required') {
        setMessage('Ask the user for the backup password, then retry.');
        return;
      }

      if (result.requiresAcknowledgement) {
        setMessage(
          `${result.truncatedNoteTripCount} trip notes require truncation confirmation.`
        );
        return;
      }

      setMessage(
        `Imported ${result.trips} trips and ${result.vehicles} vehicles.`
      );
    } catch (error) {
      setMessage(error.message || 'Could not import backup.');
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,application/octet-stream,.json,.rsbackup"
        onChange={onFileSelected}
      />
      <p>{message}</p>
    </>
  );
}
```

## Function Signature

```ts
importDriveSenseBackup(
  file: {
    size: number;
    name?: string;
    text(): Promise<string>;
  },
  options?: {
    includeSettings?: boolean;
    acknowledgeTruncation?: boolean;
    password?: string | null;
  }
): Promise<ImportResult>
```

Option behavior:

| Option | Default | Meaning |
| --- | --- | --- |
| `includeSettings` | `true` | Import sanitized settings and allow retention protection to set auto-delete to Never. |
| `acknowledgeTruncation` | `false` | Permit import after the caller has disclosed oversized note truncation. |
| `password` | `null` | Password for encrypted `.rsbackup` content. |

## Successful Result

```ts
type SuccessfulImportResult = {
  trips: number;
  vehicles: number;
  settings: boolean;
  savedFilters: number;
  savedFiltersRestored: boolean;
  warnings: string[];
  truncatedFields: number;
  truncatedNoteTripCount: number;
  privacy_zones_need_reconfiguration: number;
  retentionAutoDeleteDisabled: boolean;
  retentionPreservedTripCount: number;
};
```

Example:

```json
{
  "trips": 42,
  "vehicles": 2,
  "settings": true,
  "savedFilters": 3,
  "savedFiltersRestored": true,
  "warnings": [],
  "truncatedFields": 0,
  "truncatedNoteTripCount": 0,
  "privacy_zones_need_reconfiguration": 1,
  "retentionAutoDeleteDisabled": false,
  "retentionPreservedTripCount": 0
}
```

## Non-Success Result States

Password required:

```json
{ "error": "password_required" }
```

Wrong password:

```json
{ "error": "wrong_password" }
```

Legacy plaintext integrity failure:

```json
{ "error": "integrity_check_failed" }
```

Truncation acknowledgement required:

```json
{
  "requiresAcknowledgement": true,
  "truncatedNoteTripCount": 2,
  "warnings": [
    "Imported notes text exceeded 10,000 characters and was truncated."
  ],
  "truncatedFields": 1
}
```

Validation and parsing problems throw JavaScript errors instead of returning an `error` field.

## Supported Backup Shape

Current backup schema version:

```js
export const BACKUP_VERSION = 6;
```

Top-level shape:

```json
{
  "app": "Road Sage",
  "version": 6,
  "exported_at": "2026-06-05T12:00:00.000Z",
  "settings": {},
  "ui": {
    "saved_trip_filters": []
  },
  "vehicles": [],
  "trips": []
}
```

For legacy compatibility, `app` may be either:

- `Road Sage`
- `DriveSense`

The `trips` property is mandatory and must be an array. Missing `vehicles`, `settings`, or `ui` data is repaired by migrations or treated as empty.

## Backup Schema History

| Version | Change |
| --- | --- |
| v1 | Base trips, vehicles, and settings export. A versionless backup is treated as v1. |
| v2 | Added `ui.saved_trip_filters` and ensured a vehicles array exists. |
| v3 | Added trip `route_points`, `driving_events`, and `event_feedback` defaults. |
| v4 | Marks non-discarded older trips with `needs_rescore: true`. |
| v5 | Added hardened import fallback containers and privacy-safe zone metadata behavior. |
| v6 | Renamed legacy `lane_change` events to diagnostic-only `heading_deviation_legacy` records. |

Migration always advances one version at a time through `BACKUP_MIGRATIONS`.

A backup newer than v6 is rejected with an instruction to update Road Sage.

## Encrypted `.rsbackup` Format

All current full-backup exports are encrypted.

Encryption properties:

| Property | Value |
| --- | --- |
| Encryption version | `1` |
| Cipher | AES-GCM |
| Key size | 256 bits |
| Password KDF | PBKDF2-HMAC-SHA-256 |
| PBKDF2 iterations | 600,000 |
| Salt | 32 random bytes |
| IV | 12 random bytes |
| Authentication tag | AES-GCM tag, included in ciphertext |
| Storage encoding | Base64 text |
| MIME type | `application/octet-stream` |
| File extension | `.rsbackup` |

Binary data before Base64 encoding:

```text
[1-byte version][32-byte salt][12-byte IV][ciphertext + GCM tag]
```

Export passwords must be 12-128 characters and must use either:

- Uppercase, lowercase, a number, and a symbol
- A passphrase of at least three words and 20 characters

Import accepts any legacy password between 12 and 128 characters, even when it does not satisfy current export-strength rules.

Passwords are transient UI state and are not stored in settings.

## Legacy Plaintext JSON

Legacy `.json` backups are import-only compatibility inputs. They are not produced by the current export flow.

Current source behavior:

- Plain JSON without `_integrity` is accepted.
- Plain JSON with a valid `_integrity` HMAC is accepted and the integrity field is removed before parsing content.
- Plain JSON with a present but invalid `_integrity` HMAC is rejected.
- The HMAC key material is tied to the Road Sage installation through `getOrCreateInstallHash()`.
- A sealed legacy file from another installation may fail verification.

This means an absent seal is currently treated as an old unsealed backup, while a supplied seal must be valid.

## Import Limits

| Limit | Value |
| --- | --- |
| Maximum file size | 50 MiB (`50 * 1024 * 1024`) |
| Route points per trip | 5,000 |
| Driving events per trip | 500 |
| General imported string length | 5,000 characters |
| Trip notes | 10,000 characters |
| Generic nested array items | 500 |
| Generic nested object keys | 100 |
| Generic nested object depth | 3 |
| Saved filters | 8 |
| Vehicle maintenance items | 12 |
| Privacy zones | 20 |

Selected field-specific string limits:

| Field | Limit |
| --- | --- |
| IDs | 120 |
| Vehicle/trip names and nicknames | 200 |
| Make/model | 120 |
| Plate | 40 |
| Color | 32 |
| Tag | 100 |
| Event message | 500 |
| Label | 200 |

## Trip Sanitization

Every trip must be a plain object with a non-empty string `id`. Invalid records throw an error.

Only fields listed in `IMPORTED_TRIP_FIELDS` are retained. The allowlist covers:

- Identity, status, timestamps, tags, nickname, notes, favorite state, and split-trip metadata
- Route points and route metadata
- Driving events and reviewed event feedback
- Duration, distance, speed, idle, road-type, and data-quality values
- Overall, Safety, Smoothness, Eco, UBI, and component scores
- Score confidence, provenance, explanations, and rescore state
- Braking, acceleration, cornering, speeding, heading, following-distance, stop, distraction, near-miss, overtake, intersection, phone-use, fatigue, weather, hill, parking, reaction, tire-wear, fuel, CO2, and map-matching evidence
- Native tracking and phone-usage evidence

Important behavior:

- Imported `active` or unknown statuses become `completed`.
- Only `completed` and `discarded` statuses survive unchanged.
- Unknown top-level fields are removed.
- Route points and driving events use their own field allowlists.
- Dangerous object keys `__proto__`, `constructor`, and `prototype` are removed.
- Non-plain objects are rejected or omitted.
- Long strings and oversized arrays are truncated.
- Trip notes longer than 10,000 characters require explicit user acknowledgement before persistence.

## Route-Point Sanitization

Supported route-point fields include:

```text
lat, lng, timestamp, time, speed, speed_kmh, accuracy, heading,
altitude, accel_ms2, acceleration_ms2, distance_m, delta_seconds,
road_type, speed_limit, speed_limit_kmh, speed_limit_source,
speed_limit_default_country, fallback_country, privacy_masked,
privacy_boundary, original_lat, original_lng, source
```

Any other route-point field is discarded.

## Driving-Event Sanitization

Supported driving-event fields include:

```text
id, type, severity, timestamp, time, lat, lng, value, speed_kmh,
durationS, duration_seconds, distance_m, confidence, source, inferred,
speed_limit, speed_limit_kmh, speed_limit_source,
speed_limit_default_country, fallback_country, start_time, end_time,
start_index, end_index, road_type, message, label, legacy_renamed
```

Any other event field is discarded.

## Vehicle Sanitization

Supported vehicle fields include:

```text
id, name, make, model, year, color, plate, odometer_km,
odometer_trip_distance_anchor_km, auto_odometer_last_sync_at,
fuel_type, fuel_efficiency_l_per_100km,
ev_efficiency_kwh_per_100km, fuel_price_per_liter,
maintenance_reserve_per_km, registration_renewal_date,
insurance_renewal_date, maintenance_items, is_default,
created_date, created_at, updated_at
```

Rules:

- A vehicle without a usable name is dropped.
- A missing vehicle ID is replaced with a generated import ID.
- Unknown fields are removed.
- At most 12 maintenance items are retained.
- Maintenance items retain only `id`, `label`, `interval_km`, and `last_service_km`.
- A maintenance item without a usable ID is dropped.

## Settings Sanitization

Settings import is allowlist-based. Only keys already present in `DEFAULT_SETTINGS` can be imported.

General rules:

- Unknown keys are removed.
- `__proto__`, `constructor`, and prototype-pollution payloads do not survive.
- Booleans must be booleans.
- Numbers must be finite and are clamped to per-setting ranges.
- Enums must match supported values.
- Strings are limited to 500 characters.
- `last_map_center` must contain valid coordinates.
- Privacy zones are sanitized and capped at 20.
- Legacy setting aliases are migrated.
- Unsafe device-specific values are removed.

The following settings are always stripped:

```text
_settings_revision
_settings_updated_at
settings_defaults_version
osrm_map_matching_url
osrm_public_demo_consent_at
osrm_data_sharing_consented
osrm_data_sharing_consented_at
osrm_health_status
osrm_last_health_checked_at
osrm_last_reachable_at
osrm_last_health_error
osrm_verified_endpoint
osrm_verified_origin
osrm_verified_domain
osrm_trust_verified_at
```

Security-specific behavior:

- `tracking_mode: "background_auto"` is not importable. Only `manual` and `auto_detect` are allowed.
- A backup cannot redirect route data to an imported OSRM endpoint.
- A backup cannot restore OSRM consent, trust, health, or verification state.
- If local-only mode is active on the device, import cannot turn it off.
- If the backup enables local-only mode, dependent external-network features are disabled.
- Numeric scoring thresholds are clamped to safe ranges.

## Privacy Zones

Backup export intentionally removes privacy-zone latitude and longitude.

Exported privacy-zone example:

```json
{
  "id": "home",
  "label": "Home",
  "radius_m": 200,
  "masked_for_privacy": true,
  "_coordinate_stripped": true
}
```

Import preserves this metadata but reports the number of zones that need reconfiguration:

```js
result.privacy_zones_need_reconfiguration
```

The user must re-add the private coordinates after import.

Trip route points and driving events are privacy-masked during export before they reach the backup payload.

## Saved Filters

The import restores up to eight saved Trip History filters.

Each filter contains:

```ts
{
  id: string;
  name: string;
  search: string;
  sortBy: string;
  filterBy: string;
  selectedTag: string;
}
```

A filter without a non-empty name is discarded. String values are limited to 120 characters.

Saved-filter storage failure does not roll back imported trips or vehicles. The result reports:

```js
{
  savedFilters: 3,
  savedFiltersRestored: false
}
```

## Merge and Persistence Behavior

Trips are written through:

```js
tripService.upsertMany(backup.trips, {
  skipRetentionPrune: true,
  skipRescore: true,
});
```

Vehicles are written through:

```js
vehicleService.upsertMany(backup.vehicles);
```

Consequences:

- Matching record IDs are updated.
- New IDs are added.
- Existing unrelated records remain.
- Import is not an all-or-nothing database transaction across trips, vehicles, settings, and filters.
- Trip retention pruning is skipped during the import write.
- Automatic rescoring is skipped during the import write.
- Older migrated backups can mark trips with `needs_rescore`.

## Retention Protection

Before persistence, Road Sage checks whether completed imported trips fall outside the effective retention window.

When old trips would be hidden or deleted and `includeSettings` is enabled:

- `data_retention_months` is set to `0`.
- `0` means **Never** auto-delete.
- Trips are imported with retention pruning disabled.
- The completion message explains how many older trips were preserved.

The result fields are:

```js
{
  retentionAutoDeleteDisabled: true,
  retentionPreservedTripCount: 12
}
```

When `includeSettings` is `false`, this automatic settings adjustment is not applied.

## Errors and Caller Handling

| Condition | Behavior |
| --- | --- |
| File larger than 50 MiB | Throws `BACKUP_TOO_LARGE_MESSAGE` before calling `file.text()`. |
| Missing password | Returns `{ error: "password_required" }`. |
| Wrong AES-GCM password | Returns `{ error: "wrong_password" }`. |
| Invalid legacy HMAC | Returns `{ error: "integrity_check_failed" }`. |
| Invalid JSON | Throws `Backup file is not valid JSON...`. |
| Wrong app identity or missing trips array | Throws `This is not a valid Road Sage backup file.` |
| Backup version newer than supported | Throws an update-required version error. |
| Missing trip ID | Throws `Backup contains a trip without a valid id.` |
| Invalid encrypted format/version | Throws an encryption-version or incomplete-file error. |
| Oversized notes without acknowledgement | Returns `requiresAcknowledgement: true`. |
| Saved-filter write failure | Import continues and reports `savedFiltersRestored: false`. |

## Parse-Only Snippet

Use this only after obtaining plaintext JSON. It does not decrypt files or write records:

```js
import { parseDriveSenseBackup } from '@/lib/dataBackup';

const parsed = parseDriveSenseBackup(jsonText);

console.log({
  sourceVersion: parsed.sourceVersion,
  currentVersion: parsed.version,
  trips: parsed.trips.length,
  vehicles: parsed.vehicles.length,
  warnings: parsed.warnings,
});
```

`parseDriveSenseBackup()` validates, migrates, and sanitizes the payload.

## Migration-Only Snippet

```js
import { BACKUP_VERSION, migrateBackup } from '@/lib/dataBackup';

const migrated = migrateBackup(oldBackup, oldBackup.version || 1);

console.log(migrated.version === BACKUP_VERSION);
```

This function does not sanitize or persist records.

## Build-a-Backup Snippet

```js
import { buildDriveSenseBackup } from '@/lib/dataBackup';

const payload = buildDriveSenseBackup({
  trips,
  vehicles,
  settings,
  savedFilters,
});

const json = JSON.stringify(payload, null, 2);
```

This builds the plaintext payload in memory. Use `exportDriveSenseBackup()` for the supported encrypted export/download path.

## Encrypted Export Snippet

```js
import { exportDriveSenseBackup } from '@/lib/dataBackup';

const result = await exportDriveSenseBackup({
  trips,
  vehicles,
  settings,
  filename: 'road-sage-full-backup.json',
  password: 'A-Strong-Backup-Password-2026!',
});

console.log(result.filename); // road-sage-full-backup.rsbackup
```

The filename is normalized to `.rsbackup`, and the export is always encrypted.

## Testing

Run the focused security tests:

```powershell
npm.cmd test -- src/lib/__tests__/dataBackupImportSecurity.test.js
npm.cmd test -- src/lib/__tests__/settingsImportSecurity.test.js
```

Run both together:

```powershell
npm.cmd test -- src/lib/__tests__/dataBackupImportSecurity.test.js src/lib/__tests__/settingsImportSecurity.test.js
```

Run the Android WebView/UIAutomator backup import regression on a connected device:

```powershell
node tests/android-uiautomator-backup-import.mjs
```

Run the Android instrumentation test:

```powershell
.\android\gradlew.bat -p android connectedDebugAndroidTest
```

Existing tests cover:

- Maximum file size rejection before reading
- UTF-8 BOM handling
- Old-trip retention protection
- Trip, route, event, vehicle, and nested-field sanitization
- Prototype-pollution protection
- Privacy-zone coordinate stripping
- Note truncation disclosure
- Password-required and wrong-password behavior
- Plaintext HMAC sealing and tamper rejection
- v1-v6 migrations
- Newer-version rejection
- OSRM endpoint and consent stripping
- Threshold clamping
- Background-auto tracking rejection
- Local-only mode preservation

## Adding a New Backup Field

For a new trip field:

1. Add the field to the canonical trip schema when applicable.
2. Add it to `IMPORTED_TRIP_FIELDS`.
3. Add nested subfields to the correct nested allowlist.
4. Decide its string, array, depth, and numeric constraints.
5. Add export/import round-trip tests.
6. Add migration logic if old backups need a transformed default.
7. Increase `BACKUP_VERSION` only when the persisted backup contract changes.
8. Add a one-step migration to `BACKUP_MIGRATIONS`.
9. Update this document and generated app-state documentation.

For a new setting:

1. Add it to `DEFAULT_SETTINGS`.
2. Add enum or numeric-range validation when needed.
3. Decide whether it is safe and portable.
4. Add it to `IMPORT_STRIPPED_KEYS` when it represents device consent, credentials, endpoint trust, runtime state, or non-portable metadata.
5. Add a settings import security test.
6. Verify local-only mode and permission state cannot be bypassed.

## Security Review Checklist

- [ ] File size is checked before reading.
- [ ] Encrypted backups require a valid password.
- [ ] New record fields are explicitly allowlisted.
- [ ] Nested objects have bounded depth, key count, and array count.
- [ ] Dangerous object keys are removed.
- [ ] Strings and notes have explicit limits.
- [ ] Imported settings cannot restore device consent or external endpoint trust.
- [ ] Background tracking cannot be silently enabled.
- [ ] Local-only mode cannot be silently disabled.
- [ ] Privacy-zone coordinates remain excluded from portable backups.
- [ ] Newer unsupported backup versions fail clearly.
- [ ] Schema changes have one-step migrations and regression tests.
- [ ] User-visible truncation requires acknowledgement.
- [ ] Imported old trips are not immediately removed by retention.

## Important Design Notes

- Import is a trust boundary. Never pass raw backup objects directly to repositories.
- Sanitization happens after schema migration so all supported legacy shapes enter the current sanitizer.
- Encryption protects confidentiality and integrity for current `.rsbackup` files.
- Legacy HMAC sealing provides integrity only, not confidentiality.
- Current legacy compatibility accepts plaintext JSON without a seal. Do not describe all accepted plaintext files as authenticated.
- Privacy zones are intentionally portable only as labels/radii, not exact places.
- OSRM consent and endpoint verification are intentionally device-local and must be re-established after import.
- Passwords must never be persisted in settings, logs, analytics, or backup metadata.
- A future change that requires rejecting all unsealed plaintext backups would be a compatibility and product-policy change, not a documentation-only change.
