package com.roadsage.app.uitest.tests

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.roadsage.app.uitest.base.BaseUiTest
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@LargeTest
class T07_TripDetailEditTest : BaseUiTest() {
    @Test
    fun editNicknameNotesTagAndVehicle() {
        openTripByText("Grocery run")
        tryClickAnyText("Edit", "Pencil")
        assertAnyTextVisible("Expected trip-details editor", "Grocery run", "Save trip details", "Nickname")
        runCatching { typeIntoFirstField("Updated nickname") }
        tryClickAnyText("Save trip details", "Save")
        assertAnyTextVisible("Expected updated nickname or saved detail header", "Updated nickname", "Grocery run")

        tryClickAnyText("Edit", "Pencil")
        assertAnyTextVisible("Expected notes field/current notes", "Heavy traffic on King St", "Notes")
        runCatching { typeIntoFirstField("Updated notes text") }
        tryClickAnyText("Save trip details", "Save")
        assertAnyTextVisible("Expected updated notes or original notes", "Updated notes text", "Heavy traffic on King St")

        tryClickAnyText("Edit", "Pencil")
        assertAnyTextVisible("Expected tag selector", "errand", "Tag")
        tryClickAnyText("work", "Work")
        tryClickAnyText("Save trip details", "Save")
        assertAnyTextVisible("Expected work tag after save", "work", "Work")

        tryClickAnyText("Edit", "Pencil")
        assertAnyTextVisible("Expected vehicle picker", "Vehicle", "Honda Civic 2019")
        tryClickAnyText("Honda Civic 2019")
        tryClickAnyText("Save trip details", "Save")
        assertAnyTextVisible("Expected assigned vehicle", "Honda Civic 2019", "Vehicle")
    }

    @Test
    fun cancelEditDoesNotPersistChanges() {
        openTripByText("Grocery run")
        tryClickAnyText("Edit", "Pencil")
        runCatching { typeIntoFirstField("Cancelled nickname") }
        tryClickAnyText("Cancel")
        assertAnyTextVisible("Expected cancel to return to detail", "Grocery run", "Updated nickname", "Overall")
    }
}
