package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.content.ContentValues;
import android.provider.MediaStore;

import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.lang.reflect.Method;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class DriveSenseBackupRestoreIngressTest {
    @Test
    public void pickerUsesOpenDocumentWithDurableReadGrant() {
        Intent intent = DriveSenseBackupRestorePicker.createIntent();

        assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.getAction());
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0);
    }

    @Test
    public void pickerAdmitsTheMimePublishedByRoadSageAndGenericBinaryFallback() {
        Intent intent = DriveSenseBackupRestorePicker.createIntent();
        ContentValues published = DriveSenseStreamBackupManager.mediaStoreBackupValues("roundtrip.rsb2");
        String publishedMime = published.getAsString(MediaStore.Downloads.MIME_TYPE);
        String[] acceptedMimes = intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES);

        assertEquals(DriveSenseStreamBackupMimeContract.ROAD_SAGE_STREAM_BACKUP, publishedMime);
        assertEquals(DriveSenseStreamBackupMimeContract.PICKER_BASE, intent.getType());
        assertNotNull(acceptedMimes);
        assertTrue(Arrays.asList(acceptedMimes).contains(publishedMime));
        assertTrue(Arrays.asList(acceptedMimes).contains(DriveSenseStreamBackupMimeContract.GENERIC_BINARY));
    }

    @Test
    public void archivePluginExposesAProductionPickerMethod() throws Exception {
        Method method = DriveSenseArchivePlugin.class.getDeclaredMethod(
            "pickStreamBackupRestoreFile",
            PluginCall.class
        );

        assertNotNull(method.getAnnotation(PluginMethod.class));
    }
}
