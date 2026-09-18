package com.drivesense.app;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Restartable raw-byte JSON filter used by native retention.  Payload scalars
 * stream verbatim; only separators around removed/replaced members are
 * normalized.  No route array or scalar value is materialized.
 */
final class DriveSenseRetentionTokenizer {
    static final int STATE_VERSION=3,MAX_KEY_BYTES=64*1024,MAX_PRIOR_COUNT_BYTES=64;
    private static final int O_KEY=0,O_COLON=1,O_VALUE=2,O_AFTER=3,A_VALUE=0,A_AFTER=1;
    private final boolean raw,motion;
    private final int rawDays,motionDays;private final long now;
    private final List<Frame> stack=new ArrayList<>();
    private String mode="NORMAL";private boolean escape;private int unicodeLeft;
    private byte[]keyBytes=new byte[0];private boolean keyStreaming;
    private boolean skip,skipStarted,skipString,skipEscape,skipRoute,skipMotion,skipArrayHasElement,skipPriorRawCount,skipPriorMotionCount,skipCountOverflow;
    private int skipDepth;private long routeCount,motionCount,priorRawCount,priorMotionCount;private boolean priorRawCountValid,priorMotionCountValid;private byte[]skipCountBytes=new byte[0];
    private int rootPhase;private final JSONObject metadata=new JSONObject();
    private String captureKey;private byte[]captureBytes=new byte[0];private boolean captureOverflow;

    DriveSenseRetentionTokenizer(boolean raw,int rawDays,boolean motion,int motionDays,long now){this.raw=raw;this.rawDays=rawDays;this.motion=motion;this.motionDays=motionDays;this.now=now;}

    static DriveSenseRetentionTokenizer restore(byte[]encoded)throws Exception{
        JSONObject value=new JSONObject(new String(encoded,StandardCharsets.UTF_8));
        if(value.getInt("v")!=STATE_VERSION)throw new IllegalStateException("RETENTION_TOKENIZER_STATE_VERSION");
        DriveSenseRetentionTokenizer out=new DriveSenseRetentionTokenizer(value.getBoolean("raw"),value.getInt("rawDays"),value.getBoolean("motion"),value.getInt("motionDays"),value.getLong("now"));
        out.mode=value.getString("mode");out.escape=value.optBoolean("escape");out.unicodeLeft=value.optInt("unicodeLeft");
        out.keyBytes=decode(value.optString("keyBytes",""));out.keyStreaming=value.optBoolean("keyStreaming");
        out.skip=value.optBoolean("skip");out.skipStarted=value.optBoolean("skipStarted");out.skipString=value.optBoolean("skipString");out.skipEscape=value.optBoolean("skipEscape");out.skipRoute=value.optBoolean("skipRoute");out.skipMotion=value.optBoolean("skipMotion");out.skipArrayHasElement=value.optBoolean("skipArrayHasElement");out.skipPriorRawCount=value.optBoolean("skipPriorRawCount");out.skipPriorMotionCount=value.optBoolean("skipPriorMotionCount");out.skipCountOverflow=value.optBoolean("skipCountOverflow");out.skipCountBytes=decode(value.optString("skipCountBytes",""));out.skipDepth=value.optInt("skipDepth");
        out.routeCount=value.optLong("routeCount");out.motionCount=value.optLong("motionCount");out.priorRawCount=value.optLong("priorRawCount");out.priorMotionCount=value.optLong("priorMotionCount");out.priorRawCountValid=value.optBoolean("priorRawCountValid");out.priorMotionCountValid=value.optBoolean("priorMotionCountValid");out.rootPhase=value.optInt("rootPhase");
        JSONArray frames=value.getJSONArray("stack");for(int i=0;i<frames.length();i++)out.stack.add(Frame.from(frames.getJSONObject(i)));
        JSONObject meta=value.optJSONObject("metadata");if(meta!=null)for(java.util.Iterator<String>it=meta.keys();it.hasNext();){String k=it.next();out.metadata.put(k,meta.opt(k));}
        out.captureKey=value.optString("captureKey",null);out.captureBytes=decode(value.optString("captureBytes",""));out.captureOverflow=value.optBoolean("captureOverflow");
        return out;
    }

