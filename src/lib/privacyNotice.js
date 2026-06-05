export const PRIVACY_NOTICE_LAST_UPDATED = '2026-06-02';

export const PRIVACY_NOTICE_SUMMARY =
  'Road Sage is local-first: trip history, GPS routes, scores, vehicles, settings, privacy zones, calibration labels, and parked-location records stay on this device unless you export them, import/share a backup, enable a configured backend, or explicitly use an external road, map, weather, or route-matching service.';

export const PRIVACY_NOTICE_HIGHLIGHTS = [
  {
    title: 'Local by default',
    body: 'Road Sage stores trip, route, score, event, vehicle, settings, calibration, active-trip recovery, and parked-location data locally. On Android, sensitive preferences and trip fields use encrypted storage backed by the Android Keystore where available. In a browser, storage is limited by the browser security model.',
  },
  {
    title: 'What can leave this device',
    body: 'Data can leave the device when you export a file, import/share a backup, use an optional backend build, upload anonymized calibration labels, request external road/weather/map context, view map tiles, or save a verified trusted OSRM endpoint and tap Get Road Data.',
  },
  {
    title: 'External service disclosures',
    body: 'OpenStreetMap tile hosts can receive map tile requests for visible map areas. If road/weather context is enabled, Nominatim and Overpass requests are skipped for privacy-zone-protected coordinates where the app can do so, and Open-Meteo receives a privacy-safe route point/date for weather context. A verified trusted OSRM HTTPS domain receives sampled GPS coordinate pairs only after explicit consent, and privacy-zone gaps are excluded.',
  },
  {
    title: 'What privacy zones mask',
    body: 'Privacy zones clip visible routes to the zone edge, hide events inside the zone guard, suppress private parked-location storage, and remove privacy-zone centers from backups. They do not undo data already shared, exported, screenshotted, downloaded, or stored outside Road Sage.',
  },
  {
    title: 'Deletion limits',
    body: 'Delete and wipe actions remove app records and perform best-effort overwrites for sensitive local artifacts. Operating systems, browsers, flash storage, sync tools, downloads, prior backups, diagnostics outside the app, and external services can retain copies beyond Road Sage control.',
  },
];

export const PRIVACY_CONSENT_POINTS = [
  'Location access is requested when you start tracking, use current location, add privacy zones from location, or enable auto tracking.',
  'Background location and activity recognition are separate Android permissions used for native auto tracking.',
  'Usage Access, Bluetooth, OBD-II, notifications, calibration sharing, external road context, and OSRM route snapping are optional feature-specific choices.',
  'Encrypted exports and backups are protected by the password you choose. Road Sage cannot recover a forgotten password.',
  'External endpoints and exported files are your responsibility once you choose to send, save, or share them.',
];

export const PRIVACY_NOTICE_TOAST_DESCRIPTION = [
  PRIVACY_NOTICE_SUMMARY,
  'Privacy zones mask maps, exports, and backups, but cannot erase data already shared, exported, downloaded, or retained by OS/browser storage or external services.',
].join(' ');
