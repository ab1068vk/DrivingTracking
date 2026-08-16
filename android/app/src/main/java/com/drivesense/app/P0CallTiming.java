package com.drivesense.app;

/**
 * P0 native timing for one secure-bridge call.
 *
 * Measured from plugin-method entry — the observable post-dispatch boundary —
 * to immediately before {@code call.resolve}. The plugin serializes it into an
 * outer {@code _p0} envelope field that sits OUTSIDE the AES-GCM ciphertext and
 * outside the AAD, so encryption, AAD, nonce handling and replay behaviour are
 * unchanged by its presence.
 *
 * The block is explicitly unauthenticated and diagnostic-only. JavaScript never
 * trusts it for any crypto or control decision and strips it before returning a
 * caller-visible plaintext result.
 *
 * It carries no plaintext, context, key, nonce, crypto session id or payload
 * content — only durations, two wall-clock stamps, and the call id JS supplied.
 *
 * Deliberately free of Android and JSON dependencies so the arithmetic is
 * unit-testable off-device; the clock is injected.
 */
final class P0CallTiming {

    /** Monotonic nanosecond source. Injected so tests are deterministic. */
    interface NanoClock {
        long nanoTime();
    }

    /** Wall-clock millisecond source. Injected so tests are deterministic. */
    interface WallClock {
        long currentTimeMillis();
    }

    private final NanoClock nanoClock;
    private final WallClock wallClock;

    private final long entryNanos;
    private final long entryWallMs;
    private long readyNanos;
    private long readyWallMs;

    private long transportB64DecodeNanos;
    private long transportAesDecryptNanos;
    private long envelopeJsonParseNanos;
    private long methodWorkNanos;
    private long responseJsonNanos;
    private long responseUtf8Nanos;
    private long responseAesEncryptNanos;
    private long responseB64EncodeNanos;

    /** Echoed back so JS can join this block to its span. Never interpreted. */
    private final long jsCallId;
    private final long jsSendWallMs;

    /**
     * Whether a call carrying this inbound call id should be instrumented at all.
     *
     * <p>P0 is probe-off unless JS explicitly says otherwise. With the probe off — Arm D and every
     * release build — the native side must construct no timing object, read no clocks, and attach no
     * outbound block, exactly as the JS side allocates nothing. Otherwise Arm D still pays native
     * clock, allocation, Capacitor serialization, delivery and JS-parse cost, and the mandatory A/D
     * overhead comparison silently measures a smaller difference than really exists.
     *
     * <p>A valid instrumented call id is strictly positive: JS assigns them from a counter starting
     * at 1, and absent/unparseable metadata degrades to 0.
     */
    static boolean isInstrumentedRequest(long jsCallId) {
        return jsCallId > 0L;
    }

    P0CallTiming(long jsCallId, long jsSendWallMs, NanoClock nanoClock, WallClock wallClock) {
        this.jsCallId = jsCallId;
        this.jsSendWallMs = jsSendWallMs;
        this.nanoClock = nanoClock;
        this.wallClock = wallClock;
        this.entryNanos = nanoClock.nanoTime();
        this.entryWallMs = wallClock.currentTimeMillis();
    }

    long nanoTime() {
        return nanoClock.nanoTime();
    }

    void addTransportB64Decode(long nanos) { transportB64DecodeNanos += atLeastZero(nanos); }

    void addTransportAesDecrypt(long nanos) { transportAesDecryptNanos += atLeastZero(nanos); }

    void addEnvelopeJsonParse(long nanos) { envelopeJsonParseNanos += atLeastZero(nanos); }

    void addMethodWork(long nanos) { methodWorkNanos += atLeastZero(nanos); }

    void addResponseJson(long nanos) { responseJsonNanos += atLeastZero(nanos); }

    void addResponseUtf8(long nanos) { responseUtf8Nanos += atLeastZero(nanos); }

    void addResponseAesEncrypt(long nanos) { responseAesEncryptNanos += atLeastZero(nanos); }

    void addResponseB64Encode(long nanos) { responseB64EncodeNanos += atLeastZero(nanos); }

    /** Called immediately before {@code call.resolve}. Idempotent. */
    void markResponseReady() {
        if (readyNanos > 0L) return;
        readyNanos = nanoClock.nanoTime();
        readyWallMs = wallClock.currentTimeMillis();
    }

    long jsCallId() { return jsCallId; }

    long jsSendWallMs() { return jsSendWallMs; }

    long entryWallMs() { return entryWallMs; }

    long responseReadyWallMs() { return readyWallMs; }

    long namedPhaseTotalNanos() {
        return transportB64DecodeNanos
            + transportAesDecryptNanos
            + envelopeJsonParseNanos
            + methodWorkNanos
            + responseJsonNanos
            + responseUtf8Nanos
            + responseAesEncryptNanos
            + responseB64EncodeNanos;
    }

    /**
     * Entry-to-ready, the authoritative total. Deliberately NOT the sum of named
     * phases, so unnamed native work can never silently vanish.
     */
    long totalInternalNanos() {
        if (readyNanos <= 0L) return 0L;
        return atLeastZero(readyNanos - entryNanos);
    }

    /** Time inside native that no named phase accounts for. */
    long namedPhaseResidualNanos() {
        return totalInternalNanos() - namedPhaseTotalNanos();
    }

    double transportB64DecodeMicros() { return micros(transportB64DecodeNanos); }

    double transportAesDecryptMicros() { return micros(transportAesDecryptNanos); }

    double envelopeJsonParseMicros() { return micros(envelopeJsonParseNanos); }

    double methodWorkMicros() { return micros(methodWorkNanos); }

    double responseJsonMicros() { return micros(responseJsonNanos); }

    double responseUtf8Micros() { return micros(responseUtf8Nanos); }

    double responseAesEncryptMicros() { return micros(responseAesEncryptNanos); }

    double responseB64EncodeMicros() { return micros(responseB64EncodeNanos); }

    double totalInternalMicros() { return micros(totalInternalNanos()); }

    double namedPhaseTotalMicros() { return micros(namedPhaseTotalNanos()); }

    double namedPhaseResidualMicros() { return micros(namedPhaseResidualNanos()); }

    static double micros(long nanos) {
        return nanos / 1000.0d;
    }

    private static long atLeastZero(long value) {
        return value > 0L ? value : 0L;
    }
}
