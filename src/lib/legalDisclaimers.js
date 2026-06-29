export const LEGAL_DISCLAIMER_SHORT =
  'Personal-use informational estimates only. Not legal, insurance, navigation, emergency, medical, maintenance, tax, employment, fleet, compliance, or safety-critical advice.';

export const LEGAL_DISCLAIMER_SUMMARY =
  `${LEGAL_DISCLAIMER_SHORT} Road Sage estimates driving patterns from device sensors, GPS, maps, weather, route, vehicle, cost, emissions, phone-use, OBD, and optional third-party data that can be incomplete, delayed, unavailable, stale, misclassified, or wrong. You remain responsible for safe driving, posted signs, traffic laws, road conditions, vehicle condition, permissions, consent, data sharing, exports, backups, and every decision made from app outputs.`;

export const LEGAL_NOTICE_ACK_VERSION = 6;

export const LEGAL_NOTICE_INTRO =
  'Road Sage is a local-first driving log and coaching app for personal information and self-coaching. Read this notice before using tracking, background auto tracking, scores, maps, alerts, reports, exports, backups, privacy zones, external road data, phone-use checks, OBD features, vehicle features, or survey tools.';

export const LEGAL_NOTICE_KEY_POINTS = [
  'Do not use the app while driving.',
  'Scores, alerts, maps, speed limits, costs, emissions, fatigue signals, phone-use signals, possible incident signals, crash-related signals, and vehicle-health outputs are estimates and may be wrong.',
  'Road Sage is not legal, insurance, emergency, navigation, medical, tax, employment, fleet, compliance, repair, maintenance, or safety-critical advice.',
  'If Background Auto is enabled, Road Sage may collect location and activity signals while the app is minimized or in the background, but Android may stop tracking if the app is fully closed or force-stopped.',
  'Your data stays local by default. Saved road-speed reviews can reduce repeated OpenStreetMap lookups, but road-data features may still share limited route, location, date, or public road-area data with outside services when you tap Get Road Data, enable automatic road-data lookup, or approve route matching.',
  'Do not use Road Sage to monitor another person, worker, vehicle, family member, minor, or shared device without all legally required consent, notice, and permissions.',
  'You are responsible for safe driving, traffic laws, posted signs, road conditions, your vehicle, permissions, consent, exports, backups, and any decisions made from app information.',
];

export const LEGAL_DATA_PRACTICES = [
  {
    title: 'Location and routes',
    access: 'GPS location, route points, speed, heading, altitude, distance, parking context, timestamps, and privacy-zone masking metadata.',
    use: 'Used for trip logging, route maps, speed estimates, driving-event detection, privacy zones, parked-car context, reports, and route-risk context.',
    sharing: 'Stored locally by default. OpenStreetMap and Open-Meteo are contacted when enabled road-data lookup is run manually or by automatic road-data consent. OSRM is contacted only through approved route-matching actions.',
  },
  {
    title: 'Background tracking',
    access: 'Background location, Android activity recognition, foreground service notifications, and native trip state when enabled.',
    use: 'Used to detect and save trips automatically while the app is minimized, asleep, or not on screen. Fully closing or force-stopping the app can still stop Android tracking.',
    sharing: 'Not sold. Stored locally unless you export, back up, import, run road-data lookup, enable automatic road-data lookup, or approve route matching.',
  },
  {
    title: 'Sensors, phone use, and vehicle data',
    access: 'Motion sensor samples, Android Usage Access summaries, Bluetooth/OBD readings, notification state, battery and device capability checks when enabled.',
    use: 'Used for driving-quality estimates, phone-use evidence, possible incident or crash-related signals, OBD vehicle context, diagnostics, alerts, and readiness checks.',
    sharing: 'Local by default. Bluetooth pairing and OS permissions are controlled by Android and the connected adapter/device.',
  },
  {
    title: 'Reports, backups, logs, and surveys',
    access: 'Trips, events, scores, settings, vehicles, calibration survey labels, system logs, exports, and backup files.',
    use: 'Used for local history, PDFs/CSVs, encrypted or readable backups, troubleshooting, calibration notes, and privacy audits.',
    sharing: 'Exported or backup files can reveal sensitive data to anyone who receives or can open them. Passwords for encrypted backups cannot be recovered by the app.',
  },
  {
    title: 'Consent, control, and device access',
    access: 'Permission choices, tracking mode, privacy-zone settings, app-lock settings, screen-capture setting, notification settings, and external-service consent records.',
    use: 'Used to enforce local controls, show setup status, explain active protections, and keep an audit trail of privacy-sensitive choices.',
    sharing: 'Local by default. Anyone with access to the unlocked device, exported records, screenshots, or shared backups may still see sensitive information.',
  },
];

