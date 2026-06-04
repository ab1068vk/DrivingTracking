package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T08_TripDetailSplitDeleteTest : BaseUiTest() {
    @Test
    fun splitTripFlowIsReachable() {
        openTripByText("Long highway")
        scrollToTextContains("Split Trip")
        assertAnyTextVisible("Expected split button on long trip", "Split Trip", "Split")
        tryClickAnyText("Split Trip", "Split")
        assertNoCrashLandmark("Split into separate trips?", "Split", "Long highway", "Trip")
        tryClickAnyText("Cancel", "Back")
    }

    @Test
    fun deleteConfirmationCanBeCancelledAndConfirmed() {
        openTripByText("Short errand")
        scrollToTextContains("Delete")
        tryClickAnyText("Delete", "Delete Trip")
        assertAnyTextVisible("Expected delete confirmation", "Delete this trip", "cannot be undone", "Delete")
        tryClickAnyText("Cancel")
        assertAnyTextVisible("Cancelling delete should keep detail visible", "Short errand", "Overall", "Trip")

        scrollToTextContains("Delete")
        tryClickAnyText("Delete", "Delete Trip")
        assertAnyTextVisible("Expected delete confirmation on second attempt", "Delete this trip", "cannot be undone", "Delete")
        tryClickAnyText("Delete", "Confirm")
        assertAnyTextEventually("Confirming delete should navigate to history", "Trip History", "completed trips")
    }
}
