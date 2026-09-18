package com.drivesense.app;

import android.content.Intent;

/** Reviewed Android document ingress for native, bounded RSB2 restore. */
final class DriveSenseBackupRestorePicker {
    private DriveSenseBackupRestorePicker() {}

    static Intent createIntent() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(DriveSenseStreamBackupMimeContract.PICKER_BASE);
        intent.putExtra(
            Intent.EXTRA_MIME_TYPES,
            DriveSenseStreamBackupMimeContract.acceptedRestoreMimeTypes()
        );
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        return intent;
    }
}
