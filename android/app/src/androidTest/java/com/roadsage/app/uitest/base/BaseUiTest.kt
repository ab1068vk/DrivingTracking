package com.roadsage.app.uitest.base

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.UiScrollable
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import com.roadsage.app.uitest.seed.BackupSeedHelper
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.hamcrest.CoreMatchers.containsString

/** Shared base for every Road Sage UI test. */
open class BaseUiTest {

    protected lateinit var device: UiDevice
    protected lateinit var context: Context

    companion object {
        const val PACKAGE = "com.roadsage.app"
        const val LAUNCH_TIMEOUT_MS = 10_000L
        const val ACTION_TIMEOUT_MS = 5_000L
        const val SCROLL_TIMEOUT_MS = 8_000L
        private var seeded = false
    }

    @Before
    fun setUp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        context = ApplicationProvider.getApplicationContext()

        if (!seeded) {
            BackupSeedHelper(device, context).seedIfNeeded()
            seeded = true
        }

        launchApp()
    }

    protected fun launchApp() {
        wakeAndUnlockDevice()
        device.executeShellCommand("am start -W -n $PACKAGE/.MainActivity")
        if (!waitForRoadSageSurface()) {
            device.executeShellCommand("monkey -p $PACKAGE 1")
        }
        assertTrue("Expected Road Sage to launch into foreground", waitForRoadSageSurface())
        handleSystemDialogs()
    }

    /** Navigate to a bottom-tab or top-level route by visible label text. */
    protected fun navigateTo(label: String) {
        findText(label, SCROLL_TIMEOUT_MS)?.click() ?: webClickText(label)
    }

    protected fun openDashboard() {
        clickAnyText("Dashboard", "Road Sage")
        assertAnyTextVisible("Dashboard did not load", "Dashboard", "Overall", "Start Trip")
    }

    protected fun openTrips() {
        clickAnyText("Trips", "Trip History")
        assertAnyTextVisible("Trip History did not load", "Trip History", "completed trips", "No trips yet")
    }

    protected fun openSettings() {
        clickAnyText("Settings")
        assertAnyTextVisible("Settings did not load", "Settings", "Customize your Road Sage experience")
    }

    protected fun openTripByText(text: String) {
        openTrips()
        val row = findTextContains(text, SCROLL_TIMEOUT_MS)
            ?: findText(text, SCROLL_TIMEOUT_MS)
        if (row == null) {
            if (!webClickText(text)) error("Could not find trip containing: $text")
        } else {
            row.click()
        }
        assertAnyTextVisible("Trip detail did not load", "Trip Detail", "Overall", "Back to trips")
    }

    /** Scroll until a view with the given text is visible, then return it. */
    protected fun scrollToText(text: String): UiObject2? {
        activateLikelySettingsGroupFor(text)
        scrollTextIntoView(text)
        return findText(text, SCROLL_TIMEOUT_MS)
    }

    protected fun scrollToTextContains(partial: String): UiObject2? {
        activateLikelySettingsGroupFor(partial)
        scrollTextIntoView(partial)
        return findTextContains(partial, SCROLL_TIMEOUT_MS)
    }

    protected fun clickText(text: String) {
        findText(text, ACTION_TIMEOUT_MS)?.click()
            ?: if (webClickText(text)) return else null
            ?: error("Could not find clickable text: $text")
    }

    protected fun clickTextContains(text: String) {
        findTextContains(text, ACTION_TIMEOUT_MS)?.click()
            ?: if (webClickText(text)) return else null
            ?: error("Could not find clickable text containing: $text")
    }

    protected fun clickAnyText(vararg texts: String): UiObject2 {
        texts.forEach { text ->
            findText(text, 1_000L)?.let {
                it.click()
                handleSystemDialogs()
                return it
            }
        }
        texts.forEach { text ->
            findTextContains(text, SCROLL_TIMEOUT_MS)?.let {
                it.click()
                handleSystemDialogs()
                return it
            }
        }
        openNavigationMenuIfPresent()
        texts.forEach { text ->
            findText(text, 1_000L)?.let {
                it.click()
                handleSystemDialogs()
                return it
            }
            findTextContains(text, 1_000L)?.let {
                it.click()
                handleSystemDialogs()
                return it
            }
        }
        texts.forEach { text ->
            if (webClickText(text)) {
                return device.wait(Until.findObject(By.res(PACKAGE, "webview")), ACTION_TIMEOUT_MS)
                    ?: error("Clicked web text but WebView disappeared: $text")
            }
            if (activateLikelySettingsGroupFor(text) && webClickText(text)) {
                return device.wait(Until.findObject(By.res(PACKAGE, "webview")), ACTION_TIMEOUT_MS)
                    ?: error("Clicked web text but WebView disappeared: $text")
            }
        }
        error("Could not find any clickable text: ${texts.joinToString()}")
    }

    protected fun tryClickAnyText(vararg texts: String): Boolean {
        texts.forEach { text ->
            findText(text, 750L)?.let {
                it.click()
                handleSystemDialogs()
                return true
            }
        }
        texts.forEach { text ->
            findTextContains(text, 750L)?.let {
                it.click()
                handleSystemDialogs()
                return true
            }
        }
        texts.forEach { text ->
            if (webClickText(text)) return true
            if (activateLikelySettingsGroupFor(text) && webClickText(text)) return true
        }
        return false
    }

    protected fun openNavigationMenuIfPresent(): Boolean {
        val menu = WaitHelpers.findWithTimeout(device, By.desc("Open navigation menu"), 750L)
            ?: WaitHelpers.findWithTimeout(device, By.descContains("navigation menu"), 750L)
            ?: WaitHelpers.findWithTimeout(device, By.descContains("menu"), 750L)
        menu?.click()
        return menu != null
    }

    protected fun assertTextVisible(text: String) {
        val obj = findText(text, ACTION_TIMEOUT_MS)
        assertTrue("Expected text '$text' to be visible but it was not found", obj != null || webHasText(text))
    }

    protected fun assertTextContainsVisible(partial: String) {
        val obj = findTextContains(partial, ACTION_TIMEOUT_MS)
        assertTrue("Expected textContains '$partial' to be visible but it was not found", obj != null || webHasText(partial))
    }

    protected fun assertAnyTextVisible(message: String, vararg candidates: String) {
        assertTrue(message, findAnyText(*candidates) != null || candidates.any { webHasText(it) })
    }

    protected fun assertAnyTextEventually(message: String, vararg candidates: String) {
        assertTrue(message, WaitHelpers.retryUntilTrue(attempts = 12, intervalMs = 500) {
            findAnyText(*candidates, timeoutMs = 250L) != null || candidates.any { webHasText(it) }
        })
    }

    protected fun assertNoCrashLandmark(vararg landmarks: String) {
        assertAnyTextEventually("Expected the app to remain responsive", *landmarks)
    }

    protected fun typeIntoFirstField(text: String, clear: Boolean = true) {
        val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), ACTION_TIMEOUT_MS)
            ?: device.wait(Until.findObject(By.clazz("android.webkit.WebView")), ACTION_TIMEOUT_MS)
            ?: error("No text input field was visible")
        field.click()
        if (clear) device.pressKeyCode(android.view.KeyEvent.KEYCODE_MOVE_END)
        if (clear) repeat(80) { device.pressDelete() }
        device.executeShellCommand("input text ${shellText(text)}")
    }

    protected fun findText(text: String, timeoutMs: Long = ACTION_TIMEOUT_MS): UiObject2? =
        WaitHelpers.findWithTimeout(device, By.text(text), timeoutMs)
            ?: WaitHelpers.findWithTimeout(device, By.desc(text), 250L)

    protected fun findTextContains(text: String, timeoutMs: Long = ACTION_TIMEOUT_MS): UiObject2? =
        WaitHelpers.findWithTimeout(device, By.textContains(text), timeoutMs)
            ?: WaitHelpers.findWithTimeout(device, By.descContains(text), 250L)

    protected fun findAnyText(vararg candidates: String, timeoutMs: Long = ACTION_TIMEOUT_MS): UiObject2? {
        candidates.forEach { candidate ->
            findText(candidate, timeoutMs)?.let { return it }
            findTextContains(candidate, 300L)?.let { return it }
            if (webHasText(candidate)) {
                return device.wait(Until.findObject(By.res(PACKAGE, "webview")), ACTION_TIMEOUT_MS)
            }
        }
        return null
    }

    protected fun objectCount(selector: BySelector): Int = device.findObjects(selector).size

    protected fun pressBack() {
        device.pressBack()
        handleSystemDialogs()
    }

    protected fun handleSystemDialogs() {
        val buttons = arrayOf("OK", "Allow", "While using the app", "Continue", "Not now", "Cancel")
        buttons.forEach { label ->
            WaitHelpers.findWithTimeout(device, By.text(label), 300L)?.click()
        }
    }

    private fun wakeAndUnlockDevice() {
        if (!device.isScreenOn) device.wakeUp()
        device.executeShellCommand("input keyevent KEYCODE_WAKEUP")
        device.executeShellCommand("wm dismiss-keyguard")
        device.executeShellCommand("svc power stayon true")
    }

    private fun waitForRoadSageSurface(): Boolean =
        device.wait(Until.hasObject(By.pkg(PACKAGE)), LAUNCH_TIMEOUT_MS * 3) ||
            device.wait(Until.hasObject(By.res(PACKAGE, "webview")), 2_000L)

    private fun scrollTextIntoView(text: String) {
        val scrollable = UiScrollable(UiSelector().scrollable(true))
        try {
            scrollable.scrollTextIntoView(text)
        } catch (_: Exception) {
        }
    }

    private fun shellText(text: String): String =
        text.replace(" ", "%s")
            .replace("&", "\\&")
            .replace("'", "\\'")
            .replace("\"", "\\\"")

    private fun webHasText(text: String): Boolean =
        runCatching {
            onWebView()
                .forceJavascriptEnabled()
                .withElement(findElement(Locator.XPATH, textXPath(text)))
                .check(webMatches(getText(), containsString(text)))
            true
        }.getOrDefault(false)

    private fun webClickText(text: String): Boolean {
        val leafXPath = "//*[contains(normalize-space(.), ${xpathLiteral(text)}) " +
            "and not(.//*[contains(normalize-space(.), ${xpathLiteral(text)})])]"
        return webClickXPath(leafXPath) || webClickXPath(textXPath(text))
    }

    private fun webClickXPath(xpath: String): Boolean =
        runCatching {
            onWebView()
                .forceJavascriptEnabled()
                .withElement(findElement(Locator.XPATH, xpath))
                .perform(webClick())
            handleSystemDialogs()
            true
        }.getOrDefault(false)

    private fun textXPath(text: String): String =
        "//*[contains(normalize-space(.), ${xpathLiteral(text)})]"

    private fun xpathLiteral(text: String): String {
        if (!text.contains("'")) return "'$text'"
        val parts = text.split("'").joinToString(", \"'\", ") { "'$it'" }
        return "concat($parts)"
    }

    private fun activateLikelySettingsGroupFor(text: String): Boolean {
        val group = when {
            text.contains("Import", ignoreCase = true) ||
                text.contains("Export", ignoreCase = true) ||
                text.contains("Backup", ignoreCase = true) ||
                text.contains("Retention", ignoreCase = true) ||
                text.contains("Factory Reset", ignoreCase = true) ||
                text.contains("Delete ALL", ignoreCase = true) -> "Privacy & Data"
            text.contains("Vehicle", ignoreCase = true) ||
                text.contains("Honda", ignoreCase = true) ||
                text.contains("Toyota", ignoreCase = true) ||
                text.contains("Ford", ignoreCase = true) ||
                text.contains("Imperial", ignoreCase = true) ||
                text.contains("Metric", ignoreCase = true) -> "Appearance"
            text.contains("Voice", ignoreCase = true) ||
                text.contains("Notification", ignoreCase = true) ||
                text.contains("Quick Settings", ignoreCase = true) -> "Notifications"
            text.contains("OSRM", ignoreCase = true) ||
                text.contains("Map matching", ignoreCase = true) ||
                text.contains("Speed Limit", ignoreCase = true) ||
                text.contains("Calibration", ignoreCase = true) ||
                text.contains("Penalty", ignoreCase = true) ||
                text.contains("Aggression", ignoreCase = true) -> "Scoring"
            else -> null
        } ?: return false
        return webClickText(group)
    }
}
