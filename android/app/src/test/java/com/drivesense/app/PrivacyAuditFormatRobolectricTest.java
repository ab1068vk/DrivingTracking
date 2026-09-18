package com.drivesense.app;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=35)
public class PrivacyAuditFormatRobolectricTest {
    private Context context;
    @Test public void v3V26InventoryRetainsFourJobsAndAddsOnlyFifthExplicitAuditUpgrade() {
        assertEquals(4,DriveSenseP5Ownership.LIFECYCLE_JOBS.size());
        assertEquals(5,DriveSenseP5Ownership.EXPLICIT_OPERATIONS.size());
        assertEquals("hashChainLog",DriveSenseP5Ownership.EXPLICIT_OPERATIONS.get("runPrivacyAuditCompatibilityUpgrade"));
    }
    @Before public void setup() throws Exception {
        context=ApplicationProvider.getApplicationContext();
        for(String suffix:new String[]{"",".bak",".new"}) Files.deleteIfExists(new File(context.getNoBackupFilesDir(),PrivacyAuditFormatStore.FILE_NAME+suffix).toPath());
        Files.deleteIfExists(PrivacyAuditFormatStore.preferenceFile(context,false).toPath());
        Files.deleteIfExists(PrivacyAuditFormatStore.preferenceFile(context,true).toPath());
    }
    @Test public void v26FreshFileMetadataProvenanceIsBeforeActualWebViewSuperCall() throws Exception {
        File configured=context.getSharedPreferences(PrivacyAuditFormatStore.PREFERENCES_GROUP,0)==null?null:PrivacyAuditFormatStore.preferenceFile(context,false);
        assertNotNull(configured);assertEquals("CapacitorStorage.xml",configured.getName());
        PrivacyAuditFormatStore.initializeBeforeWebView(context);
        JSONObject first=PrivacyAuditFormatStore.read(context);assertEquals("FRESH_PENDING",first.getJSONObject("fence").getString("state"));
        assertEquals(1,first.getInt("itemsWorked"));assertTrue(first.getLong("bytesWorked")<=512);
        // Later Preferences writers must not downgrade the established fence.
        context.getSharedPreferences("CapacitorStorage",0).edit().putString("large-ledger","later").commit();
        PrivacyAuditFormatStore.initializeBeforeWebView(context);assertEquals(first.toString(),PrivacyAuditFormatStore.read(context).toString());
        File source=new File("src/main/java/com/drivesense/app/MainActivity.java");
        String text=new String(Files.readAllBytes(source.toPath()),StandardCharsets.UTF_8);
        assertTrue(text.indexOf("PrivacyAuditFormatStore.initializeBeforeWebView(this)")<text.indexOf("super.onCreate(savedInstanceState)"));
    }
    @Test public void v26EitherPreferencesFileIncludingUnparseableContentIsUnknown() throws Exception {
        for(boolean backup:new boolean[]{false,true}){
            setup();File preference=PrivacyAuditFormatStore.preferenceFile(context,backup);assertTrue(preference.getParentFile().isDirectory()||preference.getParentFile().mkdirs());
            Files.write(preference.toPath(),("not XML; must never parse "+"x".repeat(100000)).getBytes(StandardCharsets.UTF_8));
            PrivacyAuditFormatStore.initializeBeforeWebView(context);
            assertEquals("LEGACY_AUDIT_UNKNOWN",PrivacyAuditFormatStore.read(context).getJSONObject("fence").getString("state"));
        }
    }
    @Test public void v26ReadyFenceIsAtomicBoundedAndNeverGuessesFreshAfterLoss() throws Exception {
        assertEquals("LEGACY_AUDIT_UNKNOWN",PrivacyAuditFormatStore.read(context).getJSONObject("fence").getString("state"));
        JSONObject ready=new JSONObject().put("state","V2").put("ledgerId","a".repeat(32));
        assertFalse(PrivacyAuditFormatStore.write(context,ready).has("error"));
        PrivacyAuditFormatStore.initializeBeforeWebView(context);assertEquals(ready.toString(),PrivacyAuditFormatStore.read(context).getJSONObject("fence").toString());
        File marker=new File(context.getNoBackupFilesDir(),PrivacyAuditFormatStore.FILE_NAME);
        Files.write(marker.toPath(),"x".repeat(10000).getBytes(StandardCharsets.UTF_8));
        JSONObject rejected=PrivacyAuditFormatStore.read(context);assertEquals("AUDIT_FORMAT_INVALID",rejected.getString("error"));assertEquals(514,rejected.getLong("bytesWorked"));
        PrivacyAuditFormatStore.initializeBeforeWebView(context);assertEquals("AUDIT_FORMAT_INVALID",PrivacyAuditFormatStore.read(context).getString("error"));
    }
}
