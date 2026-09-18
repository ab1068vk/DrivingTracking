# Frequently Asked Questions

Answers reflect the current implementation. Where an answer is nuanced, it says so.

### Does Road Sage record trips automatically?

On Android, yes — if you opt in. The native background service uses activity recognition with a
GPS fallback to detect driving. Detection is probabilistic: it can start or end late, miss a very
short trip, or split one trip in two. Manual recording is always available.

### Can I record a trip manually?

Yes, on both web and Android.

### Does it work without internet access?

Core capture, storage, scoring and history work offline. Optional enrichment — weather and
OpenStreetMap road data — requires network access. When unavailable, the app falls back to local
knowledge and records why.

### Does it track my location continuously?

Only while tracking is active. Background capture requires explicit opt-in and location
permissions, including background location on Android. You can stop tracking at any time from the
app, the notification, or the quick-settings tile.

### What permissions does it use?

Location (including background), activity recognition, notifications and foreground-service access
for tracking. Camera for speed-sign scanning. Usage-access for phone-usage evidence. Bluetooth for
vehicle signals. Biometric for the optional app lock. Optional features report unavailable if their
permission is not granted.

### What data is stored, and where?

Trips, routes, events, scores, vehicles, parking records, settings and derived analytics — stored
on the device. Trip payloads are encrypted at rest. There is no Road Sage server receiving trip
data. See [../legal/DATA_HANDLING_NOTICE.md](../legal/DATA_HANDLING_NOTICE.md).

### Can I delete my data?

Yes. Data-rights erasure removes records and derived residue, not just the visible list. Retention
settings can also expire route evidence automatically.

### Does Road Sage know the speed limit everywhere?

No. Coverage depends on available map data and on how often you have driven a road. Limits carry a
source and a confidence, and the app reports "unknown" rather than guessing. Temporary, variable
and unposted limits may not be represented.

### What are learned road speeds?

Where map data is missing or disputed, Road Sage can infer a likely limit from repeated
observations of that road. These are statistical inferences, not authoritative limits. A limit you
confirm against a posted sign is treated as much stronger evidence.

### What does the driving score mean?

It summarises the driving events recorded on a trip, weighted into component scores and an overall
score. Thresholds are provisional, and each score carries a confidence level. It is informational —
not a safety rating, a competence assessment or a certification.

### Why does a score sometimes show as approximate or unavailable?

Because the evidence was insufficient. Rather than present a confident number from thin data, the
app marks it as developing or unavailable.

### Does Road Sage use AI?

Not as a marketing claim. It uses conventional algorithms: threshold-based event classification,
statistical aggregation, geospatial matching, and Android's activity-recognition API. The speed-sign
scanner uses on-device ML Kit text recognition, preceded by a heuristic visual gate that is
explicitly not a trained model.

### Does the speed-sign scanner store photos of the road?

Full camera frames are discarded and recognised text is not retained. One tightly cropped image of
the sign may be kept temporarily so you can confirm the reading after parking. It is encrypted, in
Android no-backup storage, deleted once you confirm, adjust or reject the reading, and unavailable
after 24 hours. It is never included in exports or backups and never sent off the device. A camera
prompt does not change your score or alerts unless you personally confirm the sign.

### Can I use Road Sage to monitor someone else?

Not without their consent. Do not use it to track, score, evaluate, supervise, discipline, insure,
employ, price or monitor another person — including an employee, contractor, family member, minor,
shared device or vehicle — without every consent, disclosure, permission and legal basis required
where you are. Surveillance, recording, employment and privacy laws vary by place.

### Does Road Sage make driving safer?

No such claim is made. It records and summarises driving that already happened. It does not
intervene, prevent incidents, or assess whether you are a safe driver.

### Can the data be used as legal or insurance evidence?

It is not designed or validated for that. Data comes from consumer-grade sensors with known
uncertainty, and route evidence can expire under retention settings. Do not rely on it for legal,
insurance or disciplinary purposes.

### Does it know who was driving?

No. It records trips made with the device. It cannot distinguish driver from passenger.

### Does it work on every Android device?

It has not been validated across devices. Background execution behaviour varies significantly by
manufacturer, Android version and battery policy.

### How are backups handled?

Backups are versioned and encrypted, and can be passphrase-protected. Imports are treated as
untrusted and validated before anything is written. Private coordinates are never restored. A lost
passphrase cannot be recovered.

### What is Diagnostics?

A self-report describing what build is running, whether problems came from this launch or an older
one, and what the storage subsystems believe their state to be. It excludes coordinates, trip
identifiers, dates and notes, so it can be shared to explain a problem without sharing driving
history.

### Where do I find the full legal notice?

In the app. A versioned safety, legal, tracking and privacy notice is shown at first launch and
stays available in Settings under Privacy & Data, which also shows which version you accepted and
when. That in-app notice is the authoritative wording; the documents in `docs/legal/` explain
practice and are marked as drafts where they are review-oriented.

### Has the current version been tested on a real phone?

**No.** Software qualification is complete; physical-device qualification has not started. Results
from automated tests do not establish real-world behaviour. See
[LIMITATIONS.md](LIMITATIONS.md).

### Is Road Sage finished?

The software is implemented and tested for the current branch. Device qualification remains, and
there is no public release, distribution model or license decision recorded in this repository.