export const LEGAL_DISCLAIMER_ITEMS = [
  {
    group: 'Safety & responsibility',
    title: 'Personal use, not professional advice',
    body: 'Road Sage is for personal trip logging and self-coaching. It is not legal, insurance, underwriting, employment, compliance, fleet, tax, medical, emergency, navigation, repair, maintenance, or safety-critical advice.',
  },
  {
    group: 'Safety & responsibility',
    title: 'Drive safely first',
    body: 'Do not interact with the app while driving. Always obey posted signs, traffic laws, police direction, road conditions, vehicle limits, and your own judgment before any app alert, score, recommendation, map, or route context.',
  },
  {
    group: 'Safety & responsibility',
    title: 'No use for monitoring others without consent',
    body: 'Do not use Road Sage to track, score, evaluate, supervise, discipline, insure, employ, price, or monitor another person, employee, contractor, family member, minor, shared device, or vehicle without every consent, disclosure, permission, and legal basis required where you are.',
  },
  {
    group: 'Safety & responsibility',
    title: 'Laws and duties vary',
    body: 'Traffic, privacy, employment, insurance, tax, surveillance, recording, consumer, and vehicle laws vary by place and can change. If an app output matters legally, financially, medically, commercially, or for safety, verify it independently and consult a qualified professional.',
  },
  {
    group: 'Safety & responsibility',
    title: 'Background tracking requires consent',
    body: 'If you choose Background Auto, Road Sage can use location and activity signals while the app is minimized or in the background so it can detect and save trips. Fully closing or force-stopping the app can still stop Android tracking. You can turn off Background Auto, pause tracking, disable notifications, or revoke permissions at any time.',
  },
  {
    group: 'Accuracy limits',
    title: 'Scores and detections are estimates',
    body: 'Safety, smoothness, eco, UBI-style, fatigue, focus, phone-use, possible incident, crash-related, speed, braking, acceleration, cornering, heading, overtake, route-risk, historical-context, maintenance, tire, fuel, EV, emissions, and cost outputs are estimates and can be inaccurate, incomplete, delayed, unavailable, stale, or misclassified.',
  },
  {
    group: 'Accuracy limits',
    title: 'Maps are not navigation',
    body: 'Maps, parked-car location, speed limits, road data, weather, route matching, route risk, and privacy-zone masking are informational only. They are not turn-by-turn navigation and may not reflect current closures, hazards, legal restrictions, private property, construction, signs, or actual road conditions.',
  },
  {
    group: 'Accuracy limits',
    title: 'Signals can be missing or wrong',
    body: 'GPS, sensors, Android activity recognition, Usage Access, Bluetooth, OBD, network state, battery optimization, map data, weather data, and time calculations can fail, drift, lag, lose precision, be unavailable, or be affected by device model, OS settings, mounts, tunnels, garages, tall buildings, and user edits.',
  },
  {
    group: 'Records, exports & decisions',
    title: 'Not official records',
    body: 'Reports, backups, exports, maps, GPS traces, event labels, score cards, charts, and summaries are not insurer-validated ratings, official records, legal evidence, proof of work, proof of tax treatment, proof of compliance, or proof of fault.',
  },
  {
    group: 'Records, exports & decisions',
    title: 'Not for adverse decisions',
    body: 'Do not use app outputs by themselves to make legal, insurance, employment, lending, pricing, disciplinary, eligibility, safety, medical, tax, fleet, or compliance decisions about yourself or anyone else. Verify important decisions with primary records and qualified professionals.',
  },
  {
    group: 'Records, exports & decisions',
    title: 'Vehicles and costs',
    body: 'Maintenance, tire wear, fuel, EV, emissions, savings, and vehicle health estimates are not diagnostics, financial advice, environmental compliance validation, or repair instructions. Inspect your vehicle, follow the manufacturer schedule, and use a qualified professional for repairs, safety concerns, or compliance decisions.',
  },
  {
    group: 'Privacy & data',
    title: 'Local data and privacy',
    body: 'Trip, GPS, route, score, vehicle, settings, survey label, backup, export, notification, system log, permission, consent, and diagnostic data are stored locally by default. Anyone with device access, exported files, readable backups, imported data, screenshots, notifications, or screen access may be able to view sensitive trip or location details.',
  },
  {
    group: 'Privacy & data',
    title: 'Optional external requests',
    body: 'Saved and reviewed road speeds can reduce repeated OpenStreetMap lookups for roads you already maintain locally. Road-data lookup can send privacy-filtered public road boxes to OpenStreetMap and one privacy-safe route point plus date to Open-Meteo when you tap Get Road Data or enable automatic road-data lookup. Route matching can send sampled public GPS segments to the OSRM endpoint you configure and explicitly approve. Public or third-party services have their own availability, logging, privacy, retention, security, rate-limit, and policy practices.',
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
    group: 'Privacy & data',
    title: 'Privacy zones reduce risk, not all exposure',
    body: 'Privacy zones, masking, export warnings, local storage, app lock, and screen-capture controls reduce exposure but are not absolute protection. They cannot promise anonymity, secrecy, deletion, legal compliance, or protection from device compromise, modified app builds, screenshots, synced files, backups, notifications, memory, network metadata, user-approved external endpoints, or people with access to your device.',
  },
  {
    group: 'Backups & deletion',
    title: 'Backups, imports, and deletion',
    body: 'Encrypted backups depend on the password you choose; lost passwords cannot be recovered by the app. Readable exports are not protected. Imports can replace local data, and deletion or clearing data may be permanent.',
  },
  {
    group: 'Emergency limits',
    title: 'No emergency monitoring',
    body: 'Road Sage does not monitor you for emergencies, promise crash detection, or replace roadside assistance, insurance claims processes, law enforcement, medical help, or human supervision.',
  },
  {
    group: 'Emergency limits',
    title: 'Alerts may not arrive',
    body: 'Voice alerts, notifications, possible-incident checks, phone-use warnings, speeding checks, route-risk messages, and maintenance reminders can be late, muted, blocked, missed, unavailable, or wrong. Do not depend on them to prevent harm.',
  },
  {
    group: 'Emergency limits',
    title: 'No app-wide assurances',
    body: 'Except where law says otherwise, no app output is promised to be accurate, complete, available, secure, current, uninterrupted, error-free, or suitable for your situation. You are responsible for how you use the app, what data you store or share, and any decision made from app information.',
  },
];
