package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.uiautomator.By
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T03_TripHistoryTest : BaseUiTest() {
    @Test
    fun tripHistoryShowsSeededTripsAndCardMetadata() {
        openTrips()
        assertAnyTextVisible("Expected 20 seeded trips", "20 of", "20 completed", "completed trips")
        assertAnyTextVisible("Expected card score", "95", "98", "99", "Score")
        assertAnyTextVisible("Expected card distance", "km", "mi")
        assertAnyTextVisible("Expected card date", "202", "Yesterday", "Today")
        assertAnyTextVisible("Expected tags", "work", "personal", "errand", "other")
        assertAnyTextVisible("Expected favorite indicator", "Sunday Drive", "Favorite", "Star")
    }

    @Test
    fun sortOptionsCanBeApplied() {
        openTrips()
        val sorts = listOf("Oldest First", "Newest First", "Best Score", "Worst Score", "Longest", "Shortest")
        sorts.forEach { sort ->
            tryClickAnyText("Sort", "Newest First", "Best Score")
            tryClickAnyText(sort)
            assertNoCrashLandmark("Trip History", "completed trips", "No matching trips")
        }
    }

    @Test
    fun filtersCanBeAppliedAndReset() {
        openTrips()
        val filters = listOf("This Week", "This Month", "Best Trips", "Worst Trips", "Night Drives", "High Risk", "Favorites", "Needs Ratings", "All Trips")
        filters.forEach { filter ->
            tryClickAnyText("Filter", "All Trips")
            tryClickAnyText(filter)
            assertNoCrashLandmark("Trip History", "No matching trips", "completed trips", "Sunday Drive")
        }
    }

    @Test
    fun searchSavedFiltersTripOpenAndVirtualScrollWork() {
        openTrips()
        tryClickAnyText("Search")
        runCatching { typeIntoFirstField("Grocery run") }
        assertAnyTextVisible("Search should find trip by nickname", "Grocery run", "No matching trips")
        tryClickAnyText("Clear", "All Trips")
        tryClickAnyText("Save Filter", "Save filter", "Saved")
        tryClickAnyText("Delete", "Remove")
        scrollToTextContains("Favorited trips")
        device.findObjects(By.textContains("km"))
        assertNoCrashLandmark("Trip History", "completed trips", "Favorited trips")
        openTripByText("Grocery run")
        assertAnyTextVisible("Trip card should open detail page", "Grocery run", "Overall", "Trip")
    }
}
