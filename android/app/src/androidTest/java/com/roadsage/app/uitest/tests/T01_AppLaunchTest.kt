package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.uiautomator.By
import com.roadsage.app.uitest.base.BaseUiTest
import com.roadsage.app.uitest.base.WaitHelpers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T01_AppLaunchTest : BaseUiTest() {
    @Test
    fun appLaunchesAndRoadSageIsForeground() {
        assertNotNull("Expected Road Sage package window after launch", device.findObject(By.pkg(PACKAGE)))
        assertEquals("Expected Road Sage to be foreground", PACKAGE, device.currentPackageName)
    }

    @Test
    fun topLevelNavigationWorks() {
        assertAnyTextVisible("Expected top-level navigation", "Dashboard", "Trips", "Settings")
        openTrips()
        assertAnyTextVisible("Expected seeded trip list", "completed trips", "Sunday Drive", "Grocery run")
        openSettings()
        assertAnyTextVisible("Expected Settings screen", "Settings", "Tracking", "Privacy")
        openDashboard()
        openTrips()
        pressBack()
        assertAnyTextVisible("Back from Trip History should return to Dashboard", "Dashboard", "Start Trip", "Overall")
    }

    @Test
    fun loadingStateResolvesToAUsableScreen() {
        val resolved = WaitHelpers.retryUntilTrue(attempts = 16, intervalMs = 500) {
            findAnyText("Dashboard", "Trip History", "Settings", "Start Trip", timeoutMs = 250L) != null
        }
        assertTrue("Expected loading state to resolve to an app screen", resolved)
    }
}
