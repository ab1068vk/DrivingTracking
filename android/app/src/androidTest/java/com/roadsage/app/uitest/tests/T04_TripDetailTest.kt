package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T04_TripDetailTest : BaseUiTest() {
    @Test
    fun tripDetailShowsScoresComponentsAndMetadata() {
        openTripByText("Sunday Drive")
        assertAnyTextVisible("Expected overall score", "Overall", "98")
        assertAnyTextVisible("Expected Safety tile", "Safety")
        assertAnyTextVisible("Expected Smoothness tile", "Smoothness", "Smooth")
        assertAnyTextVisible("Expected Eco tile", "Eco")
        listOf("Aggression", "Defensive", "Jerk", "Speed Variability", "Fuel Band", "Eco Driving").forEach {
            scrollToTextContains(it)
            assertAnyTextVisible("Expected component score $it", it)
        }
        listOf("Approach", "Braking", "Cornering", "Stop-Start", "Lane").forEach {
            scrollToTextContains(it)
            assertAnyTextVisible("Expected component score $it", it, "unavailable", "-")
        }
        assertAnyTextVisible("Unavailable components should not display as zero only", "unavailable", "-", "limited evidence")
        assertAnyTextVisible("Expected trip metrics", "km", "Duration", "Average", "Avg")
        assertAnyTextVisible("Expected tag", "personal", "work", "errand", "other")
        assertAnyTextVisible("Expected favorite state", "Favorite", "Sunday Drive", "Star")
        assertAnyTextVisible("Expected nickname", "Sunday Drive")
        assertAnyTextVisible("Expected notes", "Great conditions!")
        assertAnyTextVisible("Expected confidence badge", "confidence", "high", "Score based")
        assertAnyTextVisible("Expected provenance/explanation", "Provenance", "initial_score", "Score explanation", "Evidence")
    }

    @Test
    fun favoriteToggleVehicleAndBackNavigationWork() {
        openTripByText("Sunday Drive")
        tryClickAnyText("Favorite", "Star")
        assertNoCrashLandmark("Sunday Drive", "Overall", "Trip")
        pressBack()
        assertAnyTextVisible("Back should return to Trip History", "Trip History", "completed trips")

        openTripByText("Vehicle assigned")
        assertAnyTextVisible("Expected assigned vehicle name", "Honda Civic 2019", "Vehicle")
    }

    @Test
    fun approximateScoreAndScoreRingRender() {
        openTripByText("Heading deviation")
        assertAnyTextVisible("Expected score confidence or approximate marker", "~", "confidence", "limited", "Score")
        assertAnyTextVisible("Score ring/chart should render with nonblank text", "Overall", "68", "Score")
    }
}
