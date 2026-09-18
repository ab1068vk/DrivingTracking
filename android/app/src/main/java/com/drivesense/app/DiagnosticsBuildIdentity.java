package com.drivesense.app;

import java.util.UUID;

/** Packaged-build and anonymous process attribution; no installation/device identity. */
final class DiagnosticsBuildIdentity {
    static final String PROCESS_SESSION_ID = "native-launch-" + UUID.randomUUID();

    private DiagnosticsBuildIdentity() {}

    static String artifactId(String sourceId, String buildType, String flavor, int versionCode) {
        return sourceId + ":" + buildType + ":" + flavor + ":vc" + versionCode;
    }

    static String currentArtifactId() {
        return artifactId(BuildConfig.ROAD_SAGE_BUILD_SOURCE_ID, BuildConfig.BUILD_TYPE,
            BuildConfig.ROAD_SAGE_BUILD_FLAVOR, BuildConfig.VERSION_CODE);
    }

    static boolean historicalExitMatchesSession(long sessionStartedAt, long exitAt,
        String processName, String packageName) {
        return sessionStartedAt > 0L && exitAt >= sessionStartedAt
            && packageName.equals(processName);
    }
}
