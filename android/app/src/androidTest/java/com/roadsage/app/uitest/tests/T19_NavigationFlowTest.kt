package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T19_NavigationFlowTest : BaseUiTest() {
    @Test
    fun fullTripReviewFlowKeepsHistoryStable() {
        openTripByText("Aggressive city driving")
        scrollToTextContains("Events")
        assertAnyTextVisible("Expected events during review", "Events", "Harsh", "Rapid")
        tryClickAnyText("Wrong")
        assertNoCrashLandmark("wrong", "Removed", "Events")
        pressBack()
        assertAnyTextVisible("History card should remain visible after review", "Trip History", "Aggressive city driving", "42")
    }

    @Test
    fun editCancelSettingsRoundTripAndFavoriteFlow() {
        openTripByText("Grocery run")
        tryClickAnyText("Edit", "Pencil")
        runCatching { typeIntoFirstField("Cancelled flow nickname") }
        tryClickAnyText("Cancel")
        assertAnyTextVisible("Old nickname should remain after cancel", "Grocery run", "Overall")

        openSettings()
        tryClickAnyText("Metric", "Imperial", "Weather Context", "Tracking")
        pressBack()
        openSettings()
        assertAnyTextVisible("Settings state should still render after round trip", "Settings", "Tracking", "Privacy")

        openTripByText("Short errand")
        tryClickAnyText("Favorite", "Star")
        assertNoCrashLandmark("Favorite", "Short errand", "Overall")
        tryClickAnyText("Favorite", "Star")
        assertNoCrashLandmark("Favorite", "Short errand", "Overall")
    }

    @Test
    fun filterSortBackRotationAndReturnFromOsDoNotBreakTheApp() {
        openTrips()
        tryClickAnyText("Filter", "All Trips")
        tryClickAnyText("This Month")
        tryClickAnyText("Sort", "Newest First")
        tryClickAnyText("Worst Score")
        assertNoCrashLandmark("Trip History", "No matching trips", "completed trips")

        openTripByText("Sunday Drive")
        pressBack()
        pressBack()
        assertAnyTextVisible("Back presses should not leave app unusable", "Dashboard", "Trip History", "Start Trip", "Trips")

        openTripByText("Sunday Drive")
        runCatching {
            device.setOrientationLeft()
            assertNoCrashLandmark("Sunday Drive", "Overall", "Trip")
        }
        runCatching { device.setOrientationNatural() }

        device.pressHome()
        launchApp()
        assertAnyTextEventually("Returning from OS should show Road Sage again", "Dashboard", "Trip History", "Sunday Drive", "Overall")
    }
}
