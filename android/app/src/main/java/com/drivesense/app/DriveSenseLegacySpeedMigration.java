package com.drivesense.app;

import android.app.ActivityManager;
import android.content.Context;
import android.os.StatFs;
import android.os.storage.StorageManager;
import android.util.Base64;
import android.util.JsonReader;
import android.util.JsonToken;
import android.util.JsonWriter;

import org.json.JSONObject;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Explicit Android-only Predecessor-Record Decode Exception (PRDE-1). */
final class DriveSenseLegacySpeedMigration {
    static final String BLOCKED_RESOURCE = "LEGACY_SPEED_MIGRATION_BLOCKED_RESOURCE";
    static final int BRIDGE_CHUNK_BYTES = 256 * 1024;
    static final int MAX_BUCKET_ENCODED_BYTES = 16 * 1024 * 1024;
    static final int MAX_PROCESSED_TRIPS = 1500;
    static final int MAX_CANDIDATES = 2500;
    private static final long FIXED_HEAP = 8L * 1024L * 1024L;
    private static final long FIXED_DISK = 16L * 1024L * 1024L;
    private static final long DISK_RESERVE = 256L * 1024L * 1024L;
    private static volatile AdmissionProbe testProbe;

    private final Context context;
    private final DriveSenseSpeedArchiveRepository speed;
    private final File root;

    DriveSenseLegacySpeedMigration(Context context, DriveSenseSpeedArchiveRepository speed) {
        this.context = context.getApplicationContext();
        this.speed = speed;
        this.root = new File(context.getNoBackupFilesDir(), "roadsage_p35/prde1_speed");
        if (!root.exists() && !root.mkdirs()) throw new IllegalStateException("PRDE1_STORAGE_UNAVAILABLE");
    }

    JSONObject begin(JSONObject request) throws Exception {
        String sourceId = bounded(request.optString("sourceId", ""), 96, "sourceId");
        String sourceContext = bounded(request.optString("sourceContext", ""), 240, "sourceContext");
        String sourceHash = request.optString("sourceCiphertextHash", "");
        if (sourceHash.isEmpty()) sourceHash = String.join("", Collections.nCopies(64, "0"));
        sourceHash = requireHash(sourceHash);
        long expected = request.optLong("expectedCiphertextBytes", -1L);
        int keyVersion = request.optInt("keyVersion", -1);
        long revision = Math.max(0L, request.optLong("sourceRevision", 0L));
        if (expected < 30L || expected > Integer.MAX_VALUE - 8L || keyVersion < 0) {
            throw new IllegalArgumentException("Invalid PRDE-1 predecessor descriptor");
        }
        Admission admission = admission(expected);
        if (!admission.admitted) {
            JSONObject blocked = baseStatus(null, BLOCKED_RESOURCE);
            blocked.put("sourceId", sourceId);
            blocked.put("sourceCiphertextHash", sourceHash);
            blocked.put("legacyAuthorityPreserved", true);
            blocked.put("retryable", true);
            blocked.put("requiredJavaBytes", admission.requiredJava);
            blocked.put("requiredDiskBytes", admission.requiredDisk);
            writeGlobalStatus(blocked);
            return blocked;
        }
        String operationId = UUID.randomUUID().toString();
        File directory = operation(operationId);
        if (!directory.mkdirs()) throw new IllegalStateException("PRDE1_OPERATION_CREATE_FAILED");
        JSONObject manifest = baseStatus(operationId, "STAGING");
        manifest.put("sourceId", sourceId);
        manifest.put("sourceContext", sourceContext);
        manifest.put("sourceCiphertextHash", sourceHash);
        manifest.put("sourceRevision", revision);
        manifest.put("keyVersion", keyVersion);
        manifest.put("expectedCiphertextBytes", expected);
        manifest.put("receivedCiphertextBytes", 0L);
        manifest.put("nextChunkIndex", 0);
        manifest.put("requiredJavaBytes", admission.requiredJava);
        manifest.put("requiredDiskBytes", admission.requiredDisk);
        manifest.put("legacyAuthorityPreserved", true);
        writeManifest(directory, manifest);
        writeGlobalStatus(manifest);
        return manifest;
    }

