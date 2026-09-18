package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.util.Base64;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class DriveSenseP35SpeedBatchFaultRobolectricTest {
    private Context context;
    private DriveSenseSpeedArchiveRepository repository;

    @Before public void setUp() throws Exception {
        context=ApplicationProvider.getApplicationContext();
        deleteTree(new File(context.getNoBackupFilesDir(),"roadsage_archive_v1"));
        deleteTree(new File(context.getNoBackupFilesDir(),"roadsage_speed_archive_v1"));
        DriveSenseStorageCoordinator.resetForTests();
        context.deleteDatabase(DriveSenseArchiveOpenHelper.DATABASE_NAME);
        DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(true);
        byte[]key=new byte[32];Arrays.fill(key,(byte)0x5a);DriveSenseEnvelopeCrypto.installTestKek(1,key);Arrays.fill(key,(byte)0);
        DriveSenseStorageAdmission.setAvailableBytesForTests(16L*1024L*1024L*1024L);
        repository=new DriveSenseSpeedArchiveRepository(context);
        write("bcde",1);write("bcdf",1);
    }

    @After public void tearDown(){DriveSenseSpeedArchiveRepository.setFaultPointForTests(null);DriveSenseEnvelopeCrypto.clearTestKeks();DriveSenseStorageAdmission.setAvailableBytesForTests(null);DriveSenseArchiveSentinelStore.setSkipDirectoryFsyncForTests(false);DriveSenseStorageCoordinator.resetForTests();}

    @Test public void everyBucketBatchFaultIsAllOldOrAllNewAndRetryable() throws Exception {
        String[]points={"BEFORE_PENDING","AFTER_PENDING","AFTER_FIRST_BUCKET_PUBLISHED","AFTER_ALL_BUCKETS_PUBLISHED","INSIDE_FINAL_TRANSACTION","AFTER_COMMIT_BEFORE_SENTINEL","AFTER_SENTINEL_BEFORE_CLEANUP"};
        for(String point:points){
            // Return to a known logical baseline through one normal atomic batch.
            writePair(1);
            String batch=stagePair(2);
            DriveSenseSpeedArchiveRepository.setFaultPointForTests(point);
            try{repository.finish(batch);fail("fault must interrupt "+point);}catch(IllegalStateException expected){assertTrue(expected.getMessage().contains("TEST_FAULT_"));}
            repository=new DriveSenseSpeedArchiveRepository(context);
            int left=value("bcde"),right=value("bcdf");
            assertEquals("no mixed logical batch after "+point,left,right);
            if(left==1){repository.finish(batch);}
            assertEquals(2,value("bcde"));assertEquals(2,value("bcdf"));
        }
    }

    private int value(String bucket)throws Exception{return repository.readBucketJson(bucket).getInt("value");}
    private void write(String bucket,int value)throws Exception{String batch=stage(new String[]{bucket},value);repository.finish(batch);}
    private void writePair(int value)throws Exception{repository.finish(stagePair(value));}
    private String stagePair(int value)throws Exception{return stage(new String[]{"bcde","bcdf"},value);}
    private String stage(String[]buckets,int value)throws Exception{
        JSONArray descriptors=new JSONArray();byte[][]payloads=new byte[buckets.length][];
        for(int index=0;index<buckets.length;index++){
            payloads[index]=document(buckets[index],value).toString().getBytes(StandardCharsets.UTF_8);
            descriptors.put(new JSONObject().put("bucketId",buckets[index]).put("expectedBytes",payloads[index].length).put("cellCount",1).put("payloadHash",DriveSenseEnvelopeCrypto.hex(MessageDigest.getInstance("SHA-256").digest(payloads[index]))));
        }
        String batch=repository.begin(descriptors).getString("batchId");
        for(int index=0;index<buckets.length;index++)repository.append(batch,buckets[index],0,Base64.encodeToString(payloads[index],Base64.NO_WRAP));
        return batch;
    }
    private static JSONObject document(String bucket,int value)throws Exception{return new JSONObject().put("bucketId",bucket).put("value",value).put("cells",new JSONObject().put(bucket+"00",new JSONObject().put("limitKmh",value))).put("corrections",new JSONArray()).put("excludedSections",new JSONArray()).put("roadMemory",new JSONObject().put("candidates",new JSONArray()));}
    private static void deleteTree(File file){if(file==null||!file.exists())return;File[]children=file.listFiles();if(children!=null)for(File child:children)deleteTree(child);file.delete();}
}
