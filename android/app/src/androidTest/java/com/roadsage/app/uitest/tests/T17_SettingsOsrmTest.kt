package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T17_SettingsOsrmTest : BaseUiTest() {
    @Test
    fun osrmAndExternalContextControlsValidateAndToggle() {
        openSettings()
        scrollToTextContains("OSRM")
        tryClickAnyText("Advanced", "OSRM")
        assertAnyTextVisible("Expected OSRM map matching section", "OSRM Map Matching", "OSRM")
        assertAnyTextVisible("Expected endpoint URL field", "Endpoint", "URL", "https")
        runCatching { typeIntoFirstField("http://example.com") }
        assertAnyTextVisible("Expected HTTP validation", "trusted HTTPS", "https", "validation")
        runCatching { typeIntoFirstField("https://localhost:5000") }
        assertAnyTextVisible("Expected localhost validation", "localhost", "trusted", "validation")
        assertAnyTextVisible("Expected map matching toggle", "Map matching", "Snap to roads", "OSRM")
        tryClickAnyText("Map matching", "Snap to roads")
        assertNoCrashLandmark("OSRM", "Map matching", "Settings")
        assertAnyTextVisible("Expected OSM speed limits toggle", "OSM Speed Limit", "Speed Limit Lookup")
        tryClickAnyText("OSM Speed Limit", "Speed Limit Lookup")
        assertNoCrashLandmark("ON", "OFF", "Speed Limit", "OSRM")
        assertAnyTextVisible("Expected weather context toggle", "Weather Context", "Weather")
        tryClickAnyText("Weather Context", "Weather")
        assertNoCrashLandmark("Weather", "ON", "OFF")
        assertAnyTextVisible("Expected external context auto-fetch", "External context", "auto-fetch", "Automatic road data")
        tryClickAnyText("OSRM public demo", "public demo", "Demo endpoint")
        assertAnyTextVisible("Expected public demo consent dialog or copy", "consent", "public demo", "Cancel")
        tryClickAnyText("Cancel")
        assertNoCrashLandmark("OSRM", "Advanced", "Settings")
    }
}