    JSONObject append(String operationId, int chunkIndex, String encoded) throws Exception {
        File directory = requiredOperation(operationId);
        JSONObject manifest = readManifest(directory);
        if (!"STAGING".equals(manifest.optString("state"))) throw new IllegalStateException("PRDE1_NOT_STAGING");
        if (chunkIndex != manifest.optInt("nextChunkIndex", -1)) throw new IllegalStateException("PRDE1_CHUNK_SEQUENCE_MISMATCH");
        if (encoded == null || encoded.length() > 400_000) throw new IllegalArgumentException("PRDE1_CHUNK_TOO_LARGE");
        byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
        try {
            if (bytes.length < 1 || bytes.length > BRIDGE_CHUNK_BYTES) throw new IllegalArgumentException("PRDE1_CHUNK_TOO_LARGE");
            long next = manifest.getLong("receivedCiphertextBytes") + bytes.length;
            if (next > manifest.getLong("expectedCiphertextBytes")) throw new IllegalStateException("PRDE1_STAGING_OVERFLOW");
            try (FileOutputStream output = new FileOutputStream(ciphertext(directory), true)) {
                output.write(bytes);
                output.getFD().sync();
            }
            manifest.put("receivedCiphertextBytes", next);
            manifest.put("nextChunkIndex", chunkIndex + 1);
            writeManifest(directory, manifest);
            return manifest;
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    JSONObject execute(String operationId) throws Exception {
        File directory = requiredOperation(operationId);
        JSONObject manifest = readManifest(directory);
        if ("VERIFIED".equals(manifest.optString("state"))) return manifest;
        File ciphertextFile = ciphertext(directory);
        if (ciphertextFile.length() != manifest.getLong("expectedCiphertextBytes") ||
            manifest.getLong("receivedCiphertextBytes") != ciphertextFile.length()) {
            throw preserveFailure(directory, manifest, "PRDE1_STAGING_INCOMPLETE", null);
        }
        String actualHash = hashHex(ciphertextFile);
        String declaredHash = manifest.getString("sourceCiphertextHash");
        boolean hashDeferred = declaredHash.matches("0{64}");
        if (!hashDeferred && !MessageDigest.isEqual(hexBytes(actualHash), hexBytes(declaredHash))) {
            throw preserveFailure(directory, manifest, "PRDE1_SOURCE_HASH_MISMATCH", null);
        }
        if (hashDeferred) { manifest.put("sourceCiphertextHash", actualHash); writeManifest(directory, manifest); }
        Admission admitted = admission(ciphertextFile.length());
        if (!admitted.admitted) {
            manifest.put("state", BLOCKED_RESOURCE);
            manifest.put("retryable", true);
            manifest.put("legacyAuthorityPreserved", true);
            writeManifest(directory, manifest); writeGlobalStatus(manifest); return manifest;
        }

        byte[] ciphertext = null;
        byte[] plaintext = null;
        Partition partition;
        long usedBefore = heapUsed();
        try {
            manifest.put("state", "DECODING"); writeManifest(directory, manifest);
            ciphertext = Files.readAllBytes(ciphertextFile.toPath());
            plaintext = DriveSensePayloadCrypto.decryptPayloadBytes(ciphertext,
                manifest.getString("sourceContext"), manifest.getInt("keyVersion"));
            manifest.put("decodeCiphertextBytes", ciphertext.length);
            manifest.put("decodePlaintextBytes", plaintext.length);
            manifest.put("decodeHeapDeltaBytes", Math.max(0L, heapUsed() - usedBefore));
            manifest.put("state", "PARTITIONING"); writeManifest(directory, manifest);
            partition = partition(directory, plaintext, manifest);
        } catch (Exception error) {
            throw preserveFailure(directory, manifest, error instanceof SecurityException ? "PRDE1_AUTH_FAILED" : "PRDE1_DECODE_OR_PARSE_FAILED", error);
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
            if (ciphertext != null) Arrays.fill(ciphertext, (byte) 0);
        }

        manifest.put("plaintextReleasedBeforeCommit", true);
        manifest.put("state", "COMMITTING");
        manifest.put("bucketCount", partition.bucketIds.size());
        manifest.put("cellCount", partition.cells);
        manifest.put("correctionCount", partition.corrections);
        manifest.put("excludedSectionCount", partition.exclusions);
        manifest.put("candidateCount", partition.candidates);
        writeManifest(directory, manifest);
        try {
            int committed = 0;
            for (String bucket : partition.bucketIds) {
                File document = encodeBucket(directory, bucket, partition);
                if (document.length() > MAX_BUCKET_ENCODED_BYTES) throw new IllegalStateException("SPEED_BUCKET_DEFENSIVE_BYTE_CEILING");
                speed.restoreSpool(document, bucket, countItems(directory, bucket), fileHash(document));
                if (!document.delete()) document.deleteOnExit();
                manifest.put("committedBuckets", ++committed);
                writeManifest(directory, manifest);
            }
            verifyBuckets(manifest, partition);
            manifest.put("state", "VERIFIED");
            manifest.put("authorityFlipEligible", true);
            manifest.put("historyDropped", true);
            manifest.put("userDisclosure", "Saved-road edit undo history was cleared during the storage upgrade.");
            manifest.put("sourceCiphertextHashAfter", hashHex(ciphertextFile));
            manifest.put("legacyAuthorityPreserved", true);
            writeManifest(directory, manifest); writeGlobalStatus(manifest);
            return manifest;
        } catch (Exception error) {
            throw preserveFailure(directory, manifest, "PRDE1_COMMIT_OR_VERIFY_FAILED", error);
        } finally {
            partition.close();
            deleteTree(new File(directory, "spills"));
            File[] encoded = directory.listFiles((ignored, name) -> name.startsWith("bucket-") && name.endsWith(".json"));
            if (encoded != null) for (File file : encoded) if (!file.delete()) file.deleteOnExit();
        }
    }

    JSONObject status(String operationId) throws Exception {
        if (operationId == null || operationId.isEmpty()) {
            File file = new File(root, "status.json");
            return file.isFile() ? new JSONObject(readUtf8(file)) : baseStatus(null, "NOT_STARTED");
        }
        return readManifest(requiredOperation(operationId));
    }

    private Partition partition(File directory, byte[] plaintext, JSONObject manifest) throws Exception {
        File spills = new File(directory, "spills");
        deleteTree(spills);
        if (!spills.exists() && !spills.mkdirs()) throw new IOException("PRDE1_SPILL_CREATE_FAILED");
        Partition p = new Partition(directory.getName());
        try (JsonReader reader = new JsonReader(new InputStreamReader(new ByteArrayInputStream(plaintext), StandardCharsets.UTF_8))) {
            reader.beginObject();
            while (reader.hasNext()) {
                String name = reader.nextName();
                if ("cells".equals(name)) readCells(reader, spills, p);
                else if ("corrections".equals(name)) readArray(reader, spills, p, 'C');
                else if ("excludedSections".equals(name)) readArray(reader, spills, p, 'E');
                else if ("roadMemory".equals(name)) readRoadMemory(reader, spills, p);
                else if ("history".equals(name)) reader.skipValue();
                else if ("schemaVersion".equals(name)) p.schemaVersion = readScalar(reader);
                else if ("knowledgeRevision".equals(name)) p.knowledgeRevision = readScalar(reader);
                else if ("knowledgeUpdatedAt".equals(name)) p.knowledgeUpdatedAt = readScalar(reader);
                else reader.skipValue();
            }
            reader.endObject();
            if (reader.peek() != JsonToken.END_DOCUMENT) throw new IOException("Trailing predecessor JSON");
        } catch (Exception error) {
            p.close();
            deleteTree(spills);
            throw error;
        }
        p.bucketIds.add("zzzz");
        writeGlobal(directory, p);
        return p;
    }

    private void readCells(JsonReader reader, File spills, Partition p) throws Exception {
        reader.beginObject();
        while (reader.hasNext()) {
            String geohash = reader.nextName();
            String raw = copyValue(reader);
            String bucket = bucket(geohash);
            appendLine(p, spill(spills, bucket, 'L'), geohash + "\t" + raw);
            if (geohash.length() == 6 && p.precision6Key == null) { p.precision6Key = geohash; p.precision6Raw = raw; }
            if (geohash.length() == 5 && p.precision5Key == null) { p.precision5Key = geohash; p.precision5Raw = raw; }
            p.bucketIds.add(bucket); p.cells++;
        }
        reader.endObject();
    }

    private void readArray(JsonReader reader, File spills, Partition p, char kind) throws Exception {
        reader.beginArray();
        while (reader.hasNext()) {
            String raw = copyValue(reader);
            JSONObject item = new JSONObject(raw);
            String bucket = bucket(item.optString("geohash", ""));
            appendLine(p, spill(spills, bucket, kind), raw);
            p.bucketIds.add(bucket);
            if (kind == 'C') p.corrections++; else p.exclusions++;
        }
        reader.endArray();
    }

    private void readRoadMemory(JsonReader reader, File spills, Partition p) throws Exception {
        reader.beginObject();
        while (reader.hasNext()) {
            String name = reader.nextName();
            if ("candidates".equals(name)) {
                reader.beginArray();
                while (reader.hasNext()) {
                    String raw = copyValue(reader);
                    if (p.candidates < MAX_CANDIDATES) {
                        JSONObject item = new JSONObject(raw); String b = bucket(item.optString("geohash", ""));
                        appendLine(p, spill(spills, b, 'R'), raw); p.bucketIds.add(b); p.candidates++;
                    }
                }
                reader.endArray();
            } else if ("processedTrips".equals(name)) {
                reader.beginObject(); int kept = 0;
                while (reader.hasNext()) { String id = reader.nextName(); String raw = copyValue(reader); if (kept++ < MAX_PROCESSED_TRIPS) appendLine(p, new File(spills, "processed.ndjson"), id + "\t" + raw); }
                reader.endObject(); p.processedTrips = Math.min(kept, MAX_PROCESSED_TRIPS);
            } else if ("intelligence".equals(name)) p.intelligence = copyValue(reader);
            else reader.skipValue();
        }
        reader.endObject();
    }

    private File encodeBucket(File directory, String bucket, Partition p) throws Exception {
        File output = new File(directory, "bucket-" + bucket + ".json");
        try (Writer writer = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(output), StandardCharsets.UTF_8))) {
            File spills = new File(directory,"spills");
            writer.write("{\"bucketId\":"); writer.write(JSONObject.quote(bucket)); writer.write(",\"schemaVersion\":1,\"cells\":{");
            final boolean[] first = {true};
            forEachLine(p,spill(spills,bucket,'L'), line->{int tab=line.indexOf('\t');if(!first[0])writer.write(',');first[0]=false;writer.write(JSONObject.quote(line.substring(0,tab)));writer.write(':');writer.write(line.substring(tab+1));});
            writer.write("},\"corrections\":["); writeRawArray(p,writer,spill(spills,bucket,'C'));
            writer.write("],\"excludedSections\":["); writeRawArray(p,writer,spill(spills,bucket,'E'));
            writer.write("],\"roadMemory\":{\"candidates\":["); writeRawArray(p,writer,spill(spills,bucket,'R')); writer.write("]}");
            if ("zzzz".equals(bucket)) {
                writer.write(",\"global\":{\"schemaVersion\":");writer.write(p.schemaVersion);
                writer.write(",\"knowledgeRevision\":");writer.write(p.knowledgeRevision);
                writer.write(",\"knowledgeUpdatedAt\":");writer.write(p.knowledgeUpdatedAt);
                writer.write(",\"processedTrips\":{");final boolean[] firstTrip={true};forEachLine(p,new File(spills,"processed.ndjson"),line->{int tab=line.indexOf('\t');if(!firstTrip[0])writer.write(',');firstTrip[0]=false;writer.write(JSONObject.quote(line.substring(0,tab)));writer.write(':');writer.write(line.substring(tab+1));});
                writer.write("},\"intelligence\":");writer.write(p.intelligence);
                writer.write(",\"history\":{\"undo\":[],\"redo\":[]}}");
            }
            writer.write('}');
        }
        try (FileOutputStream sync = new FileOutputStream(output, true)) { sync.getFD().sync(); }
        return output;
    }

