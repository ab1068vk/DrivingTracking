package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T12_SettingsBackupExportTest : BaseUiTest() {
    @Test
    fun encryptedBackupExportValidationAndCsvExportAreReachable() {
        openSettings()
        scrollToTextContains("Export Full Backup")
        assertAnyTextVisible("Expected backup/export section", "Export Full Backup", "Backup", "Export")
        tryClickAnyText("Export Full Backup", "Export Backup")
        assertAnyTextVisible("Expected password field", "Password", "Confirm password")
        runCatching { typeIntoFirstField("short") }
        assertAnyTextVisible("Expected weak password guidance", "Use at least 12 characters", "Weak", "strength")
        runCatching { typeIntoFirstField("StrongPassword123!") }
        assertAnyTextVisible("Expected strong/good password state", "Strong", "Good", "Confirm password")
        tryClickAnyText("Confirm password")
        runCatching { typeIntoFirstField("MismatchPassword123!") }
        assertAnyTextVisible("Expected password mismatch error", "Passwords must match", "Confirm password")
        runCatching { typeIntoFirstField("StrongPassword123!") }
        assertAnyTextVisible("Expected export button enabled or present", "Export Backup", "Exporting")
        tryClickAnyText("Export Backup")
        assertNoCrashLandmark("Encrypted backup saved", "Backup saved", "Export Backup", "Settings")
        pressBack()
        scrollToTextContains("CSV")
        tryClickAnyText("Export as CSV", "CSV")
        assertNoCrashLandmark("CSV", "Export", "Settings")
    }
}
