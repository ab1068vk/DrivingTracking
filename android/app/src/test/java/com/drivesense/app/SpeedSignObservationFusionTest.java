package com.drivesense.app;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SpeedSignObservationFusionTest {
    @Test
    public void requiresRegulatoryTextAndRepeatedFrames() {
        SpeedSignObservationFusion fusion = new SpeedSignObservationFusion();
        assertNull(fusion.addFrame(Arrays.asList("SPEED LIMIT", "50"), 1_000L));
        SpeedSignObservationFusion.FusedObservation result =
            fusion.addFrame(Arrays.asList("SPEED LIMIT", "50"), 1_600L);

        assertEquals(50, result.displayedValue);
        assertEquals(2, result.frameCount);
        assertTrue(result.confidence >= 0.7d);
    }

    @Test
    public void rejectsBareNumbersAndUnsupportedVehicleOrAdvisorySigns() {
        assertNull(SpeedSignObservationFusion.parseFrame(Collections.singletonList("50")));
        assertNull(SpeedSignObservationFusion.parseFrame(Arrays.asList("MAXIMUM 80", "TRUCK")));
        assertNull(SpeedSignObservationFusion.parseFrame(Arrays.asList("SPEED LIMIT 50", "ADVISORY")));
    }

    @Test
    public void preservesRecognizedConditionalQualifiersForParkedReview() {
        SpeedSignObservationFusion.ParsedFrame school = SpeedSignObservationFusion.parseFrame(
            Arrays.asList("SPEED LIMIT 30", "SCHOOL WHEN FLASHING")
        );
        assertEquals(30, school.value);
        assertEquals("conditional_school_when_flashing", school.qualifierKind);
        assertTrue(school.conditional);

        SpeedSignObservationFusion.ParsedFrame work = SpeedSignObservationFusion.parseFrame(
            Arrays.asList("MAXIMUM 60", "CONSTRUCTION")
        );
        assertEquals("conditional_temporary_work_zone", work.qualifierKind);
    }

    @Test
    public void rejectsAmbiguousValuesAndImplausibleNumbers() {
        assertNull(SpeedSignObservationFusion.parseFrame(Arrays.asList("SPEED LIMIT 50", "80")));
        assertNull(SpeedSignObservationFusion.parseFrame(Collections.singletonList("SPEED LIMIT 7")));
        assertNull(SpeedSignObservationFusion.parseFrame(Collections.singletonList("SPEED LIMIT 135")));
        assertNull(SpeedSignObservationFusion.parseFrame(Collections.singletonList("SPEED LIMIT 53")));
    }

    @Test
    public void acceptsSupportedRegulatoryWording() {
        assertEquals(
            80,
            SpeedSignObservationFusion.parseFrame(Collections.singletonList("MAXIMUM 80")).value
        );
        assertEquals(
            55,
            SpeedSignObservationFusion.parseFrame(Collections.singletonList("MAX SPEED 55")).value
        );
        assertEquals(
            50,
            SpeedSignObservationFusion.parseFrame(Collections.singletonList("SPEED LIM1T 5O")).value
        );
        assertEquals(
            80,
            SpeedSignObservationFusion.parseFrame(Collections.singletonList("MAXIMUN 8O")).value
        );
    }
}