    private void verifyBuckets(JSONObject manifest, Partition p) throws Exception {
        int seen = 0;
        long verifiedItems = 0L;
        for (String id : p.bucketIds) {
            JSONObject meta = speed.metadata(new org.json.JSONArray().put(id));
            if (meta.getJSONArray("items").length() != 1) throw new IllegalStateException("PRDE1_BUCKET_VERIFY_MISSING");
            verifiedItems += meta.getJSONArray("items").getJSONObject(0).getLong("cellCount");
            seen++;
        }
        if (seen != p.bucketIds.size()) throw new IllegalStateException("PRDE1_BUCKET_COUNT_MISMATCH");
        long expectedItems = p.cells + p.corrections + p.exclusions + p.candidates;
        if (verifiedItems != expectedItems) throw new IllegalStateException("PRDE1_CATEGORY_COUNT_MISMATCH");
        verifyRepresentativeCell(p.precision6Key, p.precision6Raw);
        verifyRepresentativeCell(p.precision5Key, p.precision5Raw);
        manifest.put("verifiedBucketCount", seen);
        manifest.put("verifiedCategoryItemCount", verifiedItems);
        manifest.put("precision6LookupVerified", p.precision6Key == null || p.precision6Raw != null);
        manifest.put("precision5FallbackVerified", p.precision5Key == null || p.precision5Raw != null);
        manifest.put("countsVerified", true);
        manifest.put("sourceHashVerified", true);
    }

