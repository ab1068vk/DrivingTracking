# Certificate Pin Renewal

Road Sage pins native Android TLS certificates for GPS-bearing road-data providers. Pins are an outage risk if a provider rotates its certificate chain, and Android stops enforcing a `pin-set` after its expiration date. Renew these pins before the check window closes.

## Owner And Schedule

- Owner: release/security maintainer for Android builds.
- Review cadence: monthly, and before every Android release candidate.
- Required lead time: 180 days before the earliest `pin-set` expiration.
- Guardrail: `npm run check:cert-pins` fails once any configured pin-set is inside the lead-time window.

Current renewal deadlines:

| Host | Pin-set expiration | Renew by |
| --- | --- | --- |
| `api.open-meteo.com` | 2027-03-01 | 2026-09-02 |
| `overpass-api.de` | 2027-03-01 | 2026-09-02 |
| `archive-api.open-meteo.com` | 2028-08-01 | 2028-02-03 |
| `overpass.kumi.systems` | 2028-08-01 | 2028-02-03 |
| `nominatim.openstreetmap.org` | 2028-08-01 | 2028-02-03 |

## Renewal Steps

1. Confirm the provider endpoints are still required by the app.
2. Fetch the live certificate chain from a trusted network and compute SPKI SHA-256 pins for each certificate in the served chain.
3. Keep at least two valid pins per host. Prefer the currently served leaf/intermediate plus a backup key published or validated by the provider when available.
4. Update every mirror together:
   - `android/app/src/main/res/xml/network_security_config.xml`
   - `src/lib/pinnedFetch.js`
   - `android/app/src/main/java/com/drivesense/app/RoadDataJobService.java` for hosts used by background road-data jobs
5. Set each Android `pin-set` expiration far enough out for operations, then schedule the next review at least 180 days before that date.
6. Run:

```bash
npm run check:cert-pins
npm run test
```

7. On Android, exercise manual Get Road Data and any background road-data job path that uses the renewed host.

## Pin Extraction Reference

For each host, save the served chain and compute the SPKI hash for each certificate. Example with OpenSSL:

```bash
openssl s_client -servername api.open-meteo.com -connect api.open-meteo.com:443 -showcerts </dev/null
```

For each PEM certificate from that output:

```bash
openssl x509 -pubkey -noout -in cert.pem \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | openssl base64
```

Android XML pins omit the `sha256/` prefix. JavaScript and Java pin lists include it, for example `sha256/<base64-value>`.
