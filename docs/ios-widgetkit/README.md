# iOS WidgetKit Parity

Road Sage currently has an Android parked-car home-screen widget only. This repository does not include an `ios/` Capacitor project, Xcode workspace, WidgetKit extension, App Group entitlement, or Swift native plugin.

Capacitor JavaScript cannot write directly into an App Group container. iOS parity requires a native bridge that mirrors `saveLastParkedLocation` writes into App Group storage, then a WidgetKit extension that reads that shared record.

## Target Modules

- `RoadSageParkedLocationPlugin`: Capacitor plugin called by the web save path.
- `ParkedLocationAppGroupStore`: Swift App Group reader/writer.
- `ParkedLocationRecord`: Codable record shared by app and widget extension.
- `ParkedCarWidgetExtension`: WidgetKit target.
- `ParkedCarTimelineProvider`: timeline reload and placeholder logic.
- `ParkedCarWidgetView`: SwiftUI widget view.

## Related Notes

- [Storage contract](storage-contract.md)
- [Native bridge](native-bridge.md)
- [Widget extension](widget-extension.md)
- [Implementation checklist](implementation-checklist.md)