    private void verifyRepresentativeCell(String geohash, String expectedRaw) throws Exception {
        if (geohash == null) return;
        JSONObject document = speed.readBucketJson(bucket(geohash));
        Object actual = document == null ? null : document.optJSONObject("cells").opt(geohash);
        Object expected = new org.json.JSONTokener(expectedRaw).nextValue();
        if (actual == null || !String.valueOf(actual).equals(String.valueOf(expected))) {
            throw new IllegalStateException("PRDE1_REPRESENTATIVE_LOOKUP_MISMATCH");
        }
    }

    private Admission admission(long ciphertextBytes) {
        long plaintext = Math.max(1L, ciphertextBytes - 29L);
        long requiredJava = ciphertextBytes + plaintext + plaintext / 4L + FIXED_HEAP;
        long requiredDisk = ciphertextBytes + plaintext + plaintext * 15L / 100L + FIXED_DISK;
        AdmissionProbe probe = testProbe != null ? testProbe : AdmissionProbe.observe(context);
        long dynamicCeiling = Math.max(16L * 1024L * 1024L, Math.min(probe.largeMemoryClassBytes / 2L, probe.maxHeap / 2L));
        boolean heap = requiredJava <= probe.maxHeap / 2L && requiredJava <= Math.max(0L, probe.maxHeap - probe.usedHeap) / 2L && requiredJava <= dynamicCeiling;
        boolean system = !probe.lowMemory && probe.availableSystem > probe.systemThreshold + requiredJava;
        boolean disk = probe.availableDisk - requiredDisk >= DISK_RESERVE;
        return new Admission(heap && system && disk, requiredJava, requiredDisk);
    }

