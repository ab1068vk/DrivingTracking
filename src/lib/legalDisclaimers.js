export const LEGAL_DISCLAIMER_SHORT =
  'Personal-use estimates only. Not legal, insurance, navigation, emergency, maintenance, medical, tax, employment, fleet, or safety-critical advice.';

export const LEGAL_DISCLAIMER_SUMMARY =
  `${LEGAL_DISCLAIMER_SHORT} Road Sage estimates driving patterns from device sensors, GPS, maps, weather, route, vehicle, cost, emissions, and optional third-party data that can be incomplete, delayed, unavailable, or wrong. You remain responsible for safe driving, posted signs, traffic laws, road conditions, vehicle condition, permissions, data sharing, exports, backups, and any decision made from app outputs.`;

export const LEGAL_NOTICE_ACK_VERSION = 3;

export const LEGAL_NOTICE_INTRO =
  'Road Sage is a local-first driving log and coaching app. Read this before using tracking, background auto tracking, scores, maps, alerts, exports, backups, privacy zones, external road data, vehicle features, or survey tools.';

export const LEGAL_NOTICE_KEY_POINTS = [
  'Do not use the app while driving.',
  'Scores, alerts, maps, speed limits, costs, fatigue signals, phone-use signals, possible incident signals, and vehicle-health outputs are estimates and may be wrong.',
  'Road Sage is not legal, insurance, emergency, navigation, medical, tax, employment, fleet, maintenance, or safety-critical advice.',
  'If Background Auto is enabled, Road Sage may collect location and activity signals while the app is closed or not in use to detect and save trips.',
  'Your data stays local by default. Optional road, weather, and route-matching features may share limited route or location data with outside services only when you enable those features.',
  'You are responsible for safe driving, traffic laws, posted signs, road conditions, your vehicle, your permissions, your exports, and any decisions made from app information.',
];

export const LEGAL_DATA_PRACTICES = [
  {
    title: 'Location and routes',
    access: 'GPS location, route points, speed, heading, distance, parking context, and privacy-zone masking metadata.',
    use: 'Used for trip logging, maps, speed estimates, driving-event detection, privacy zones, parked-car context, and reports.',
    sharing: 'Stored locally by default. OpenStreetMap, Open-Meteo, and OSRM are contacted only through enabled road-data features.',
  },
  {
    title: 'Background tracking',
    access: 'Background location, Android activity recognition, foreground service notifications, and native trip state when enabled.',
    use: 'Used to detect and save trips automatically while the app is closed, asleep, or not on screen.',
    sharing: 'Not sold. Stored locally unless you export, back up, import, or enable optional external road-data requests.',
  },
  {
    title: 'Sensors, phone use, and vehicle data',
    access: 'Motion sensor samples, Android Usage Access summaries, Bluetooth/OBD readings, notification state, and device capability checks when enabled.',
    use: 'Used for driving-quality estimates, phone-use evidence, possible incident signals, OBD vehicle context, diagnostics, and readiness checks.',
    sharing: 'Local by default. Bluetooth pairing and OS permissions are controlled by Android and the connected adapter/device.',
  },
  {
    title: 'Reports, backups, logs, and surveys',
    access: 'Trips, events, scores, settings, vehicles, calibration survey labels, system logs, exports, and backup files.',
    use: 'Used for local history, PDFs/CSVs, encrypted or readable backups, troubleshooting, calibration notes, and privacy audits.',
    sharing: 'Exported or backup files can reveal sensitive data to anyone who receives or can open them. Passwords for encrypted backups cannot be recovered by the app.',
  },
];

