package com.drivesense.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.annotation.Config;
import org.robolectric.RobolectricTestRunner;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class DriveSenseP6RoutePointParserTest {
    @Test
    public void resumesAcrossCanonicalChunkAndObjectBoundaries()throws Exception{
        String json="{\"id\":\"trip-a\",\"note\":\"route_points is data\",\"route_points\":["+
            "{\"lat\":43.1,\"lng\":-79.1,\"label\":\"brace } in string\"},"+
            "{\"lat\":43.2,\"lng\":-79.2}],\"tail\":true}";
        byte[]all=json.getBytes(StandardCharsets.UTF_8);
        int split=json.indexOf("brace")+8;
        byte[]first=java.util.Arrays.copyOfRange(all,0,split);
        byte[]second=java.util.Arrays.copyOfRange(all,split,all.length);
        DriveSenseP6RoutePointParser.Result one=
            DriveSenseP6RoutePointParser.consume(first,0,new JSONObject());
        assertEquals(0,one.points.length());assertFalse(one.done);
        DriveSenseP6RoutePointParser.Result two=
            DriveSenseP6RoutePointParser.consume(second,0,one.parserState);
        assertTrue(two.done);assertEquals(2,two.points.length());
        assertEquals(43.2,two.points.getJSONObject(1).getDouble("lat"),0.0);
    }

    @Test
    public void stopsAt128AndResumesAtExactByteOffset()throws Exception{
        JSONArray points=new JSONArray();
        for(int index=0;index<130;index++){
            JSONObject point=new JSONObject();point.put("lat",43+index/10000d);
            point.put("lng",-79-index/10000d);points.put(point);
        }
        byte[]source=new JSONObject().put("route_points",points).toString()
            .getBytes(StandardCharsets.UTF_8);
        DriveSenseP6RoutePointParser.Result first=
            DriveSenseP6RoutePointParser.consume(source,0,new JSONObject());
        assertEquals(128,first.points.length());assertFalse(first.done);
        DriveSenseP6RoutePointParser.Result second=
            DriveSenseP6RoutePointParser.consume(source,first.nextOffset,first.parserState);
        assertEquals(2,second.points.length());assertTrue(second.done);
        assertEquals(43.0129,second.points.getJSONObject(1).getDouble("lat"),0.0);
    }

    @Test
    public void previewTargetsAreStableAcrossDerivedPageBoundaries(){
        int previous=-1;
        for(int index=0;index<160;index++){
            int ordinal=DriveSenseP6Jobs.previewTargetOrdinal(10003,160,index);
            assertTrue(ordinal>previous);previous=ordinal;
        }
        assertEquals(0,DriveSenseP6Jobs.previewTargetOrdinal(10003,160,0));
        assertEquals(10002,DriveSenseP6Jobs.previewTargetOrdinal(10003,160,159));
        List<Integer> pageScanned=new ArrayList<>();
        for(int pageStart=0;pageStart<10003;pageStart+=128){
            int pageEnd=Math.min(10003,pageStart+128);
            for(int index=0;index<160;index++){
                int target=DriveSenseP6Jobs.previewTargetOrdinal(10003,160,index);
                if(target>=pageStart&&target<pageEnd)pageScanned.add(target);
            }
        }
        assertEquals(160,pageScanned.size());
        for(int index=0;index<160;index++)
            assertEquals(DriveSenseP6Jobs.previewTargetOrdinal(10003,160,index),
                pageScanned.get(index).intValue());
    }

    @Test
    public void capturesBoundedTopLevelMetricsBeforeAndAfterRouteAcrossChunks()throws Exception{
        String json="{\"harsh_brakes_count\":2,\"route_points\":[{\"lat\":43.1,\"lng\":-79.1}],"+
            "\"defensive_grade\":\"exemplary\",\"night_driving\":true}";
        byte[]all=json.getBytes(StandardCharsets.UTF_8);
        int split=json.indexOf("defensive")+5;
        DriveSenseP6RoutePointParser.Result first=DriveSenseP6RoutePointParser.consume(
            java.util.Arrays.copyOfRange(all,0,split),0,new JSONObject());
        DriveSenseP6RoutePointParser.Result second=DriveSenseP6RoutePointParser.consume(
            java.util.Arrays.copyOfRange(all,split,all.length),0,first.parserState);
        JSONObject metadata=second.parserState.getJSONObject("metadata");
        assertEquals(2,metadata.getInt("harsh_brakes_count"));
        assertEquals("exemplary",metadata.getString("defensive_grade"));
        assertTrue(metadata.getBoolean("night_driving"));
    }

    @Test
    public void everyChunkTierAndRandomBoundaryProducesTheExactCanonicalSequence()throws Exception{
        JSONArray expected=new JSONArray();
        for(int index=0;index<517;index++)expected.put(new JSONObject()
            .put("lat",-89.0d+index*.01d).put("lng",179.0d-index*.02d)
            .put("timestamp",1_700_000_000_000L+index)
            .put("label",index%17==0?"escaped \\\" brace } bracket ]":"p"+index));
        byte[] source=new JSONObject().put("before","route_points text")
            .put("route_points",expected).put("harsh_brakes_count",7)
            .put("after","tail").toString().getBytes(StandardCharsets.UTF_8);
        int[] tiers={1,2,3,7,31,127,128,129,257,1024,4096};
        for(int tier:tiers)assertParserSequence(source,expected,tier);
        Random random=new Random(0x50365609L);
        for(int round=0;round<20;round++)assertParserSequence(source,expected,1+random.nextInt(8192));
    }

    @Test
    public void radixSelectionMatchesExactPositiveDoubleOrdering(){
        double[] values={91.25,5.0,42.75,42.5,180.0,17.125,60.0,60.0,119.9};
        double[] sorted=values.clone();java.util.Arrays.sort(sorted);
        for(int rank=0;rank<sorted.length;rank++)
            assertEquals(sorted[rank],DriveSenseP6Jobs.selectRoadRankForTest(values,rank),0.0);
    }

    private static void assertParserSequence(byte[]source,JSONArray expected,int chunkBytes)throws Exception{
        JSONObject state=new JSONObject();JSONArray actual=new JSONArray();int sourceOffset=0;
        while(sourceOffset<source.length){
            int end=Math.min(source.length,sourceOffset+chunkBytes);
            byte[] chunk=java.util.Arrays.copyOfRange(source,sourceOffset,end);
            int localOffset=0;
            do{
                DriveSenseP6RoutePointParser.Result result=
                    DriveSenseP6RoutePointParser.consume(chunk,localOffset,state);
                for(int index=0;index<result.points.length();index++)actual.put(result.points.getJSONObject(index));
                assertTrue(result.nextOffset>localOffset||result.done);
                localOffset=result.nextOffset;state=result.parserState;
            }while(localOffset<chunk.length);
            sourceOffset=end;
        }
        assertTrue(state.getBoolean("done"));assertEquals(expected.length(),actual.length());
        for(int index=0;index<expected.length();index++)
            assertEquals(expected.getJSONObject(index).toString(),actual.getJSONObject(index).toString());
        assertEquals(7,state.getJSONObject("metadata").getInt("harsh_brakes_count"));
    }
}
