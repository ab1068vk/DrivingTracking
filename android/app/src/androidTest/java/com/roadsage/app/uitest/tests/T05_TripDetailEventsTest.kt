package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T05_TripDetailEventsTest : BaseUiTest() {
    @Test
    fun aggressiveAndHighRiskEventsAreListedWithFeedbackControls() {
        openTripByText("Aggressive city driving")
        scrollToTextContains("Events")
        assertAnyTextVisible("Expected events section", "Events", "Event")
        listOf("Harsh", "Rapid", "Sharp", "Speeding").forEach {
            scrollToTextContains(it)
            assertAnyTextVisible("Expected event type $it", it)
        }
        assertAnyTextVisible("Expected severity badge", "high", "medium", "low")
        assertAnyTextVisible("Expected event timestamp", ":", "AM", "PM")
        assertAnyTextVisible("Expected feedback controls", "Accurate", "Wrong")
        tryClickAnyText("Wrong")
        assertNoCrashLandmark("wrong", "Removed", "Events")
        tryClickAnyText("Accurate")
        assertNoCrashLandmark("Accurate", "Events", "Overall")

        openTripByText("High-risk drive")
        assertAnyTextVisible("Expected possible incident", "Possible Incident", "possible_crash", "Incident")
        assertAnyTextVisible("Expected stop-start/idle events", "Stop-Start", "Idle", "Excessive")
        scrollToTextContains("Events")
        assertNoCrashLandmark("Events", "Overall")
    }

    @Test
    fun reviewedPhoneDiagnosticAndLaneEventsRender() {
        openTripByText("Feedback-reviewed events")
        assertAnyTextVisible("Wrong reviewed events should show removed state", "Removed", "wrong", "Reviewed")
        assertAnyTextVisible("Accurate reviewed events should show accurate state", "Accurate", "Reviewed Events")

        openTripByText("Phone use")
        assertAnyTextVisible("Expected phone use event text", "Phone Use", "phone_use", "Usage Access")

        openTripByText("Heading deviation")
        assertAnyTextVisible("Expected diagnostic badge", "diagnostic", "Diagnostic only", "Heading")

        openTripByText("Lane change detected")
        assertAnyTextVisible("Expected lane change event", "Lane Change", "lane_change_detected", "Lane")

        openTripByText("Stop-start pattern")
        assertAnyTextVisible("Expected stop-start event", "Stop-Start", "tailgate", "Pattern")
    }
}
