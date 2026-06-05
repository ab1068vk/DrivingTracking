package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T18_SurveyPageTest : BaseUiTest() {
    @Test
    fun postTripSurveyCanBeCancelledAndSubmitted() {
        openTripByText("Aggressive city driving")
        scrollToTextContains("Survey")
        tryClickAnyText("Survey", "Rate this trip", "Needs Ratings", "Start rating")
        assertAnyTextVisible("Expected survey page/card", "Survey", "drive quality", "rating", "How was this drive")
        assertAnyTextVisible("Expected score accuracy options", "score accuracy", "Accurate", "Too harsh", "Too generous")
        assertAnyTextVisible("Expected driver/passenger toggle", "Driver", "Passenger")
        assertAnyTextVisible("Expected context tag section", "Heavy Traffic", "Traffic", "Context")
        tryClickAnyText("Heavy Traffic", "Traffic")
        tryClickAnyText("Cancel", "Skip")
        assertAnyTextEventually("Cancelling survey should navigate to Trip History or detail", "Trip History", "Back to trips", "Overall")

        openTripByText("Night drive")
        scrollToTextContains("Survey")
        tryClickAnyText("Survey", "Rate this trip", "Needs Ratings", "Start rating")
        tryClickAnyText("Good", "Okay", "4", "Accurate")
        tryClickAnyText("Driver")
        tryClickAnyText("Heavy Traffic", "Night", "Traffic")
        tryClickAnyText("Submit", "Save", "Done")
        assertAnyTextEventually("Submitting survey should return to Trip History or clear needs-rating state", "Trip History", "completed trips", "Overall")
    }
}