    byte[] save()throws Exception{
        JSONObject value=new JSONObject();value.put("v",STATE_VERSION);value.put("raw",raw);value.put("rawDays",rawDays);value.put("motion",motion);value.put("motionDays",motionDays);value.put("now",now);
        value.put("mode",mode);value.put("escape",escape);value.put("unicodeLeft",unicodeLeft);value.put("keyBytes",encode(keyBytes));value.put("keyStreaming",keyStreaming);
        value.put("skip",skip);value.put("skipStarted",skipStarted);value.put("skipString",skipString);value.put("skipEscape",skipEscape);value.put("skipRoute",skipRoute);value.put("skipMotion",skipMotion);value.put("skipArrayHasElement",skipArrayHasElement);value.put("skipPriorRawCount",skipPriorRawCount);value.put("skipPriorMotionCount",skipPriorMotionCount);value.put("skipCountOverflow",skipCountOverflow);value.put("skipCountBytes",encode(skipCountBytes));value.put("skipDepth",skipDepth);value.put("routeCount",routeCount);value.put("motionCount",motionCount);value.put("priorRawCount",priorRawCount);value.put("priorMotionCount",priorMotionCount);value.put("priorRawCountValid",priorRawCountValid);value.put("priorMotionCountValid",priorMotionCountValid);value.put("rootPhase",rootPhase);
        JSONArray frames=new JSONArray();for(Frame frame:stack)frames.put(frame.json());value.put("stack",frames);value.put("metadata",metadata);
        if(captureKey!=null)value.put("captureKey",captureKey);value.put("captureBytes",encode(captureBytes));value.put("captureOverflow",captureOverflow);
        return value.toString().getBytes(StandardCharsets.UTF_8);
    }

    byte[] process(byte[]input,boolean eof)throws Exception{
        ByteArrayOutputStream out=new ByteArrayOutputStream(input.length+512);int i=0;
        while(i<input.length){
            byte b=input[i];
            if(skip){if(consumeSkip(b)){if(!skip)finishValue();i++;continue;}finishValue();continue;}
            if("KEY".equals(mode)){consumeKey(b,out);i++;continue;}
            if("STRING".equals(mode)){out.write(b);capture(b);consumeString(b);i++;if("NORMAL".equals(mode))finishValue();continue;}
            if("PRIMITIVE".equals(mode)){if(isDelimiter(b)){finishCapture();mode="NORMAL";finishValue();continue;}out.write(b);capture(b);i++;continue;}
            if(stack.isEmpty()){
                if(isWhitespace(b)){out.write(b);i++;continue;}
                if(rootPhase==1)throw new IllegalArgumentException("Trailing trip JSON content");
                startValue(b,out,null);i++;continue;
            }
            Frame frame=top();
            if(isWhitespace(b)){
                // Root and coordinate-object member separators may change when
                // members are removed.  Every other lexical region is copied.
                if(!frame.object||(!frame.root&&!frame.coordinateObject)||frame.phase==O_VALUE||frame.phase==O_AFTER)out.write(b);
                i++;continue;
            }
            if(frame.object){
                if(frame.phase==O_KEY){if(b=='}'){appendReplacements(frame,out);out.write(b);stack.remove(stack.size()-1);i++;finishValue();}else if(b=='"'){mode="KEY";keyBytes=new byte[]{b};keyStreaming=false;i++;}else throw invalid();continue;}
                if(frame.phase==O_COLON){if(b!=':')throw invalid();if(!frame.drop){out.write(':');beginCapture(frame);}frame.phase=O_VALUE;i++;continue;}
                if(frame.phase==O_VALUE){if(frame.drop){beginSkip(frame);continue;}startValue(b,out,frame);i++;continue;}
                if(b==','){if(!frame.root&&!frame.coordinateObject)out.write(b);frame.phase=O_KEY;i++;continue;}if(b=='}'){appendReplacements(frame,out);out.write(b);stack.remove(stack.size()-1);i++;finishValue();continue;}throw invalid();
            }else{
                if(frame.phase==A_VALUE){if(b==']'){out.write(b);stack.remove(stack.size()-1);i++;finishValue();}else{frame.emitted++;startValue(b,out,frame);i++;}continue;}
                if(b==','){out.write(b);frame.phase=A_VALUE;i++;continue;}if(b==']'){out.write(b);stack.remove(stack.size()-1);i++;finishValue();continue;}throw invalid();
            }
        }
        if(eof){if("PRIMITIVE".equals(mode)){finishCapture();mode="NORMAL";finishValue();}if(skip||!"NORMAL".equals(mode)||!stack.isEmpty()||rootPhase!=1)throw new IllegalArgumentException("Incomplete trip JSON");}
        return out.toByteArray();
    }

