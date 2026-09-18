# Known Limitations

What Road Sage does not guarantee. Every item below is derived from how the current
implementation actually behaves.

## Qualification

- **Physical-device qualification has not been performed.** Behaviour on real hardware — real
  drives, real background pressure, real process death, real camera conditions — is not
  established by the current testing.
- Software test results demonstrate that implemented behaviour matches its specification. They do
  not demonstrate real-world accuracy.

## Location and trip detection

- Trip detection depends on GPS quality and Android activity recognition. Both are probabilistic.
- Automatic detection can start late, end late, miss a short trip, or split one trip into two —
  for example in tunnels, parking structures, dense urban canyons or after a long stop.
- Passenger and non-driving travel may be recorded as a trip; the application cannot determine who
  was driving.
- Indoor and underground positions are frequently inaccurate, which affects parked-location
  resolution.

## Background capture

- Android background execution is controlled by the operating system and by manufacturer-specific
  battery management. Capture may be delayed, throttled or stopped by the device.
- Reliable background capture generally requires location, background-location,
  activity-recognition and notification permissions, and exemption from battery optimisation.
- If a permission is revoked, the affected capability reports unavailable rather than degrading
  silently.

## Speed limits

- Road Sage does **not** know the speed limit everywhere. Coverage depends on available map data
  and on how often a road has been driven.
- Learned road speeds are statistical inferences from observation, not authoritative limits.
- Temporary, variable, conditional and unposted limits may not be represented.
- Speed-limit values carry a source and a confidence; low-confidence values are gated out of
  alerting rather than presented as certain.

## Speed-sign scanning

- The camera feature is user-initiated and Android-only.
- Its pre-filter is a heuristic visual gate, not a trained recognition model.
- Reading accuracy depends on lighting, weather, motion, sign condition, occlusion and angle.
- Damaged, dirty, non-standard or non-Latin-numeral signs may be misread or rejected.
- A scan is treated as strong evidence, not as ground truth, and never changes scoring or alerts
  unless the user personally confirms the sign after parking.
- One tightly cropped sign image may be retained temporarily (encrypted, no-backup storage,
  deleted after the decision, unavailable after 24 hours) to support that confirmation.

## Scoring

- Scoring thresholds are **provisional**. Source constants record their calibration status
  explicitly.
- A score is meaningful only together with its confidence level and the scoring version that
  produced it.
- Scores computed under different scoring versions are not directly comparable without rescoring.
- Sparse data produces `developing` or `unavailable` states rather than a confident score.
- The score is informational. It is not a safety rating, a competence assessment, or a
  certification of any kind.

## Events and evidence

- Events are derived from sensor data and inherit its uncertainty.
- Route evidence can expire under retention settings; expired evidence is reported as expired, not
  as never having existed.
- Trips recorded in private mode intentionally withhold evidence.
- Recorded data is **not** designed or validated for use as legal, insurance or disciplinary
  evidence.

## Monitoring other people

- Road Sage records the device it runs on and cannot identify who was driving or who was using the
  phone.
- It must not be used to monitor another person without every consent, disclosure, permission and
  legal basis required in the user's jurisdiction.

## Alerts

- Voice alerts, notifications, possible-incident checks, phone-use warnings, speeding checks,
  route-risk messages and maintenance reminders can be late, muted, blocked, missed, unavailable
  or wrong. They must not be relied on to prevent harm.
- Road Sage does not monitor for emergencies, does not promise crash detection, and does not
  replace roadside assistance, emergency services or human supervision.

## Vehicle maintenance information

- Maintenance reminders and driving-load signals are planning aids, not diagnostics,
  component-life measurements or repair instructions.
- Where an owner manual, tyre placard, vehicle alert, recall notice or qualified technician
  conflicts with Road Sage, that source governs.

## Phone-usage evidence

- Requires a special-access Android permission the user must grant in system settings, and which
  can be revoked at any time.
- When not granted, the feature reports unavailable; it does not infer usage from other signals.
- It records usage windows as evidence. It cannot determine who was holding the phone.

## Network-dependent features

- Weather and OpenStreetMap road-data enrichment require network access and are consent-gated;
  automatic context fetch is off by default.
- Route snapping requires a trusted, user-configured endpoint; the public demo endpoint is
  rejected.
- When these are unavailable, the application falls back to local knowledge and records the
  reason. Core capture is unaffected.

## Bluetooth and vehicle signals

- Bluetooth-based vehicle signals depend on the vehicle and adapter. Availability is
  hardware-dependent and not guaranteed.

## Storage, migration and backup

- Data lives on the device. Loss or reset of the device means loss of data unless a backup exists.
- A backup that has never been restored is an untested backup.
- Passphrase-protected backups cannot be recovered if the passphrase is lost.
- Backups do not restore private coordinates by design.

## Performance and scale

- The architecture uses bounded queries and scalar counts intended to keep cost flat as history
  grows, and automated tests exercise this structurally at multiple dataset sizes.
- **Real-device performance at large history sizes has not been measured.** No performance claim
  is made pending physical qualification.

## Diagnostics

- Diagnostics reports what the software can observe about itself. It is not an independent
  verification of correctness.
- It deliberately excludes personal data, so it cannot be used to recover or inspect trip content.

## Platform coverage

- Android behaviour varies by manufacturer, Android version and device policy.
- Web-only use lacks every native capability listed in the overview.
- The application has not been validated against every Android device.
