package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T16_SettingsScoringCalibrationTest : BaseUiTest() {
    @Test
    fun scoringCalibrationGlossaryVoiceAndUnitsAreReachable() {
        openSettings()
        scrollToTextContains("Scoring")
        tryClickAnyText("Scoring")
        assertAnyTextVisible("Expected scoring section", "Scoring")
        assertAnyTextVisible("Expected penalty scale control", "Penalty Scale", "Scale Factor", "slider")
        scrollToTextContains("Calibration")
        assertAnyTextVisible("Expected calibration section", "Calibration")
        assertAnyTextVisible("Expected apply calibration button", "Apply Calibration", "calibrate")
        assertAnyTextVisible("Expected score migration/rescore", "migration", "outdated trips", "Re-Score All", "Rescore")
        tryClickAnyText("Re-Score All", "Rescore")
        assertNoCrashLandmark("progress", "Re-score", "Scoring", "Settings")
        assertAnyTextVisible("Expected scoring glossary", "Aggression score", "Defensive score", "Jerk score", "Definitions")
        tryClickAnyText("Aggression score", "Aggression")
        assertNoCrashLandmark("Aggression", "score", "Scoring")
        assertAnyTextVisible("Expected voice test button", "Voice Test", "Voice alert", "Speech")
        tryClickAnyText("Voice Test", "Test voice")
        assertNoCrashLandmark("Voice test sent", "Speech output is unavailable", "Voice")
        assertAnyTextVisible("Expected units toggle", "Metric", "Imperial", "Units")
        tryClickAnyText("Imperial", "Metric")
        assertNoCrashLandmark("Metric", "Imperial", "Settings")
    }
}