export const LEGAL_DISCLAIMER_ITEMS = [
  {
    group: 'Safety & responsibility',
    title: 'Personal use, not professional advice',
    body: 'Road Sage is for personal trip logging and coaching. It is not legal, insurance, underwriting, employment, compliance, fleet, tax, medical, emergency, navigation, repair, maintenance, or safety-critical advice.',
  },
  {
    group: 'Safety & responsibility',
    title: 'Drive safely first',
    body: 'Do not interact with the app while driving. Always obey posted signs, traffic laws, police direction, road conditions, vehicle limits, and your own judgment before any app alert, score, recommendation, map, or route context.',
  },
  {
    group: 'Safety & responsibility',
    title: 'Background tracking requires consent',
    body: 'If you choose Background Auto, Road Sage can use location and activity signals while the app is closed or not in use so it can detect and save trips. You can turn off Background Auto, pause tracking, disable notifications, or revoke permissions at any time.',
  },
  {
    group: 'Accuracy limits',
    title: 'Scores and detections are estimates',
    body: 'Safety, smoothness, eco, UBI-style, fatigue, focus, phone-use, possible incident, speed, braking, acceleration, cornering, heading, overtake, route-risk, historical-context, maintenance, tire, fuel, EV, emissions, and cost outputs are estimates and can be inaccurate, incomplete, delayed, or unavailable.',
  },
  {
    group: 'Accuracy limits',
    title: 'Maps are not navigation',
    body: 'Maps, parked-car location, speed limits, road data, weather, route matching, route risk, and privacy-zone masking are informational only. They may not reflect current closures, hazards, legal restrictions, private property, signs, or actual road conditions.',
  },
  {
    group: 'Records, exports & decisions',
    title: 'Not official records',
    body: 'Reports, backups, exports, maps, GPS traces, event labels, score cards, charts, and summaries are not insurer-validated ratings, official records, legal evidence, proof of work, proof of tax treatment, proof of compliance, or proof of fault.',
  },
  {
    group: 'Records, exports & decisions',
    title: 'Vehicles and costs',
    body: 'Maintenance, tire wear, fuel, EV, emissions, savings, and vehicle health estimates are not diagnostics, financial advice, environmental certification, or repair instructions. Inspect your vehicle, follow the manufacturer schedule, and use a qualified professional for repairs, safety concerns, or compliance decisions.',
  },
  {
    group: 'Privacy & data',
    title: 'Local data and privacy',
    body: 'Trip, GPS, route, score, vehicle, settings, survey label, backup, export, notification, system log, permission, and diagnostic data are stored locally by default. Anyone with device access, exported files, readable backups, imported data, or screen access may be able to view sensitive trip or location details.',
  },
  {
    group: 'Privacy & data',
    title: 'Optional external requests',
    body: 'Optional road, weather, and route-matching features can send limited route-area boxes to OpenStreetMap, a privacy-safe route point and date to Open-Meteo, or sampled GPS coordinate pairs to the OSRM endpoint you configure and explicitly approve. Public or third-party services have their own availability, logging, privacy, and retention practices.',
  },
  {
    group: 'Privacy & data',
    title: 'Survey labels are local',
    body: 'Post-trip survey answers stay on this device in this local-only app. They do not upload anywhere, automatically change scores, or automatically tune thresholds. They are used as local calibration notes, backup data, and System Log events.',
  },
  {
    group: 'Privacy & data',
    title: 'Permissions and background tracking',
    body: 'Location, background location, motion/activity, Usage Access, notification, sensor, Bluetooth, foreground service, and battery settings can collect, infer, or display sensitive information. Turn off tracking modes, notifications, external context, or permissions if they do not fit your privacy, battery, workplace, family, or legal requirements.',
  },
  {
    group: 'Backups & deletion',
    title: 'Backups, imports, and deletion',
    body: 'Encrypted backups depend on the password you choose; lost passwords cannot be recovered by the app. Readable exports are not protected. Imports can replace local data, and deletion or clearing data may be permanent.',
  },
  {
    group: 'Emergency limits',
    title: 'No emergency monitoring',
    body: 'Road Sage does not monitor you for emergencies, guarantee crash detection, contact emergency services, or replace roadside assistance, insurance claims processes, law enforcement, medical help, or human supervision.',
  },
  {
    group: 'Emergency limits',
    title: 'Use at your own risk',
    body: 'No app output is guaranteed to be accurate, available, secure, or suitable for your situation. You are responsible for how you use the app, what data you store or share, and any decision made from app information.',
  },
];
