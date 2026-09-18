# Security Policy

## Project status

Road Sage is under active development. Software qualification is complete for the current
development branch; physical-device qualification has not been performed. There is no published
release, and no version is currently designated as receiving security updates.

`[SUPPORTED VERSIONS POLICY — DECISION REQUIRED BEFORE PUBLIC RELEASE]`

## Reporting a vulnerability

`SECURITY CONTACT REQUIRED BEFORE PUBLIC RELEASE` — no reporting channel is established in this
repository yet.

Until one exists, please do not file security issues in a public tracker.

## What to include in a report

- A description of the issue and why you believe it is a security problem.
- The affected component: web application, Android native service, storage, backup/restore, key
  handling, or the web-to-native bridge.
- Steps to reproduce, and the build or commit you tested.
- Device and Android version, if relevant.
- The impact you believe it has.

## What not to include publicly

- Personal driving data: coordinates, routes, trip identifiers or exported backups.
- Passphrases, key material or credentials.
- A working exploit, in a public channel.

If demonstrating an issue requires real data, describe the shape of the data rather than attaching
it.

## Scope

In scope: the application source in this repository, including the Android native services, the
web-to-native bridge, local storage and encryption handling, and backup/restore.

Out of scope: third-party services the application can optionally contact (weather and
OpenStreetMap endpoints), the security of a user's own device, and issues requiring a compromised
or rooted device with physical access.

## Expectations

No response time is promised, because no reporting channel or maintainer commitment has been
established. Please do not interpret this file as a service-level commitment.

## Related documentation

- [Privacy and data handling](docs/security/PRIVACY_AND_DATA_HANDLING.md)
- [Key lifecycle and secure bridge](docs/security/KEY_LIFECYCLE_AND_SECURE_BRIDGE.md)
- [Certificate pin renewal](docs/security/CERTIFICATE_PIN_RENEWAL.md)
- [Open legal and product decisions](docs/legal/LEGAL_DECISIONS_REQUIRED.md)
