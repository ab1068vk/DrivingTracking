# Implementation Checklist

1. Add the Capacitor iOS project with `npx cap add ios`.
2. Add App Group entitlements to the app target and widget extension.
3. Add `ParkedLocationRecord` as a small Codable model shared by app and widget.
4. Add `ParkedLocationAppGroupStore` for atomic JSON writes and deletes.
5. Add `RoadSageParkedLocationPlugin` with save, clear, and reload methods.
6. Call the plugin only after web privacy-zone checks pass.
7. Add a WidgetKit extension that reads App Group storage.
8. Add tests for public write, private clear, malformed JSON, and missing App Group storage.
9. Document the iOS widget privacy model alongside the Android widget privacy model.
