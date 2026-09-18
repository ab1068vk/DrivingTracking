package com.drivesense.app;

import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;
import org.junit.Test;

public class DiagnosticsBuildIdentityTest {
    @Test public void separatesNativeInputVariantAndVersionCodeWithAnUnchangedWebBundle() {
        String baseline = DiagnosticsBuildIdentity.artifactId("source-a", "debug", "none", 3);
        assertNotEquals(baseline, DiagnosticsBuildIdentity.artifactId("source-b", "debug", "none", 3));
        assertNotEquals(baseline, DiagnosticsBuildIdentity.artifactId("source-a", "release", "none", 3));
        assertNotEquals(baseline, DiagnosticsBuildIdentity.artifactId("source-a", "debug", "physicalH", 3));
        assertNotEquals(baseline, DiagnosticsBuildIdentity.artifactId("source-a", "debug", "none", 4));
        assertEquals(baseline, DiagnosticsBuildIdentity.artifactId("source-a", "debug", "none", 3));
    }

    @Test public void attributesOnlyAnExitInsideTheRetainedPriorProcessSession() {
        assertTrue(DiagnosticsBuildIdentity.historicalExitMatchesSession(100L, 110L, "app", "app"));
        assertFalse(DiagnosticsBuildIdentity.historicalExitMatchesSession(0L, 110L, "app", "app"));
        assertFalse(DiagnosticsBuildIdentity.historicalExitMatchesSession(100L, 90L, "app", "app"));
        assertFalse(DiagnosticsBuildIdentity.historicalExitMatchesSession(100L, 110L, "app:other", "app"));
    }
}