    JSONObject catalogMetadata()throws Exception{
        JSONObject out=new JSONObject();for(java.util.Iterator<String>it=metadata.keys();it.hasNext();){String key=it.next();out.put(key,metadata.opt(key));}
        out.put("point_count",raw?0:out.optInt("point_count",0));out.put("needs_rescore",raw?false:out.optBoolean("needs_rescore",false));
        if(raw){out.put("start_address",JSONObject.NULL);out.put("end_address",JSONObject.NULL);out.put("route_points_map_count",0);out.put("route_data_expired_at",now);out.put("route_data_expiration_reason","raw_gps_retention_policy");}
        return out;
    }
    long routeCount(){return priorRawCountValid?priorRawCount:routeCount;}long motionCount(){return priorMotionCountValid?priorMotionCount:motionCount;}

    private void consumeKey(byte b,ByteArrayOutputStream out)throws Exception{
        if(keyStreaming){out.write(b);if(escape){escape=false;return;}if(b=='\\'){escape=true;return;}if(b=='"'){mode="NORMAL";top().key=null;top().drop=false;top().phase=O_COLON;}return;}
        byte[]next=new byte[keyBytes.length+1];System.arraycopy(keyBytes,0,next,0,keyBytes.length);next[keyBytes.length]=b;keyBytes=next;
        if(keyBytes.length>MAX_KEY_BYTES){Frame frame=top();emitMemberPrefix(frame,out);out.write(keyBytes);keyBytes=new byte[0];keyStreaming=true;escape=false;return;}
        if(escape){escape=false;return;}if(b=='\\'){escape=true;return;}if(b!='"')return;
        String key=new JSONArray("["+new String(keyBytes,StandardCharsets.UTF_8)+"]").getString(0);Frame frame=top();frame.key=key;frame.drop=drop(frame,key);frame.targetMember=isEventArray(key);frame.routeMember=raw&&frame.root&&"route_points".equals(key);frame.motionMember=motion&&isMotion(key);
        if(!frame.drop){emitMemberPrefix(frame,out);out.write(keyBytes);}keyBytes=new byte[0];mode="NORMAL";frame.phase=O_COLON;
    }

    private void emitMemberPrefix(Frame frame,ByteArrayOutputStream out){if((frame.root||frame.coordinateObject)&&frame.emitted>0)out.write(',');frame.emitted++;}
    private boolean drop(Frame frame,String key){String k=key.toLowerCase(java.util.Locale.ROOT);
        if(raw&&frame.root&&(isRawReplacement(k)||"route_points".equals(k)||"route_preview".equals(k)||"raw_route_points".equals(k)||"route_geometry".equals(k)||"overview".equals(k)))return true;
        if(motion&&frame.root&&(isMotion(k)||isMotionReplacement(k)))return true;
        return raw&&frame.coordinateObject&&isCoordinate(k);
    }

    private void startValue(byte b,ByteArrayOutputStream out,Frame parent)throws Exception{
        if(b=='{'){out.write(b);Frame child=new Frame(true);child.root=stack.isEmpty();child.coordinateObject=parent!=null&&!parent.object&&parent.targetArray;stack.add(child);return;}
        if(b=='['){out.write(b);Frame child=new Frame(false);child.targetArray=parent!=null&&parent.object&&parent.targetMember;stack.add(child);return;}
        if(b=='"'){out.write(b);capture(b);mode="STRING";escape=false;unicodeLeft=0;return;}
        if(b=='-'||(b>='0'&&b<='9')||b=='t'||b=='f'||b=='n'){out.write(b);capture(b);mode="PRIMITIVE";return;}
        throw invalid();
    }

    private void consumeString(byte b){if(unicodeLeft>0){unicodeLeft--;return;}if(escape){escape=false;if(b=='u')unicodeLeft=4;return;}if(b=='\\'){escape=true;return;}if(b=='"')mode="NORMAL";}

    private void finishValue()throws Exception{
        finishCapture();
        finishSkippedCount();
        if(stack.isEmpty()){rootPhase=1;return;}
        Frame parent=top();if(parent.object){parent.phase=O_AFTER;parent.drop=false;parent.targetMember=false;parent.routeMember=false;parent.motionMember=false;parent.key=null;}else parent.phase=A_AFTER;
    }

