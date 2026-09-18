package com.drivesense.app;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Restartable route_points parser. It consumes at most one canonical 256-KiB
 * chunk and 128 point objects per turn and carries a bounded partial object
 * across chunk boundaries.
 */
final class DriveSenseP6RoutePointParser {
    static final int MAX_POINTS_PER_TURN=128;
    private static final int MAX_POINT_BYTES=64*1024;
    private static final byte[]KEY="\"route_points\"".getBytes(StandardCharsets.UTF_8);
    private static final Set<String>METADATA_KEYS=new HashSet<>(Arrays.asList(
        "harsh_brakes_count","rapid_accel_count","sharp_turns_count","speeding_events_count",
        "night_driving","route_replay_available","smooth_braking_ratio","phone_use_score_available",
        "phone_use_risk","band_label","close_proximity_count","estimated_co2_saved_kg","defensive_grade"));
    private DriveSenseP6RoutePointParser(){}

    static Result consume(byte[]source,int offset,JSONObject persisted)throws Exception{
        State state=State.from(persisted);
        JSONArray points=new JSONArray();
        int index=Math.max(0,offset);
        for(;index<source.length&&points.length()<MAX_POINTS_PER_TURN;index++){
            int value=source[index]&0xff;
            captureMetadata(state,value);
            if(state.mode==0){
                if(value==(KEY[state.match]&0xff)){
                    state.match++;
                    if(state.match==KEY.length){state.mode=1;state.match=0;state.afterColon=false;}
                }else state.match=value==(KEY[0]&0xff)?1:0;
                continue;
            }
            if(state.mode==1){
                if(isWhitespace(value))continue;
                if(!state.afterColon){
                    if(value==':'){state.afterColon=true;continue;}
                    state.mode=0;state.match=0;continue;
                }
                if(value=='['){state.mode=2;continue;}
                state.mode=0;state.match=0;state.afterColon=false;continue;
            }
            if(state.mode==2){
                if(isWhitespace(value)||value==',')continue;
                if(value==']'){state.done=true;state.mode=3;continue;}
                if(value!='{')throw new IllegalStateException("P6_ROUTE_POINT_OBJECT_REQUIRED");
                state.mode=4;state.depth=1;state.inString=false;state.escape=false;
                state.object.reset();state.object.write(value);continue;
            }
            if(state.mode==4){
                state.object.write(value);
                if(state.object.size()>MAX_POINT_BYTES)throw new IllegalStateException("P6_ROUTE_POINT_TOO_LARGE");
                if(state.inString){
                    if(state.escape)state.escape=false;
                    else if(value=='\\')state.escape=true;
                    else if(value=='"')state.inString=false;
                    continue;
                }
                if(value=='"'){state.inString=true;continue;}
                if(value=='{')state.depth++;
                else if(value=='}'){
                    state.depth--;
                    if(state.depth==0){
                        points.put(new JSONObject(new String(state.object.toByteArray(),StandardCharsets.UTF_8)));
                        state.object.reset();state.mode=2;
                    }
                }
            }
        }
        return new Result(points,index,state.toJson(),state.done);
    }

    private static void captureMetadata(State state,int value)throws Exception{
        if(state.metadataReadingValue){
            if(state.metadataValueInString){
                state.metadataValue.write(value);
                if(state.metadataValueEscape)state.metadataValueEscape=false;
                else if(value=='\\')state.metadataValueEscape=true;
                else if(value=='"'){state.metadataValueInString=false;finishMetadataValue(state);}
                return;
            }
            if(value==','||value=='}'){
                finishMetadataValue(state);captureMetadata(state,value);return;
            }
            if(!isWhitespace(value))state.metadataValue.write(value);return;
        }
        if(state.metadataAwaitValue){
            if(isWhitespace(value))return;
            state.metadataAwaitValue=false;state.metadataReadingValue=true;
            if(value=='"'){state.metadataValueInString=true;state.metadataValue.write(value);}
            else state.metadataValue.write(value);return;
        }
        if(state.jsonInString){
            if(state.jsonReadingKey)state.metadataKey.write(value);
            if(state.jsonEscape)state.jsonEscape=false;
            else if(value=='\\')state.jsonEscape=true;
            else if(value=='"'){
                state.jsonInString=false;
                if(state.jsonReadingKey){
                    byte[]raw=state.metadataKey.toByteArray();
                    state.currentMetadataKey=new JSONObject("{\"k\":"+
                        new String(raw,StandardCharsets.UTF_8)+"}").getString("k");
                    state.metadataKey.reset();state.jsonReadingKey=false;state.metadataAfterKey=true;
                }
            }
            return;
        }
        if(value=='"'){
            state.jsonInString=true;
            if(state.jsonDepth==1&&state.metadataExpectKey){
                state.jsonReadingKey=true;state.metadataKey.reset();state.metadataKey.write(value);
                state.metadataExpectKey=false;
            }
            return;
        }
        if(value=='{'||value=='['){
            state.jsonDepth++;if(state.jsonDepth==1)state.metadataExpectKey=true;return;
        }
        if(value=='}'||value==']'){state.jsonDepth=Math.max(0,state.jsonDepth-1);return;}
        if(state.jsonDepth==1&&value==':'&&state.metadataAfterKey){
            state.metadataAfterKey=false;
            if(METADATA_KEYS.contains(state.currentMetadataKey))state.metadataAwaitValue=true;
            else state.currentMetadataKey=null;
            return;
        }
        if(state.jsonDepth==1&&value==','){
            state.metadataExpectKey=true;state.metadataAfterKey=false;state.currentMetadataKey=null;
        }
    }

