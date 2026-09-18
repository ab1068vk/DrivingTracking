package com.drivesense.app;

/** MIME contract shared by the RSB2 publisher and Android document picker. */
final class DriveSenseStreamBackupMimeContract {
    static final String ROAD_SAGE_STREAM_BACKUP = "application/vnd.road-sage.stream-backup";
    static final String GENERIC_BINARY = "application/octet-stream";
    static final String PICKER_BASE = "*/*";

    private DriveSenseStreamBackupMimeContract() {}

    static String[] acceptedRestoreMimeTypes() {
        return new String[] { ROAD_SAGE_STREAM_BACKUP, GENERIC_BINARY };
    }
}
