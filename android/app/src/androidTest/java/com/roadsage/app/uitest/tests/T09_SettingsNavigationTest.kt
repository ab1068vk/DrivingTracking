package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T09_SettingsNavigationTest : BaseUiTest() {
    @Test
    fun settingsSearchAndSectionsAreReachable() {
        openSettings()
        assertAnyTextVisible("Expected Settings screen", "Settings", "Customize your Road Sage experience")
        assertAnyTextVisible("Expected settings search/filter", "Search", "Filter settings")
        tryClickAnyText("Search", "Filter settings")
        runCatching { typeIntoFirstField("tracking") }
        assertAnyTextVisible("Search should narrow to tracking settings", "Tracking", "Auto Tracking", "Manual")
        tryClickAnyText("Clear", "Settings")

        listOf("Tracking", "Privacy", "Privacy Zones", "Data Retention", "Backup", "Notifications", "Scoring", "Calibration", "Vehicles", "Advanced").forEach { section ->
            scrollToTextContains(section)
            assertAnyTextVisible("Expected settings section $section", section, section.replace(" Zones", ""))
            tryClickAnyText(section)
            assertNoCrashLandmark("Settings", section)
        }
    }
}
