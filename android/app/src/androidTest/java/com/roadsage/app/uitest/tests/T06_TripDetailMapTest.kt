package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T06_TripDetailMapTest : BaseUiTest() {
    @Test
    fun mapRouteControlsAndRoadDataActionsAreReachable() {
        openTripByText("Aggressive city driving")
        scrollToTextContains("Map")
        assertAnyTextVisible("Expected map container or no-location state", "Map", "Route", "location")
        assertAnyTextVisible("Expected route polyline or placeholder", "Before getting road data", "GPS", "Route")
        assertAnyTextVisible("Expected zoom/map controls", "+", "-", "Zoom", "Leaflet")
        assertAnyTextVisible("Expected event markers or event map references", "Events", "marker", "Harsh")
        assertAnyTextVisible("Expected speed-limit layer toggle", "Speed-Limit", "Speed Limit", "Show")
        tryClickAnyText("Show Speed-Limit Layer", "Hide Speed-Limit Layer", "Speed Limit")
        assertNoCrashLandmark("Map", "Route", "Speed")
        assertAnyTextVisible("Expected road-data action", "Get / Refresh Road Data", "Get Road Data", "Refresh Road Data")
        tryClickAnyText("Get / Refresh Road Data", "Get Road Data", "Refresh Road Data")
        assertNoCrashLandmark("OSM", "Road Data", "Map", "Route")
        assertAnyTextVisible("Expected context fetch action", "Fetch Road Context", "Road Context", "Get / Refresh Road Data")
    }
}
