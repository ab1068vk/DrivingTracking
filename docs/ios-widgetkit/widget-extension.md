# Widget Extension

The iOS parked-car widget should be a WidgetKit extension that reads the App Group parked-location JSON and renders locally.

## Suggested Files

- `ios/ParkedCarWidget/ParkedCarWidgetBundle.swift`
- `ios/ParkedCarWidget/ParkedCarWidget.swift`
- `ios/ParkedCarWidget/ParkedCarTimelineProvider.swift`
- `ios/ParkedCarWidget/ParkedCarWidgetView.swift`
- `ios/ParkedCarWidget/ParkedLocationAppGroupReader.swift`

## Behavior

- Empty state: no App Group record or invalid payload.
- Public parked state: address if present, otherwise relative parked age.
- Navigation: deep link into the app or open Apple Maps from the main app after tap handling.
- Refresh: WidgetKit timeline reload after native plugin writes.

## Map Preview

Start without a remote static map in the iOS widget unless there is a privacy-reviewed tile strategy. A text-first widget avoids transmitting parked coordinates from the extension.
