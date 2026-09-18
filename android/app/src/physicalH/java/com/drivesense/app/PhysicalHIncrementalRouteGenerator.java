package com.drivesense.app;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

/** Deterministic one-point-at-a-time generator with constant resident state. */
public final class PhysicalHIncrementalRouteGenerator {
    public static final int MAXIMUM_GENERATOR_RESIDENT_POINTS = 1;

    public interface PointSink { boolean append(JSONObject point) throws Exception; }

    private final long seed;
    private final long startMs;
    private final int paddingBytes;
    private final long stopStartPoint;
    private final long stopPointCount;
    private long nextIndex;
    private long generatedBytes;
    private double generatedDistanceMetres;
    private byte[] rollingHash = new byte[32];
    private boolean hasPrevious;
    private double previousLat;
    private double previousLng;

    public PhysicalHIncrementalRouteGenerator(long seed, long startMs, int paddingBytes) {
        this(seed, startMs, paddingBytes, -1L, 0L);
    }

    public PhysicalHIncrementalRouteGenerator(long seed, long startMs, int paddingBytes,
                                               long stopStartPoint, long stopPointCount) {
        if (paddingBytes < 0 || paddingBytes > 16 * 1024) throw new IllegalArgumentException("PHYSICAL_H_PADDING_OUT_OF_RANGE");
        if (stopPointCount < 0L || (stopPointCount > 0L && stopStartPoint < 1L)) {
            throw new IllegalArgumentException("PHYSICAL_H_STOP_WINDOW_INVALID");
        }
        this.seed = seed;
        this.startMs = startMs;
        this.paddingBytes = paddingBytes;
        this.stopStartPoint = stopStartPoint;
        this.stopPointCount = stopPointCount;
    }

    public GeneratedPoint appendNext(PointSink sink) throws Exception {
        long index = nextIndex;
        boolean stopped = stopPointCount > 0L && index >= stopStartPoint
            && index < stopStartPoint + stopPointCount;
        long coordinateIndex = stopped ? stopStartPoint : index;
        long mixed = mix64(seed + coordinateIndex * 0x9E3779B97F4A7C15L);
        double north = ((mixed >>> 11) & 0xffffL) / 65535d;
        double east = ((mixed >>> 27) & 0xffffL) / 65535d;
        double lat = 43.60d + ((coordinateIndex % 200_000L) * 0.000004d) + north * 0.0000001d;
        double lng = -79.40d + ((coordinateIndex % 25L) * 0.000002d) + east * 0.0000001d;
        JSONObject point = new JSONObject();
        point.put("lat", lat);
        point.put("lng", lng);
        point.put("timestamp", startMs + index * 1000L);
        point.put("speed_kmh", stopped ? 0d : 48d + ((mixed >>> 43) & 7L));
        point.put("accuracy", 4d + ((mixed >>> 51) & 3L));
        if (paddingBytes > 0) point.put("source_padding", deterministicPadding(index));

        byte[] encoded = point.toString().getBytes(StandardCharsets.UTF_8);
        if (!sink.append(point)) throw new IllegalStateException("PHYSICAL_H_PRODUCER_APPEND_REFUSED");
        rollingHash = chainHash(rollingHash, encoded);
        generatedBytes += encoded.length + 1L;
        if (hasPrevious) generatedDistanceMetres += distanceMetres(previousLat, previousLng, lat, lng);
        previousLat = lat;
        previousLng = lng;
        hasPrevious = true;
        nextIndex++;
        return new GeneratedPoint(index, encoded.length + 1, rollingHash);
    }

    public boolean reached(long targetPoints, long targetBytes, double targetDistanceMetres) {
        boolean points = targetPoints <= 0 || nextIndex >= targetPoints;
        boolean bytes = targetBytes <= 0 || generatedBytes >= targetBytes;
        boolean distance = targetDistanceMetres <= 0 || generatedDistanceMetres >= targetDistanceMetres;
        return points && bytes && distance;
    }

    public long pointCount() { return nextIndex; }
    public long generatedBytes() { return generatedBytes; }
    public double generatedDistanceMetres() { return generatedDistanceMetres; }
    public String rollingHashHex() { return hex(rollingHash); }

    private String deterministicPadding(long index) {
        char[] value = new char[paddingBytes];
        char letter = (char) ('a' + Math.floorMod(seed + index, 26));
        Arrays.fill(value, letter);
        return new String(value);
    }

    private static byte[] chainHash(byte[] prior, byte[] point) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update(prior);
        digest.update(ByteBuffer.allocate(Long.BYTES).order(ByteOrder.BIG_ENDIAN).putLong(point.length).array());
        digest.update(point);
        return digest.digest();
    }

    private static long mix64(long value) {
        value = (value ^ (value >>> 30)) * 0xbf58476d1ce4e5b9L;
        value = (value ^ (value >>> 27)) * 0x94d049bb133111ebL;
        return value ^ (value >>> 31);
    }

    private static double distanceMetres(double lat1, double lng1, double lat2, double lng2) {
        double latRad1 = Math.toRadians(lat1);
        double latRad2 = Math.toRadians(lat2);
        double dLat = latRad2 - latRad1;
        double dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2d) * Math.sin(dLat / 2d) +
            Math.cos(latRad1) * Math.cos(latRad2) * Math.sin(dLng / 2d) * Math.sin(dLng / 2d);
        return 6_371_000d * 2d * Math.atan2(Math.sqrt(a), Math.sqrt(1d - a));
    }

    private static String hex(byte[] value) {
        StringBuilder out = new StringBuilder(value.length * 2);
        for (byte item : value) out.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return out.toString();
    }

    public static final class GeneratedPoint {
        public final long index;
        public final int encodedBytes;
        public final String rollingHash;
        GeneratedPoint(long index, int encodedBytes, byte[] rollingHash) {
            this.index = index;
            this.encodedBytes = encodedBytes;
            this.rollingHash = hex(rollingHash);
        }
    }
}