    private void beginSkip(Frame frame){skip=true;skipStarted=false;skipString=false;skipEscape=false;skipDepth=0;skipRoute=frame.routeMember;skipMotion=frame.motionMember;skipArrayHasElement=false;skipPriorRawCount=raw&&frame.root&&"route_points_raw_count".equals(frame.key);skipPriorMotionCount=motion&&frame.root&&"motion_samples_expired_count".equals(frame.key);skipCountOverflow=false;skipCountBytes=new byte[0];}
    /** true when current byte was consumed; false when delimiter belongs to parent. */
    private boolean consumeSkip(byte b){
        if(!skipStarted){if(isWhitespace(b))return true;skipStarted=true;if(b=='"'){skipString=true;skipPriorRawCount=false;skipPriorMotionCount=false;return true;}if(b=='{'||b=='['){skipDepth=1;skipPriorRawCount=false;skipPriorMotionCount=false;if((skipRoute||skipMotion)&&b!='['){skipRoute=false;skipMotion=false;}return true;}captureSkippedCount(b);return true;}
        if(skipString){if(skipEscape){skipEscape=false;return true;}if(b=='\\'){skipEscape=true;return true;}if(b=='"'){skipString=false;if(skipDepth==0){skip=false;return true;}}return true;}
        if(skipDepth==0){if(isDelimiter(b)){skip=false;return false;}captureSkippedCount(b);return true;}
        if(b=='"'){skipString=true;if((skipRoute||skipMotion)&&skipDepth==1&&!skipArrayHasElement)countSkippedElement();return true;}
        if(b=='{'||b=='['){if((skipRoute||skipMotion)&&skipDepth==1&&!skipArrayHasElement)countSkippedElement();skipDepth++;return true;}
        if(b=='}'||b==']'){skipDepth--;if(skipDepth==0){skip=false;return true;}return true;}
        if((skipRoute||skipMotion)&&skipDepth==1){if(b==',')countSkippedElement();else if(!isWhitespace(b)&&!skipArrayHasElement)countSkippedElement();}
        return true;
    }

    private void countSkippedElement(){if(skipRoute)routeCount++;if(skipMotion)motionCount++;skipArrayHasElement=true;}

    private void captureSkippedCount(byte b){if((!skipPriorRawCount&&!skipPriorMotionCount)||skipCountOverflow)return;if(skipCountBytes.length>=MAX_PRIOR_COUNT_BYTES){skipCountOverflow=true;skipCountBytes=new byte[0];return;}byte[]next=new byte[skipCountBytes.length+1];System.arraycopy(skipCountBytes,0,next,0,skipCountBytes.length);next[skipCountBytes.length]=b;skipCountBytes=next;}
    private void finishSkippedCount(){if(!skipCountOverflow&&skipCountBytes.length>0&&(skipPriorRawCount||skipPriorMotionCount)){String value=new String(skipCountBytes,StandardCharsets.US_ASCII);if(value.matches("[1-9][0-9]*")){try{long parsed=Long.parseLong(value);if(skipPriorRawCount){priorRawCount=parsed;priorRawCountValid=true;}if(skipPriorMotionCount){priorMotionCount=parsed;priorMotionCountValid=true;}}catch(NumberFormatException ignored){}}}skipPriorRawCount=false;skipPriorMotionCount=false;skipCountOverflow=false;skipCountBytes=new byte[0];}

    private void appendReplacements(Frame frame,ByteArrayOutputStream out)throws Exception{
        if(!frame.root)return;StringBuilder add=new StringBuilder();String iso=Instant.ofEpochMilli(now).toString();
        if(raw){member(add,"route_points", "[]");member(add,"route_points_raw_count",Long.toString(routeCount()));member(add,"route_points_map_count","0");member(add,"route_preview","[]");member(add,"start_address","null");member(add,"end_address","null");member(add,"route_data_expired_at",JSONObject.quote(iso));member(add,"route_data_retention_days",Integer.toString(rawDays));member(add,"route_data_expiration_reason",JSONObject.quote("raw_gps_retention_policy"));member(add,"needs_rescore","false");member(add,"updated_at",JSONObject.quote(iso));}
        if(motion){member(add,"motion_samples","[]");member(add,"motion_samples_expired_count",Long.toString(motionCount()));member(add,"motion_samples_expired_at",JSONObject.quote(iso));member(add,"motion_samples_retention_days",Integer.toString(motionDays));if(!raw)member(add,"updated_at",JSONObject.quote(iso));}
        if(add.length()>0){if(frame.emitted>0)out.write(',');out.write(add.toString().getBytes(StandardCharsets.UTF_8));}
    }
    private static void member(StringBuilder out,String name,String value){if(out.length()>0)out.append(',');out.append(JSONObject.quote(name)).append(':').append(value);}