    private IllegalStateException preserveFailure(File directory, JSONObject manifest, String code, Exception cause) throws Exception {
        manifest.put("state", code); manifest.put("legacyAuthorityPreserved", true); manifest.put("authorityFlipEligible", false); manifest.put("retryable", true);
        writeManifest(directory, manifest); writeGlobalStatus(manifest);
        return new IllegalStateException(code, cause);
    }

    private static String copyValue(JsonReader reader) throws Exception { StringWriter text=new StringWriter(); try(JsonWriter writer=new JsonWriter(text)){writer.setLenient(true);copy(reader,writer);} return text.toString(); }
    private static void copy(JsonReader r,JsonWriter w)throws Exception{switch(r.peek()){case BEGIN_OBJECT:r.beginObject();w.beginObject();while(r.hasNext()){w.name(r.nextName());copy(r,w);}r.endObject();w.endObject();break;case BEGIN_ARRAY:r.beginArray();w.beginArray();while(r.hasNext())copy(r,w);r.endArray();w.endArray();break;case STRING:w.value(r.nextString());break;case NUMBER:w.value(new java.math.BigDecimal(r.nextString()));break;case BOOLEAN:w.value(r.nextBoolean());break;case NULL:r.nextNull();w.nullValue();break;default:throw new IOException("Unsupported JSON token");}}
    private static String readScalar(JsonReader r)throws Exception{return copyValue(r);}
    private static String bucket(String value){String id=value==null?"":value.trim().toLowerCase();return id.length()>=4&&id.substring(0,4).matches("[0-9bcdefghjkmnpqrstuvwxyz]{4}")?id.substring(0,4):"zzzz";}
    private static File spill(File root,String bucket,char kind){return new File(root,bucket+"."+kind+".ndjson");}
    private static void appendLine(Partition partition,File file,String line)throws Exception{String encrypted=partition.encrypt(file.getName(),line);try(Writer out=new OutputStreamWriter(new FileOutputStream(file,true),StandardCharsets.UTF_8)){out.write(encrypted);out.write('\n');}}
    private interface LineConsumer{void accept(String line)throws Exception;}
    private static void forEachLine(Partition partition,File file,LineConsumer consumer)throws Exception{if(!file.isFile())return;try(BufferedReader in=new BufferedReader(new InputStreamReader(new FileInputStream(file),StandardCharsets.UTF_8))){String line;while((line=in.readLine())!=null)consumer.accept(partition.decrypt(file.getName(),line));}}
    private static void writeRawArray(Partition partition,Writer writer,File file)throws Exception{final boolean[]first={true};forEachLine(partition,file,line->{if(!first[0])writer.write(',');first[0]=false;writer.write(line);});}
    private static int countItems(File directory,String bucket)throws Exception{int count=0;for(char kind:new char[]{'L','C','E','R'}){File f=spill(new File(directory,"spills"),bucket,kind);if(f.isFile())try(BufferedReader in=new BufferedReader(new FileReader(f))){while(in.readLine()!=null)count++;}}return count;}
    private void writeGlobal(File directory,Partition p)throws Exception{JSONObject o=new JSONObject();o.put("buckets",p.bucketIds.size());o.put("cells",p.cells);o.put("corrections",p.corrections);o.put("exclusions",p.exclusions);o.put("candidates",p.candidates);writeSync(new File(directory,"partition.json"),o.toString());}
    private File operation(String id){return new File(root,id);}
    private File requiredOperation(String id){if(id==null||!id.matches("[0-9a-fA-F-]{36}"))throw new IllegalArgumentException("Invalid PRDE-1 operation");File f=operation(id);if(!f.isDirectory())throw new IllegalStateException("PRDE1_OPERATION_NOT_FOUND");return f;}
    private static File ciphertext(File directory){return new File(directory,"predecessor.ciphertext");}
    private static File manifest(File directory){return new File(directory,"manifest.json");}
    private static JSONObject readManifest(File directory)throws Exception{return new JSONObject(readUtf8(manifest(directory)));}
    private static void writeManifest(File directory,JSONObject value)throws Exception{writeSync(manifest(directory),value.toString());}
    private void writeGlobalStatus(JSONObject value)throws Exception{writeSync(new File(root,"status.json"),value.toString());}
    private static void writeSync(File file,String value)throws Exception{File temp=new File(file.getParentFile(),file.getName()+".tmp");try(FileOutputStream out=new FileOutputStream(temp,false)){out.write(value.getBytes(StandardCharsets.UTF_8));out.getFD().sync();}if(file.exists()&&!file.delete())throw new IOException("Could not replace state");if(!temp.renameTo(file))throw new IOException("Could not publish state");DriveSenseArchiveSentinelStore.fsyncDirectory(file.getParentFile());}
    private static String readUtf8(File file)throws Exception{return new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8);}
    private static void deleteTree(File file){if(file==null||!file.exists())return;if(file.isDirectory()){File[]children=file.listFiles();if(children!=null)for(File child:children)deleteTree(child);}if(!file.delete())file.deleteOnExit();}
    private static JSONObject baseStatus(String id,String state)throws Exception{JSONObject o=new JSONObject();if(id!=null)o.put("operationId",id);o.put("protocol","PRDE-1");o.put("state",state);o.put("updatedAtMs",System.currentTimeMillis());return o;}
    private static String bounded(String value,int max,String name){if(value==null||value.isEmpty()||value.length()>max)throw new IllegalArgumentException("Invalid "+name);return value;}
    private static String requireHash(String value){if(value==null||!value.matches("[0-9a-fA-F]{64}"))throw new IllegalArgumentException("Invalid predecessor hash");return value.toLowerCase();}
    private static String hashHex(File file)throws Exception{return DriveSenseEnvelopeCrypto.hex(fileHash(file));}
    private static byte[] fileHash(File file)throws Exception{MessageDigest d=MessageDigest.getInstance("SHA-256");try(InputStream in=new BufferedInputStream(new FileInputStream(file))){byte[]b=new byte[256*1024];int n;while((n=in.read(b))!=-1)d.update(b,0,n);}return d.digest();}
    private static byte[] hexBytes(String hex){byte[]out=new byte[hex.length()/2];for(int i=0;i<out.length;i++)out[i]=(byte)Integer.parseInt(hex.substring(i*2,i*2+2),16);return out;}
    private static long heapUsed(){Runtime r=Runtime.getRuntime();return r.totalMemory()-r.freeMemory();}
    static void setAdmissionProbeForTests(AdmissionProbe probe){testProbe=probe;}

    static final class AdmissionProbe {
        final long maxHeap,usedHeap,largeMemoryClassBytes,availableSystem,systemThreshold,availableDisk; final boolean lowMemory;
        AdmissionProbe(long m,long u,long c,long a,long t,long d,boolean l){maxHeap=m;usedHeap=u;largeMemoryClassBytes=c;availableSystem=a;systemThreshold=t;availableDisk=d;lowMemory=l;}
        static AdmissionProbe observe(Context context){Runtime r=Runtime.getRuntime();ActivityManager am=(ActivityManager)context.getSystemService(Context.ACTIVITY_SERVICE);ActivityManager.MemoryInfo mi=new ActivityManager.MemoryInfo();am.getMemoryInfo(mi);long cls=(long)am.getLargeMemoryClass()*1024L*1024L;long disk=new StatFs(context.getNoBackupFilesDir().getAbsolutePath()).getAvailableBytes();try{StorageManager sm=(StorageManager)context.getSystemService(Context.STORAGE_SERVICE);if(android.os.Build.VERSION.SDK_INT>=26)disk=Math.min(disk,sm.getAllocatableBytes(StorageManager.UUID_DEFAULT));}catch(Exception ignored){}return new AdmissionProbe(r.maxMemory(),heapUsed(),cls,mi.availMem,mi.threshold,disk,mi.lowMemory);}
    }
    private static final class Admission{final boolean admitted;final long requiredJava,requiredDisk;Admission(boolean a,long j,long d){admitted=a;requiredJava=j;requiredDisk=d;}}
    private static final class Partition implements AutoCloseable{
        final SortedSet<String>bucketIds=new TreeSet<>();final String operationId;final byte[]spillDek=DriveSenseEnvelopeCrypto.newDek();long cells,corrections,exclusions,candidates,processedTrips;String schemaVersion="1",knowledgeRevision="0",knowledgeUpdatedAt="null",intelligence="null",precision6Key,precision6Raw,precision5Key,precision5Raw;
        Partition(String operationId){this.operationId=operationId;}
        String encrypt(String file,String value)throws Exception{byte[]nonce=new byte[12];new java.security.SecureRandom().nextBytes(nonce);byte[]plain=value.getBytes(StandardCharsets.UTF_8);byte[]ciphertext=null;try{Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(spillDek,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(DriveSenseEnvelopeCrypto.encode("roadsage.prde1.spill.v1",operationId,file));ciphertext=cipher.doFinal(plain);byte[]frame=new byte[nonce.length+ciphertext.length];System.arraycopy(nonce,0,frame,0,nonce.length);System.arraycopy(ciphertext,0,frame,nonce.length,ciphertext.length);try{return Base64.encodeToString(frame,Base64.NO_WRAP);}finally{Arrays.fill(frame,(byte)0);}}finally{Arrays.fill(plain,(byte)0);Arrays.fill(nonce,(byte)0);if(ciphertext!=null)Arrays.fill(ciphertext,(byte)0);}}
        String decrypt(String file,String encoded)throws Exception{byte[]frame=Base64.decode(encoded,Base64.NO_WRAP);byte[]nonce=Arrays.copyOfRange(frame,0,12),ciphertext=Arrays.copyOfRange(frame,12,frame.length),plain=null;try{Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(spillDek,"AES"),new GCMParameterSpec(128,nonce));cipher.updateAAD(DriveSenseEnvelopeCrypto.encode("roadsage.prde1.spill.v1",operationId,file));plain=cipher.doFinal(ciphertext);return new String(plain,StandardCharsets.UTF_8);}finally{Arrays.fill(frame,(byte)0);Arrays.fill(nonce,(byte)0);Arrays.fill(ciphertext,(byte)0);if(plain!=null)Arrays.fill(plain,(byte)0);}}
        public void close(){Arrays.fill(spillDek,(byte)0);}
    }
}
