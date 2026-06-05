package com.roadsage.app.uitest

import com.roadsage.app.uitest.tests.*
import org.junit.runner.RunWith
import org.junit.runners.Suite

@RunWith(Suite::class)
@Suite.SuiteClasses(
    T01_AppLaunchTest::class,
    T02_DashboardTest::class,
    T03_TripHistoryTest::class,
    T04_TripDetailTest::class,
    T05_TripDetailEventsTest::class,
    T06_TripDetailMapTest::class,
    T07_TripDetailEditTest::class,
    T08_TripDetailSplitDeleteTest::class,
    T09_SettingsNavigationTest::class,
    T10_SettingsTrackingTest::class,
    T11_SettingsPrivacyZoneTest::class,
    T12_SettingsBackupExportTest::class,
    T13_SettingsBackupImportTest::class,
    T14_SettingsVehiclesTest::class,
    T15_SettingsDataManagementTest::class,
    T16_SettingsScoringCalibrationTest::class,
    T17_SettingsOsrmTest::class,
    T18_SurveyPageTest::class,
    T19_NavigationFlowTest::class
)
class RoadSageFullSuite
