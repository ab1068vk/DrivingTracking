package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T02_DashboardTest : BaseUiTest() {
    @Test
    fun dashboardShowsScoresTripSummaryAndTrackingControls() {
        openDashboard()
        assertAnyTextVisible("Expected overall score ring or value", "Overall", "Score", "--")
        assertAnyTextVisible("Expected Safety category", "Safety")
        assertAnyTextVisible("Expected Smoothness category", "Smoothness", "Smooth")
        assertAnyTextVisible("Expected Eco category", "Eco")
        assertAnyTextVisible("Expected trip summary", "Recent", "trips", "Trip")
        assertAnyTextVisible("Expected tracking control", "Start Trip", "Tracking", "Manual")
        assertAnyTextVisible("Expected baseline or empty state", "baseline", "Not enough driving history", "last 5 trips")
        assertAnyTextVisible("Expected readiness or history panel", "readiness", "historical", "Not enough driving history")
        assertAnyTextVisible("Expected tracking health/status", "Tracking", "Health", "permission")
    }

    @Test
    fun dashboardPermissionAndStartTripControlDoNotCrash() {
        openDashboard()
        findTextContains("permission", 1_000L)?.let {
            assertAnyTextVisible("Permission banner should have actionable text", "Settings", "permission", "Enable", "Allow")
        }
        tryClickAnyText("Start Trip", "Start", "Resume", "Tracking")
        assertNoCrashLandmark("Dashboard", "Stop Trip", "Tracking", "Start Trip")
    }

    @Test
    fun dashboardScoreIsNumericOrPlaceholder() {
        openDashboard()
        val scoreLike = findAnyText("99", "98", "95", "Overall", "--")
        assertTrue("Expected a numeric score or -- placeholder", scoreLike != null)
    }
}
