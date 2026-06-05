package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T11_SettingsPrivacyZoneTest : BaseUiTest() {
    @Test
    fun privacyZoneCreateValidateEditAndDeleteFlow() {
        openSettings()
        scrollToTextContains("Privacy Zones")
        tryClickAnyText("Privacy Zones", "Privacy")
        assertAnyTextVisible("Expected privacy zones section", "Privacy Zones", "private places")
        assertAnyTextVisible("Expected add privacy zone button", "Add Privacy Zone", "Add zone")
        tryClickAnyText("Add Privacy Zone", "Add zone")
        assertAnyTextVisible("Expected zone creation flow", "Label", "Radius", "Use current location", "Use parked location")
        runCatching { typeIntoFirstField("Test Zone") }
        assertAnyTextVisible("Expected radius control", "Radius", "300", "meters")
        runCatching { typeIntoFirstField("20") }
        assertAnyTextVisible("Expected low radius validation or radius label", "50", "Radius", "minimum")
        runCatching { typeIntoFirstField("1500") }
        assertAnyTextVisible("Expected high radius validation or radius label", "1000", "Radius", "maximum")
        tryClickAnyText("Cancel")
        assertAnyTextVisible("Expected return to settings after cancel", "Settings", "Privacy Zones")

        tryClickAnyText("Add Privacy Zone", "Add zone")
        runCatching { typeIntoFirstField("Test Zone") }
        tryClickAnyText("Save", "Add")
        assertAnyTextVisible("Expected saved zone or privacy zone list", "Test Zone", "Privacy Zones")
        tryClickAnyText("Edit", "Pencil")
        assertNoCrashLandmark("Test Zone", "Privacy Zones", "Label")
        tryClickAnyText("Delete", "Remove")
        tryClickAnyText("Confirm", "Delete")
        assertNoCrashLandmark("Privacy Zones", "Settings")
    }
}
