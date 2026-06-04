package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T15_SettingsDataManagementTest : BaseUiTest() {
    @Test
    fun dataRetentionDeleteAllAndFactoryResetCanBeCancelled() {
        openSettings()
        scrollToTextContains("Data Retention")
        assertAnyTextVisible("Expected retention section", "Data Retention", "24 months", "Retention")
        tryClickAnyText("12 months", "12")
        assertNoCrashLandmark("Data Retention", "12", "Settings")
        tryClickAnyText("24 months", "24")
        assertNoCrashLandmark("Data Retention", "24", "Settings")
        assertAnyTextVisible("Expected delete all trips action", "Delete ALL Trips", "Delete All Trips")
        tryClickAnyText("Delete ALL Trips", "Delete All Trips")
        assertAnyTextVisible("Expected cannot-be-undone confirmation", "cannot be undone", "Delete")
        tryClickAnyText("Cancel")
        assertAnyTextVisible("Expected factory reset action", "Factory Reset", "Wipe All Road Sage Data")
        tryClickAnyText("Factory Reset", "Wipe All Road Sage Data")
        assertAnyTextVisible("Expected first factory reset warning", "Factory reset Road Sage", "permanently deletes", "Cancel")
        tryClickAnyText("Cancel")
        assertNoCrashLandmark("Settings", "Data Retention")
    }
}
