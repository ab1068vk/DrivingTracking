package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T10_SettingsTrackingTest : BaseUiTest() {
    @Test
    fun trackingModeControlsAndShortcutsAreVisible() {
        openSettings()
        scrollToTextContains("Tracking")
        tryClickAnyText("Tracking", "Auto Tracking")
        assertAnyTextVisible("Expected tracking mode selector", "Manual", "Auto", "Background Auto")
        tryClickAnyText("Manual")
        assertAnyTextVisible("Expected manual tracking description", "Manual", "Start Trip", "Tap")
        tryClickAnyText("Background Auto", "Auto")
        handleSystemDialogs()
        assertNoCrashLandmark("Tracking", "Manual", "Auto")
        assertAnyTextVisible("Expected auto-tracking state", "Auto-tracking", "Auto Tracking", "enabled")
        assertAnyTextVisible("Expected pause/resume control or status", "paused", "resume", "Tracking")
        assertAnyTextVisible("Expected battery shortcut", "Battery", "Unrestricted")
        assertAnyTextVisible("Expected stealth or ephemeral section", "Stealth", "Ephemeral")
        assertAnyTextVisible("Expected Quick Settings tile section", "Quick Settings", "Add Tile", "Tile")
    }
}
