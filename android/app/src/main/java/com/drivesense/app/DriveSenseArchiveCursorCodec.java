package com.drivesense.app;

import android.content.Context;
import android.util.Base64;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class DriveSenseArchiveCursorCodec {
    static final int MAX_CURSOR_BYTES = 2048;
    private final byte[] key;

    DriveSenseArchiveCursorCodec(Context context) throws Exception { key=loadKey(context); }

    String encode(JSONObject value) throws Exception {
        byte[] data=value.toString().getBytes(StandardCharsets.UTF_8);
        byte[] mac=hmac(data);
        String token=Base64.encodeToString(data,Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING)+"."+
            Base64.encodeToString(mac,Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING);
        if(token.getBytes(StandardCharsets.UTF_8).length>MAX_CURSOR_BYTES) throw new IllegalStateException("Cursor exceeds hard limit");
        return token;
    }

    JSONObject decode(String token) throws Exception {
        if(token==null||token.isEmpty()) return null;
        if(token.getBytes(StandardCharsets.UTF_8).length>MAX_CURSOR_BYTES) throw new IllegalArgumentException("CURSOR_TOO_LARGE");
        String[] parts=token.split("\\.",-1); if(parts.length!=2) throw new IllegalArgumentException("CURSOR_INVALID");
        byte[] data=Base64.decode(parts[0],Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING);
        byte[] supplied=Base64.decode(parts[1],Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING);
        if(!MessageDigest.isEqual(hmac(data),supplied)) throw new SecurityException("CURSOR_AUTH_FAILED");
        return new JSONObject(new String(data,StandardCharsets.UTF_8));
    }

    private byte[] hmac(byte[] data) throws Exception { Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(key,"HmacSHA256"));return mac.doFinal(data); }
    private static byte[] loadKey(Context context) throws Exception {
        File directory=new File(context.getNoBackupFilesDir(),"roadsage_archive_meta");if(!directory.exists()&&!directory.mkdirs())throw new IllegalStateException("Cursor key directory unavailable");
        File file=new File(directory,"cursor_hmac_v1.key");
        if(file.isFile()) { byte[] bytes=Files.readAllBytes(file.toPath()); if(bytes.length==32)return bytes; throw new IllegalStateException("Cursor key invalid"); }
        byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);
        File temp=new File(directory,"cursor_hmac_v1.key.tmp");try(FileOutputStream output=new FileOutputStream(temp,false)){output.write(bytes);output.getFD().sync();}
        if(!temp.renameTo(file))throw new IllegalStateException("Could not publish cursor key");DriveSenseArchiveSentinelStore.fsyncDirectory(directory);return bytes;
    }
}
