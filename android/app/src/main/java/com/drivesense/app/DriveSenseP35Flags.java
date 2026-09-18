package com.drivesense.app;

/** Release gate. It intentionally remains false until closure and device proof. */
final class DriveSenseP35Flags {
    private static final boolean NATIVE_AUTHORITY_RELEASED = false;
    private static volatile Boolean testOverride;
    private DriveSenseP35Flags() {}
    static boolean nativeAuthorityEnabled(){return testOverride!=null?testOverride:NATIVE_AUTHORITY_RELEASED;}
    static boolean testAuthorityEnabled(){return Boolean.TRUE.equals(testOverride);}
    static void setNativeAuthorityForTests(Boolean enabled){testOverride=enabled;}
}