    private void beginCapture(Frame frame){String key=frame.root?frame.key:null;if(key!=null&&isCatalogField(key)){captureKey=key;captureBytes=new byte[0];captureOverflow=false;}else captureKey=null;}
    private void capture(byte b){if(captureKey==null||captureOverflow)return;if(captureBytes.length>=8192){captureOverflow=true;captureBytes=new byte[0];return;}byte[]next=new byte[captureBytes.length+1];System.arraycopy(captureBytes,0,next,0,captureBytes.length);next[captureBytes.length]=b;captureBytes=next;}
    private void finishCapture()throws Exception{if(captureKey==null)return;if(!captureOverflow&&captureBytes.length>0){String rawValue=new String(captureBytes,StandardCharsets.UTF_8);Object value=new JSONArray("["+rawValue+"]").get(0);metadata.put(captureKey,value);}captureKey=null;captureBytes=new byte[0];captureOverflow=false;}

    private Frame top(){return stack.get(stack.size()-1);}
    private static boolean isWhitespace(byte b){return b==' '||b=='\n'||b=='\r'||b=='\t';}
    private static boolean isDelimiter(byte b){return isWhitespace(b)||b==','||b==']'||b=='}';}
    private static IllegalArgumentException invalid(){return new IllegalArgumentException("Invalid trip JSON token");}
    private static boolean isCoordinate(String k){return k.equals("lat")||k.equals("lng")||k.equals("lon")||k.equals("latitude")||k.equals("longitude")||k.equals("original_lat")||k.equals("original_lng")||k.equals("matched_lat")||k.equals("matched_lng")||k.equals("coordinates")||k.equals("location");}
    private static boolean isEventArray(String k){return k.equals("driving_events")||k.equals("phone_proxy_events")||k.equals("phone_use_events")||k.equals("native_phone_usage_events")||k.equals("native_tracking_timeline");}
    private static boolean isMotion(String k){return k.equals("motion_samples")||k.equals("accelerometer_samples")||k.equals("gyroscope_samples");}
    private static boolean isRawReplacement(String k){return k.equals("route_points_raw_count")||k.equals("route_points_map_count")||k.equals("start_address")||k.equals("end_address")||k.equals("route_data_expired_at")||k.equals("route_data_retention_days")||k.equals("route_data_expiration_reason")||k.equals("needs_rescore")||k.equals("updated_at");}
    private static boolean isMotionReplacement(String k){return k.equals("motion_samples_expired_count")||k.equals("motion_samples_expired_at")||k.equals("motion_samples_retention_days")||k.equals("updated_at");}
    private static boolean isCatalogField(String k){String n=k.toLowerCase(java.util.Locale.ROOT);return n.equals("id")||n.equals("start_time")||n.equals("start_time_ms")||n.equals("end_time")||n.equals("end_time_ms")||n.equals("status")||n.equals("vehicle_id")||n.equals("vehicleid")||n.equals("point_count")||n.equals("distance")||n.equals("distance_km")||n.equals("duration")||n.equals("duration_seconds")||n.equals("score_overall")||n.equals("score_safety")||n.equals("score_smoothness")||n.equals("score_status")||n.equals("needs_rescore");}
    private static String encode(byte[]value){return Base64.encodeToString(value,Base64.NO_WRAP);}
    private static byte[]decode(String value){return value==null||value.isEmpty()?new byte[0]:Base64.decode(value,Base64.NO_WRAP);}

    private static final class Frame {
        final boolean object;int phase,emitted;boolean root,coordinateObject,targetArray,drop,targetMember,routeMember,motionMember;String key;
        Frame(boolean object){this.object=object;phase=object?O_KEY:A_VALUE;}
        JSONObject json()throws Exception{JSONObject o=new JSONObject();o.put("object",object);o.put("phase",phase);o.put("emitted",emitted);o.put("root",root);o.put("coordinateObject",coordinateObject);o.put("targetArray",targetArray);o.put("drop",drop);o.put("targetMember",targetMember);o.put("routeMember",routeMember);o.put("motionMember",motionMember);if(key!=null)o.put("key",key);return o;}
        static Frame from(JSONObject o){Frame f=new Frame(o.optBoolean("object"));f.phase=o.optInt("phase");f.emitted=o.optInt("emitted");f.root=o.optBoolean("root");f.coordinateObject=o.optBoolean("coordinateObject");f.targetArray=o.optBoolean("targetArray");f.drop=o.optBoolean("drop");f.targetMember=o.optBoolean("targetMember");f.routeMember=o.optBoolean("routeMember");f.motionMember=o.optBoolean("motionMember");f.key=o.optString("key",null);return f;}
    }
}
