package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import org.junit.Test;

/**
 * Regression for PROJECTION-FEED-AFTERSEQ-SILENTLY-IGNORED.
 *
 * Capacitor's PluginCall.getLong(name, fallback) returns the fallback unless the bridged value
 * is exactly a java.lang.Long, and a JS number below 2^31 arrives from the JSON bridge as an
 * Integer. Every 64-bit argument on DriveSenseArchivePlugin was therefore silently replaced by
 * its default. Observed on a physical A54: getProjectionFeed({afterSeq: 20000}) returned seq
 * 1..3, while {afterSeq: 20000000000000} - large enough to deserialize as a Long - was honoured.
 * completeMigration's counters arrived as -1 and DriveSenseArchiveMigration.complete rejected
 * them as "Invalid migration counters".
 */
public class DriveSenseArchivePluginArgumentContractTest {

    private static PluginCall call(JSObject data) {
        return new PluginCall(null, "DriveSenseArchive", "test-call", "test", data);
    }

    @Test
    public void capacitorGetLongStillDropsAJsIntegerSoTheHelperIsRequired() throws Exception {
        JSObject data = new JSObject();
        data.put("afterSeq", 20000);
        PluginCall call = call(data);

        // The defect itself, pinned so the helper is never "simplified" back to getLong.
        assertEquals(Long.valueOf(0L), call.getLong("afterSeq", 0L));
        assertEquals(20000L, DriveSenseArchivePlugin.longArg(call, "afterSeq", 0L));
    }

    @Test
    public void aLongValuedArgumentIsUnchanged() throws Exception {
        JSObject data = new JSObject();
        data.put("afterSeq", 20000000000000L);
        assertEquals(20000000000000L, DriveSenseArchivePlugin.longArg(call(data), "afterSeq", 0L));
    }

    @Test
    public void migrationCountersSurviveTheBridgeAsSentInsteadOfBecomingTheInvalidDefault() throws Exception {
        JSObject data = new JSObject();
        data.put("expectedCount", 1);
        data.put("visitedCount", 1);
        data.put("quarantineCount", 0);
        PluginCall call = call(data);

        assertEquals(1L, DriveSenseArchivePlugin.longArg(call, "expectedCount", -1L));
        assertEquals(1L, DriveSenseArchivePlugin.longArg(call, "visitedCount", -1L));
        assertEquals(0L, DriveSenseArchivePlugin.longArg(call, "quarantineCount", -1L));
    }

    @Test
    public void anAbsentArgumentStillFallsBackAndTheUnknownSizeSentinelIsPreserved() throws Exception {
        JSObject data = new JSObject();
        data.put("expectedBytes", -1);
        PluginCall call = call(data);

        // nativeTripArchive.js sends expectedBytes -1 to mean "size unknown"; the archive treats
        // any value <= 0 as "do not enforce", so this must arrive as -1 and not as the fallback.
        assertEquals(-1L, DriveSenseArchivePlugin.longArg(call, "expectedBytes", 0L));
        assertEquals(8L, DriveSenseArchivePlugin.longArg(call, "maxWorkBytes", 8L));
    }

    @Test
    public void aNumericStringIsAccepted() throws Exception {
        JSObject data = new JSObject();
        data.put("afterSeq", "20000");
        assertEquals(20000L, DriveSenseArchivePlugin.longArg(call(data), "afterSeq", 0L));
    }

    @Test
    public void aMalformedArgumentFailsClosedInsteadOfSilentlyDefaulting() throws Exception {
        JSObject text = new JSObject();
        text.put("afterSeq", "not-a-number");
        assertThrows(IllegalArgumentException.class,
            () -> DriveSenseArchivePlugin.longArg(call(text), "afterSeq", 0L));

        JSObject fractional = new JSObject();
        fractional.put("expectedBytes", 12.5d);
        assertThrows(IllegalArgumentException.class,
            () -> DriveSenseArchivePlugin.longArg(call(fractional), "expectedBytes", 0L));
    }
}
