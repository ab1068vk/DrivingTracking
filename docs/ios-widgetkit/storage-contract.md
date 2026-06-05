# Storage Contract

The iOS widget should not read Capacitor Preferences or browser storage. It should read a small JSON file from an App Group container.

## App Group

- Entitlement: `group.com.roadsage.app`
- File name: `last_parked_location.json`
- Owner: main iOS app writes, WidgetKit extension reads.

## JSON Shape

```json
{
  "lat": 43.6532,
  "lng": -79.3832,
  "timestamp": "2026-01-01T12:00:00.000Z",
  "timestamp_ms": 1767278400000,
  "tripId": "trip-id",
  "address": "Queen Street West, Toronto",
  "source": "trip_end"
}
```

## Privacy Rule

The web save path must complete privacy-zone checks before calling the iOS bridge. Private parked locations must clear the App Group record instead of writing raw coordinates or an address.
