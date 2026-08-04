package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Covers the tracking-recovery and journal-overflow behaviour added to stop silent trip loss.
 */
@RunWith(AndroidJUnit4.class)
public class DriveSenseTrackingRecoveryInstrumentedTest {
    private Context context;
    private Map<String, Object> nativePrefsSnapshot;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        nativePrefsSnapshot = snapshotPrefs(DriveSenseNativeTripStore.prefs(context));
    }

    @After
    public void tearDown() {
        restorePrefs(DriveSenseNativeTripStore.prefs(context), nativePrefsSnapshot);
    }

    @Test
    public void journalOverflowIsRecordedAndClearedInsteadOfSilentlyDroppingTrips() throws Exception {
        DriveSenseCompletedTripJournal.clearOverflowRecord(context);
        JSONObject before = DriveSenseCompletedTripJournal.getStatus(context);
        assertEquals(0, before.optInt("droppedTripCount", -1));

        Method recordOverflow = DriveSenseCompletedTripJournal.class
            .getDeclaredMethod("recordOverflow", Context.class, String.class);
        recordOverflow.setAccessible(true);
        recordOverflow.invoke(null, context, "entry_limit");
        recordOverflow.invoke(null, context, "entry_limit");

        JSONObject afterOverflow = DriveSenseCompletedTripJournal.getStatus(context);
        assertEquals(2, afterOverflow.optInt("droppedTripCount", -1));
        assertEquals("entry_limit", afterOverflow.optString("droppedReason", ""));
        assertTrue(afterOverflow.optLong("droppedAtMs", 0L) > 0L);

        DriveSenseCompletedTripJournal.clearOverflowRecord(context);
        JSONObject afterClear = DriveSenseCompletedTripJournal.getStatus(context);
        assertEquals(0, afterClear.optInt("droppedTripCount", -1));
    }

    @Test
    public void watchdogDoesNothingWhenTrackingIsTurnedOff() {
        DriveSenseNativeTripStore.setServiceEnabled(context, false);

        // Must not resurrect a service the user deliberately turned off.
        DriveSenseTrackingWatchdog.checkAndRecover(context);

        assertFalse(DriveSenseNativeTripStore.isServiceEnabled(context));
        assertFalse(DriveSenseAutoTrackingService.isRunning());
    }

    @Test
    public void staleReportedSpeedOverADuplicateFixIsTreatedAsNoise() throws Exception {
        Method isNoise = DriveSenseAutoTrackingService.class.getDeclaredMethod(
            "isNoise", double.class, double.class, double.class, double.class, double.class);
        isNoise.setAccessible(true);
        DriveSenseAutoTrackingService service = new DriveSenseAutoTrackingService();

        // Car stopped at a light: two fixes 0.5 m apart while the fused provider still reports
        // a stale 20 km/h. Displacement disagrees, so this must not count as movement.
        boolean duplicateWithStaleSpeed = (boolean) isNoise.invoke(
            service, 0.5d, 0.4d, 20d, 10d, 10d);
        assertTrue(duplicateWithStaleSpeed);

        // Real vehicle movement where reported and implied speed agree stays accepted.
        boolean coherentVehicleStep = (boolean) isNoise.invoke(
            service, 12d, 43d, 45d, 8d, 8d);
        assertFalse(coherentVehicleStep);
    }

    private static Map<String, Object> snapshotPrefs(SharedPreferences prefs) {
        return new HashMap<>(prefs.getAll());
    }

    @SuppressWarnings("unchecked")
    private static void restorePrefs(SharedPreferences prefs, Map<String, Object> snapshot) {
        SharedPreferences.Editor editor = prefs.edit().clear();
        for (Map.Entry<String, Object> entry : snapshot.entrySet()) {
            Object value = entry.getValue();
            if (value instanceof String) {
                editor.putString(entry.getKey(), (String) value);
            } else if (value instanceof Boolean) {
                editor.putBoolean(entry.getKey(), (Boolean) value);
            } else if (value instanceof Integer) {
                editor.putInt(entry.getKey(), (Integer) value);
            } else if (value instanceof Long) {
                editor.putLong(entry.getKey(), (Long) value);
            } else if (value instanceof Float) {
                editor.putFloat(entry.getKey(), (Float) value);
            } else if (value instanceof Set<?>) {
                editor.putStringSet(entry.getKey(), (Set<String>) value);
            }
        }
        editor.commit();
    }
}
