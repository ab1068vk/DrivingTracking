# Road Sage Privacy Notice

Last updated: 2026-06-04

Road Sage is local-first. Trip history, GPS routes, scores, events, vehicles, settings, privacy zones, calibration labels, app-lock preferences, active-trip recovery, and parked-location records stay on this device unless you choose to export them, import/share a backup, enable a configured backend, upload calibration labels, or use an external road, map, weather, route-matching, or widget map service.

## What Stays Local

- Trips, route points, driving events, score evidence, vehicles, settings, privacy zones, calibration labels, active-trip recovery, app-lock preferences, stealth-trip state, and parked-location records are stored locally by default.
- On Android, sensitive preferences and trip fields use encrypted storage backed by the Android Keystore where available.
- Stealth trip mode avoids keeping private route/event history after the trip ends.
- In browser builds, local storage is limited by the browser security model and should not be treated as equivalent to hardware-backed Android storage.

## What Can Leave The Device

Data can leave the device when you:

- export a CSV, PDF, or full backup;
- import, save, copy, send, or share a backup file;
- use a build configured with a backend API;
- enable anonymized calibration label sharing;
- request external road, map, weather, or route-matching context;
- view online map tiles;
- allow the parked-car widget to fetch an online static map preview outside privacy zones;
- save a verified trusted OSRM endpoint and tap **Get Road Data**.

## External Services

- OpenStreetMap tile hosts can receive map tile requests for visible map areas.
- The Android parked-car widget can fetch online static map tiles for the saved parked location when it is outside privacy zones.
- Nominatim reverse-geocoding and Overpass road-data requests are skipped for privacy-zone-protected coordinates where Road Sage can do so.
- Open-Meteo receives a privacy-safe route point and date for weather context.
- A verified trusted OSRM HTTPS domain receives sampled GPS coordinate pairs only after explicit consent. Privacy-zone gaps are excluded from OSRM requests.
- External services can process, log, or retain requests according to their own policies. Road Sage cannot erase data after it has been sent to those services.

## Privacy Zones

Privacy zones clip visible routes to the zone edge, hide events inside the zone guard, suppress private parked-location storage, suppress protected widget map previews, skip eligible reverse-geocoding and road-data lookups, and remove privacy-zone center coordinates from backups.

Privacy zones do not undo data already shared, exported, downloaded, screenshotted, backed up, or stored outside Road Sage.

## Exports And Backups

- Full backups use the encrypted `.rsbackup` format and the password you choose. Road Sage also imports supported legacy JSON backups for migration.
- Road Sage cannot recover a forgotten export or backup password.
- Backups remove privacy-zone center coordinates and mask protected route/event data, but they still contain sensitive trip history.
- Report/export files and downloaded files shared outside the app are outside Road Sage deletion controls.

## Deletion Limits

Delete and wipe actions remove app records and perform best-effort cleanup for sensitive local artifacts. Operating systems, browsers, flash storage, sync tools, downloads, prior backups, screenshots, diagnostics outside the app, and external services can retain copies beyond Road Sage control.

## Consent Checkpoints

- Location access is requested when you start tracking, use current location, add privacy zones from location, or enable auto tracking.
- Background location and activity recognition are separate Android permissions used for native auto tracking.
- Usage Access, Bluetooth, OBD-II, notifications, calibration sharing, app lock/biometric unlock, stealth mode, external road context, and OSRM route snapping are optional feature-specific choices.
- External endpoints and exported files are your responsibility once you choose to send, save, or share them.
