package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class P0CallTimingTest {

    /** Deterministic clocks so the arithmetic, not the machine, is under test. */
    private static final class FakeClock implements P0CallTiming.NanoClock, P0CallTiming.WallClock {
        long nanos;
        long wallMs;

        @Override
        public long nanoTime() {
            return nanos;
        }

        @Override
        public long currentTimeMillis() {
            return wallMs;
        }
    }

    private static P0CallTiming timingAt(FakeClock clock, long callId, long sendWallMs) {
        return new P0CallTiming(callId, sendWallMs, clock, clock);
    }

    @Test
    public void totalIsEntryToReadyNotTheSumOfNamedPhases() {
        FakeClock clock = new FakeClock();
        clock.nanos = 1_000_000L;
        clock.wallMs = 5_000L;
        P0CallTiming timing = timingAt(clock, 42L, 4_990L);

        timing.addTransportB64Decode(1_000_000L);
        timing.addTransportAesDecrypt(2_000_000L);
        timing.addMethodWork(3_000_000L);

        // 50 ms of wall-clock work inside native, only 6 ms of it named.
        clock.nanos = 51_000_000L;
        clock.wallMs = 5_050L;
        timing.markResponseReady();

        assertEquals(50_000_000L, timing.totalInternalNanos());
        assertEquals(6_000_000L, timing.namedPhaseTotalNanos());
        // Unnamed native work must remain visible rather than vanishing.
        assertEquals(44_000_000L, timing.namedPhaseResidualNanos());
        assertEquals(50_000.0d, timing.totalInternalMicros(), 0.001d);
        assertEquals(44_000.0d, timing.namedPhaseResidualMicros(), 0.001d);
    }

    @Test
    public void entryToReadyIsNeverNegative() {
        FakeClock clock = new FakeClock();
        clock.nanos = 10_000_000L;
        P0CallTiming timing = timingAt(clock, 1L, 0L);

        // A clock that appears to go backwards must not produce a negative total.
        clock.nanos = 9_000_000L;
        timing.markResponseReady();

        assertEquals(0L, timing.totalInternalNanos());
        assertTrue(timing.totalInternalMicros() >= 0.0d);
    }

    @Test
    public void totalIsZeroUntilResponseIsMarkedReady() {
        FakeClock clock = new FakeClock();
        clock.nanos = 1_000L;
        P0CallTiming timing = timingAt(clock, 1L, 0L);
        clock.nanos = 500_000L;

        assertEquals(0L, timing.totalInternalNanos());
    }

    @Test
    public void markResponseReadyIsIdempotent() {
        FakeClock clock = new FakeClock();
        clock.nanos = 0L;
        clock.wallMs = 100L;
        P0CallTiming timing = timingAt(clock, 1L, 0L);

        clock.nanos = 5_000_000L;
        clock.wallMs = 105L;
        timing.markResponseReady();

        // A second mark (e.g. attachP0 after an explicit mark) must not move it.
        clock.nanos = 900_000_000L;
        clock.wallMs = 1_000L;
        timing.markResponseReady();

        assertEquals(5_000_000L, timing.totalInternalNanos());
        assertEquals(105L, timing.responseReadyWallMs());
    }

    @Test
    public void negativeAndZeroPhaseDurationsAreIgnored() {
        FakeClock clock = new FakeClock();
        P0CallTiming timing = timingAt(clock, 1L, 0L);

        timing.addMethodWork(-5_000L);
        timing.addResponseJson(0L);
        timing.addResponseUtf8(1_000L);

        assertEquals(1_000L, timing.namedPhaseTotalNanos());
        assertEquals(0.0d, timing.methodWorkMicros(), 0.0001d);
    }

    @Test
    public void phaseAccumulatorsAreIndependentAndAdditive() {
        FakeClock clock = new FakeClock();
        P0CallTiming timing = timingAt(clock, 1L, 0L);

        timing.addTransportB64Decode(1_000L);
        timing.addTransportAesDecrypt(2_000L);
        timing.addEnvelopeJsonParse(3_000L);
        timing.addMethodWork(4_000L);
        timing.addResponseJson(5_000L);
        timing.addResponseUtf8(6_000L);
        timing.addResponseAesEncrypt(7_000L);
        timing.addResponseB64Encode(8_000L);
        // Repeated adds accumulate rather than overwrite.
        timing.addMethodWork(4_000L);

        assertEquals(1.0d, timing.transportB64DecodeMicros(), 0.0001d);
        assertEquals(2.0d, timing.transportAesDecryptMicros(), 0.0001d);
        assertEquals(3.0d, timing.envelopeJsonParseMicros(), 0.0001d);
        assertEquals(8.0d, timing.methodWorkMicros(), 0.0001d);
        assertEquals(5.0d, timing.responseJsonMicros(), 0.0001d);
        assertEquals(6.0d, timing.responseUtf8Micros(), 0.0001d);
        assertEquals(7.0d, timing.responseAesEncryptMicros(), 0.0001d);
        assertEquals(8.0d, timing.responseB64EncodeMicros(), 0.0001d);
        assertEquals(40_000L, timing.namedPhaseTotalNanos());
    }

    @Test
    public void echoesTheJsCallIdWithoutInterpretingIt() {
        FakeClock clock = new FakeClock();
        clock.wallMs = 777L;
        P0CallTiming timing = timingAt(clock, 123_456L, 770L);

        assertEquals(123_456L, timing.jsCallId());
        assertEquals(770L, timing.jsSendWallMs());
        assertEquals(777L, timing.entryWallMs());
    }

    @Test
    public void microsecondConversionIsExact() {
        assertEquals(0.0d, P0CallTiming.micros(0L), 0.0d);
        assertEquals(1.0d, P0CallTiming.micros(1_000L), 0.0d);
        assertEquals(1_500.5d, P0CallTiming.micros(1_500_500L), 0.0d);
    }

    // ---------------------------------------------------------------------
    // Probe-off gate. P0 is off unless JS explicitly asked for instrumentation,
    // and the native side must be as free of P0 work as the JS side is —
    // otherwise Arm D still pays native clock, allocation, serialization and
    // delivery cost, and the mandatory A/D overhead comparison understates the
    // probe.
    // ---------------------------------------------------------------------

    @Test
    public void absentOrInvalidMetadataIsNotAnInstrumentedRequest() {
        // An absent or unparseable inbound block degrades to call id 0.
        assertFalse(P0CallTiming.isInstrumentedRequest(0L));
        assertFalse(P0CallTiming.isInstrumentedRequest(-1L));
        assertFalse(P0CallTiming.isInstrumentedRequest(Long.MIN_VALUE));
    }

    @Test
    public void aRealCallIdIsAnInstrumentedRequest() {
        // JS assigns call ids from a counter starting at 1.
        assertTrue(P0CallTiming.isInstrumentedRequest(1L));
        assertTrue(P0CallTiming.isInstrumentedRequest(123_456L));
        assertTrue(P0CallTiming.isInstrumentedRequest(Long.MAX_VALUE));
    }
}
