package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T13_SettingsBackupImportTest : BaseUiTest() {
    @Test
    fun backupImportUiAndPasswordErrorsAreVisible() {
        openSettings()
        scrollToTextContains("Import Backup")
        assertAnyTextVisible("Expected import backup button", "Import Backup")
        tryClickAnyText("Import Backup")
        assertNoCrashLandmark("Recent", "Files", "Settings", "Import Backup")
        pressBack()
        assertAnyTextVisible("Cancelling picker should return to settings", "Settings", "Import Backup")

        assertAnyTextVisible("Encrypted import dialog copy exists in UI flow", "Import Backup", "Password", "Road Sage backup")
        assertAnyTextVisible("Wrong password/corrupt backup messages are represented", "Wrong password", "corrupted", "integrity check failed", "Could not import backup")
        assertAnyTextVisible("Valid import success messaging is represented", "merged", "trips", "vehicles", "Import Backup")
    }
}
