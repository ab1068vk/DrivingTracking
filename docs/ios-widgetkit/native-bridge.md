# Native Bridge

Add a Swift Capacitor plugin whose only responsibility is syncing parked-location records into App Group storage.

## Plugin Methods

- `saveParkedLocation(record)`: validates and writes the latest public parked record.
- `clearParkedLocation()`: removes the App Group parked record.
- `reloadParkedWidget()`: asks WidgetKit to refresh parked-car timelines.

## Suggested Files

- `ios/App/App/RoadSageParkedLocationPlugin.swift`
- `ios/App/App/ParkedLocationRecord.swift`
- `ios/App/App/ParkedLocationAppGroupStore.swift`
- `ios/App/App/ParkedWidgetReloader.swift`

Keep validation, persistence, and WidgetKit reload calls in separate files. The plugin method body should only parse arguments and delegate.

## Web Integration

After `saveLastParkedLocation` passes privacy-zone checks and resolves any public address, call the plugin on iOS native platforms. On privacy-zone removal, call `clearParkedLocation()`.
