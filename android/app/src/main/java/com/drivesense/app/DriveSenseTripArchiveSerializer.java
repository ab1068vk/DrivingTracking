package com.drivesense.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

final class DriveSenseTripArchiveSerializer {
    private DriveSenseTripArchiveSerializer() {}

    static void write(JSONObject value, OutputStream output) throws IOException {
        OutputStreamWriter writer = new OutputStreamWriter(output, StandardCharsets.UTF_8);
        writeValue(writer, value);
        writer.flush();
    }

    private static void writeValue(Writer writer, Object value) throws IOException {
        if (value == null || value == JSONObject.NULL) { writer.write("null"); return; }
        if (value instanceof JSONObject) { writeObject(writer, (JSONObject)value); return; }
        if (value instanceof JSONArray) { writeArray(writer, (JSONArray)value); return; }
        if (value instanceof Boolean) { writer.write(Boolean.TRUE.equals(value) ? "true" : "false"); return; }
        if (value instanceof Number) {
            try {
                writer.write(JSONObject.numberToString((Number)value));
            } catch (org.json.JSONException error) {
                throw new IOException("Non-finite JSON number", error);
            }
            return;
        }
        writer.write(JSONObject.quote(String.valueOf(value)));
    }

    private static void writeObject(Writer writer, JSONObject object) throws IOException {
        List<String> keys = new ArrayList<>();
        Iterator<String> iterator = object.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        Collections.sort(keys);
        writer.write('{');
        boolean first = true;
        for (String key : keys) {
            if (!first) writer.write(',');
            first = false;
            writer.write(JSONObject.quote(key));
            writer.write(':');
            writeValue(writer, object.opt(key));
        }
        writer.write('}');
    }

    private static void writeArray(Writer writer, JSONArray array) throws IOException {
        writer.write('[');
        for (int index=0; index<array.length(); index++) {
            if (index>0) writer.write(',');
            writeValue(writer, array.opt(index));
        }
        writer.write(']');
    }
}