    private static void finishMetadataValue(State state)throws Exception{
        if(state.currentMetadataKey!=null&&state.metadataValue.size()>0){
            String literal=new String(state.metadataValue.toByteArray(),StandardCharsets.UTF_8);
            state.metadata.put(state.currentMetadataKey,new JSONObject("{\"v\":"+literal+"}").opt("v"));
        }
        state.metadataValue.reset();state.metadataReadingValue=false;state.metadataValueInString=false;
        state.metadataValueEscape=false;state.currentMetadataKey=null;
    }

    private static boolean isWhitespace(int value){
        return value==' '||value=='\n'||value=='\r'||value=='\t';
    }

    static final class Result{
        final JSONArray points;final int nextOffset;final JSONObject parserState;final boolean done;
        Result(JSONArray points,int nextOffset,JSONObject parserState,boolean done){
            this.points=points;this.nextOffset=nextOffset;this.parserState=parserState;this.done=done;
        }
    }

    private static final class State{
        int mode,match,depth;boolean afterColon,inString,escape,done;
        final ByteArrayOutputStream object=new ByteArrayOutputStream();
        int jsonDepth;boolean jsonInString,jsonEscape,jsonReadingKey,metadataExpectKey,
            metadataAfterKey,metadataAwaitValue,metadataReadingValue,metadataValueInString,metadataValueEscape;
        String currentMetadataKey;final ByteArrayOutputStream metadataKey=new ByteArrayOutputStream();
        final ByteArrayOutputStream metadataValue=new ByteArrayOutputStream();JSONObject metadata=new JSONObject();
        static State from(JSONObject value){
            State state=new State();
            if(value==null)return state;
            state.mode=value.optInt("mode",0);state.match=value.optInt("match",0);
            state.depth=value.optInt("depth",0);state.afterColon=value.optBoolean("afterColon",false);
            state.inString=value.optBoolean("inString",false);state.escape=value.optBoolean("escape",false);
            state.done=value.optBoolean("done",false);
            state.jsonDepth=value.optInt("jsonDepth",0);state.jsonInString=value.optBoolean("jsonInString",false);
            state.jsonEscape=value.optBoolean("jsonEscape",false);state.jsonReadingKey=value.optBoolean("jsonReadingKey",false);
            state.metadataExpectKey=value.optBoolean("metadataExpectKey",false);
            state.metadataAfterKey=value.optBoolean("metadataAfterKey",false);
            state.metadataAwaitValue=value.optBoolean("metadataAwaitValue",false);
            state.metadataReadingValue=value.optBoolean("metadataReadingValue",false);
            state.metadataValueInString=value.optBoolean("metadataValueInString",false);
            state.metadataValueEscape=value.optBoolean("metadataValueEscape",false);
            state.currentMetadataKey=value.optString("currentMetadataKey",null);
            JSONObject metadata=value.optJSONObject("metadata");if(metadata!=null)state.metadata=metadata;
            String partial=value.optString("partial","");
            if(!partial.isEmpty()){
                byte[]bytes=Base64.decode(partial,Base64.NO_WRAP);
                state.object.write(bytes,0,bytes.length);
            }
            restore(value,"metadataKey",state.metadataKey);restore(value,"metadataValue",state.metadataValue);
            return state;
        }
        JSONObject toJson()throws Exception{
            JSONObject out=new JSONObject();out.put("mode",mode);out.put("match",match);
            out.put("depth",depth);out.put("afterColon",afterColon);out.put("inString",inString);
            out.put("escape",escape);out.put("done",done);
            out.put("jsonDepth",jsonDepth);out.put("jsonInString",jsonInString);out.put("jsonEscape",jsonEscape);
            out.put("jsonReadingKey",jsonReadingKey);out.put("metadataExpectKey",metadataExpectKey);
            out.put("metadataAfterKey",metadataAfterKey);out.put("metadataAwaitValue",metadataAwaitValue);
            out.put("metadataReadingValue",metadataReadingValue);out.put("metadataValueInString",metadataValueInString);
            out.put("metadataValueEscape",metadataValueEscape);out.put("currentMetadataKey",currentMetadataKey);
            out.put("metadata",metadata);
            if(object.size()>0)out.put("partial",Base64.encodeToString(object.toByteArray(),Base64.NO_WRAP));
            if(metadataKey.size()>0)out.put("metadataKey",Base64.encodeToString(metadataKey.toByteArray(),Base64.NO_WRAP));
            if(metadataValue.size()>0)out.put("metadataValue",Base64.encodeToString(metadataValue.toByteArray(),Base64.NO_WRAP));
            return out;
        }
        private static void restore(JSONObject source,String key,ByteArrayOutputStream target){
            String encoded=source.optString(key,"");if(encoded.isEmpty())return;
            byte[]bytes=Base64.decode(encoded,Base64.NO_WRAP);target.write(bytes,0,bytes.length);
        }
    }
}
