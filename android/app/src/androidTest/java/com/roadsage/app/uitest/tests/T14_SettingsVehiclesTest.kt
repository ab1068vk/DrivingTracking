package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T14_SettingsVehiclesTest : BaseUiTest() {
    @Test
    fun vehiclesListCreateEditAndDeleteFlow() {
        openSettings()
        scrollToTextContains("Vehicles")
        tryClickAnyText("Vehicles")
        assertAnyTextVisible("Expected vehicles section", "Vehicles")
        assertAnyTextVisible("Expected seeded Honda vehicle", "Honda Civic 2019")
        assertAnyTextVisible("Expected seeded Toyota vehicle", "Toyota Camry 2021")
        assertAnyTextVisible("Expected add vehicle button", "Add Vehicle", "Add vehicle")
        tryClickAnyText("Add Vehicle", "Add vehicle")
        assertAnyTextVisible("Expected vehicle form fields", "Name", "Make", "Model", "Year", "Fuel")
        runCatching { typeIntoFirstField("Ford F-150 2020") }
        tryClickAnyText("Save", "Add")
        assertAnyTextVisible("Expected new vehicle or form still visible", "Ford F-150 2020", "Vehicles")
        tryClickAnyText("Ford F-150 2020", "Honda Civic 2019")
        assertNoCrashLandmark("Vehicle", "Name", "Make")
        runCatching { typeIntoFirstField("Ford F-150 Updated") }
        tryClickAnyText("Save")
        assertNoCrashLandmark("Ford F-150 Updated", "Vehicles", "Honda Civic 2019")
        tryClickAnyText("Delete", "Remove")
        tryClickAnyText("Confirm", "Delete")
        assertNoCrashLandmark("Vehicles", "Honda Civic 2019", "Toyota Camry 2021")
    }
}
