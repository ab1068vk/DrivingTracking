package com.roadsage.app.uitest.seed

import android.content.Context
import android.os.Environment
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiScrollable
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import com.roadsage.app.uitest.base.BaseUiTest
import com.roadsage.app.uitest.base.WaitHelpers
import org.hamcrest.CoreMatchers.containsString
import org.junit.Assert.assertTrue
import java.io.File

/**
 * Writes the fake-trip JSON to the device's Downloads folder, then drives the
 * Road Sage Settings > Import Backup flow to load it.
 */
class BackupSeedHelper(
    private val device: UiDevice,
    private val context: Context
) {
    companion object {
        private const val SEED_FILENAME = "road_sage_test_seed.json"
        private const val FILE_PICKER_PACKAGE = "com.google.android.documentsui"
    }

    fun seedIfNeeded() {
        val seedFile = writeSeedFile()
        launchApp()
        completeOnboardingIfPresent()

        if (seedAlreadyPresent()) return

        openSettings()
        openPrivacyAndData()
        scrollToText("Import Backup")
        clickText("Import Backup")
        chooseSeedFile(seedFile)
        confirmImportDialogs()
        WaitHelpers.retryUntilTrue(attempts = 20, intervalMs = 500) {
            findTextContains("20 trips") != null ||
                findTextContains("trips") != null && findTextContains("merged") != null ||
                findTextContains("Backup") != null
        }
    }

    private fun writeSeedFile(): File {
        val appDownloads = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: context.filesDir
        appDownloads.mkdirs()
        val appFile = File(appDownloads, SEED_FILENAME).apply {
            writeText(FakeTripFactory.buildBackupJson())
        }
        val publicPath = "/sdcard/Download/$SEED_FILENAME"
        device.executeShellCommand("mkdir -p /sdcard/Download")
        device.executeShellCommand("cp ${shellQuote(appFile.absolutePath)} ${shellQuote(publicPath)}")
        return File(publicPath)
    }

    private fun launchApp() {
        wakeAndUnlockDevice()
        device.executeShellCommand("am start -W -n ${BaseUiTest.PACKAGE}/.MainActivity")
        if (!waitForRoadSageSurface()) {
            device.executeShellCommand("monkey -p ${BaseUiTest.PACKAGE} 1")
        }
        assertTrue("Expected Road Sage to launch before seeding", waitForRoadSageSurface())
    }

    private fun completeOnboardingIfPresent() {
        repeat(7) {
            dismissSystemDialogs()
            when {
                findText("Skip for now", 700L) != null -> {
                    clickText("Skip for now")
                    return
                }
                findText("Get Started", 700L) != null -> {
                    clickText("Get Started")
                    return
                }
                findText("Continue", 700L) != null -> clickText("Continue")
                else -> return
            }
        }
    }

    private fun seedAlreadyPresent(): Boolean {
        openTrips()
        return findTextContains("Sunday Drive", 2_000L) != null ||
            findTextContains("Grocery run", 1_000L) != null ||
            findTextContains("20 of", 1_000L) != null
    }

    private fun openTrips() {
        findText("Trips", 2_000L)?.click()
            ?: findText("Trip History", 2_000L)?.click()
            ?: if (webClickText("Trips") || webClickText("Trip History")) null else null
            ?: run {
                openNavigationMenuIfPresent()
                findText("Trips", 2_000L)?.click() ?: findText("Trip History", 2_000L)?.click()
            }
        WaitHelpers.retryUntilTrue(attempts = 10, intervalMs = 500) {
            findTextContains("Trip History", 250L) != null || webHasText("Trip History")
        }
    }

    private fun openSettings() {
        findText("Settings", 2_000L)?.click()
            ?: findTextContains("Settings", 2_000L)?.click()
            ?: if (webClickText("Settings")) null else null
            ?: run {
                openNavigationMenuIfPresent()
                findText("Settings", 2_000L)?.click() ?: findTextContains("Settings", 2_000L)?.click()
            }
            ?: error("Could not open Settings before seeding")
        WaitHelpers.retryUntilTrue(attempts = 10, intervalMs = 500) {
            findTextContains("Settings", 250L) != null || webHasText("Settings")
        }
    }

    private fun openPrivacyAndData() {
        webClickText("Privacy & Data")
        WaitHelpers.retryUntilTrue(attempts = 10, intervalMs = 500) {
            webHasText("Export Full Backup") || webHasText("Import Backup") || findTextContains("Import Backup", 250L) != null
        }
    }

    private fun chooseSeedFile(seedFile: File) {
        device.wait(Until.hasObject(By.pkg(FILE_PICKER_PACKAGE)), 6_000L)
        dismissSystemDialogs()
        findText(SEED_FILENAME, 2_000L)?.click()?.also { return }
        scrollToText(SEED_FILENAME)
        findText(SEED_FILENAME, 2_000L)?.click()?.also { return }
        findTextContains(SEED_FILENAME.removeSuffix(".json"), 2_000L)?.click()?.also { return }
        device.executeShellCommand("am start -a android.intent.action.VIEW -d file://${seedFile.absolutePath} -t application/json")
        findText(SEED_FILENAME, 2_000L)?.click()
    }

    private fun confirmImportDialogs() {
        repeat(8) {
            dismissSystemDialogs()
            findText("OK", 700L)?.click()
            findText("Import", 700L)?.click()
            findText("Allow", 700L)?.click()
            findText("Continue", 700L)?.click()
        }
    }

    private fun scrollToText(text: String) {
        try {
            UiScrollable(UiSelector().scrollable(true)).scrollTextIntoView(text)
        } catch (_: Exception) {
        }
    }

    private fun clickText(text: String) {
        findText(text, 5_000L)?.click()
            ?: if (webClickText(text)) return else null
            ?: error("Could not find text: $text")
    }

    private fun findText(text: String, timeoutMs: Long = 5_000L) =
        WaitHelpers.findWithTimeout(device, By.text(text), timeoutMs)
            ?: WaitHelpers.findWithTimeout(device, By.desc(text), 250L)

    private fun findTextContains(text: String, timeoutMs: Long = 5_000L) =
        WaitHelpers.findWithTimeout(device, By.textContains(text), timeoutMs)
            ?: WaitHelpers.findWithTimeout(device, By.descContains(text), 250L)

    private fun dismissSystemDialogs() {
        arrayOf("OK", "Allow", "While using the app", "Continue", "Not now", "Cancel").forEach { label ->
            WaitHelpers.findWithTimeout(device, By.text(label), 250L)?.click()
        }
    }

    private fun wakeAndUnlockDevice() {
        if (!device.isScreenOn) device.wakeUp()
        device.executeShellCommand("input keyevent KEYCODE_WAKEUP")
        device.executeShellCommand("wm dismiss-keyguard")
        device.executeShellCommand("svc power stayon true")
    }

    private fun waitForRoadSageSurface(): Boolean =
        device.wait(Until.hasObject(By.pkg(BaseUiTest.PACKAGE)), BaseUiTest.LAUNCH_TIMEOUT_MS * 3) ||
            device.wait(Until.hasObject(By.res(BaseUiTest.PACKAGE, "webview")), 2_000L)

    private fun openNavigationMenuIfPresent(): Boolean {
        val menu = WaitHelpers.findWithTimeout(device, By.desc("Open navigation menu"), 750L)
            ?: WaitHelpers.findWithTimeout(device, By.descContains("navigation menu"), 750L)
            ?: WaitHelpers.findWithTimeout(device, By.descContains("menu"), 750L)
        menu?.click()
        return menu != null
    }

    private fun shellQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"

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
            dismissSystemDialogs()
            true
        }.getOrDefault(false)

    private fun textXPath(text: String): String =
        "//*[contains(normalize-space(.), ${xpathLiteral(text)})]"

    private fun xpathLiteral(text: String): String {
        if (!text.contains("'")) return "'$text'"
        val parts = text.split("'").joinToString(", \"'\", ") { "'$it'" }
        return "concat($parts)"
    }
}
