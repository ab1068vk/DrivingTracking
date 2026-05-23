package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DriveSenseNativeTripStoreInstrumentedTest {
    private Context context;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @After
    public void tearDown() {
        DriveSenseNativeTripStore.prefs(context).edit().clear().commit();
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test
    public void packageNameMatchesConfiguredApplicationId() {
        assertEquals("com.drivesense.app", context.getPackageName());
    }

    @Test
    public void serviceEnabledFlagPersists() {
        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));

        DriveSenseNativeTripStore.setServiceEnabled(context, true);

        assertTrue(DriveSenseNativeTripStore.isServiceEnabled(context));
    }

    @Test
    public void completedTripsRecoverFromMalformedStorage() throws Exception {
        SharedPreferences prefs = DriveSenseNativeTripStore.prefs(context);
        prefs.edit().putString("completed_trips", "{not-json").commit();

        assertEquals(0, DriveSenseNativeTripStore.getCompletedTrips(context).length());

        JSONObject trip = new JSONObject();
        trip.put("id", "native-trip-1");
        DriveSenseNativeTripStore.addCompletedTrip(context, trip);

        JSONArray trips = DriveSenseNativeTripStore.getCompletedTrips(context);
        assertEquals(1, trips.length());
        assertEquals("native-trip-1", trips.getJSONObject(0).getString("id"));
    }

    @Test
    public void diagnosticEventsArePrependedAndCapped() throws Exception {
        for (int i = 0; i < 125; i++) {
            JSONObject event = new JSONObject();
            event.put("type", "event_" + i);
            DriveSenseNativeTripStore.addDiagnosticEvent(context, event);
        }

        JSONArray events = DriveSenseNativeTripStore.getDiagnosticEvents(context);
        assertEquals(120, events.length());
        assertEquals("event_124", events.getJSONObject(0).getString("type"));
    }

    @Test
    public void lastParkedLocationFallsBackToSharedCapacitorStorage() throws Exception {
        JSONObject parked = new JSONObject();
        parked.put("lat", 43.65);
        parked.put("lng", -79.38);
        context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .edit()
            .putString("drivesense_last_parked", parked.toString())
            .commit();

        JSONObject restored = DriveSenseNativeTripStore.getLastParkedLocation(context);

        assertNotNull(restored);
        assertEquals(43.65, restored.getDouble("lat"), 0.0001);
        assertEquals(-79.38, restored.getDouble("lng"), 0.0001);
    }

    @Test
    public void invalidLastParkedPayloadReturnsNull() {
        DriveSenseNativeTripStore.prefs(context)
            .edit()
            .putString("last_parked_location", "not-json")
            .commit();

        assertNull(DriveSenseNativeTripStore.getLastParkedLocation(context));
    }
}
