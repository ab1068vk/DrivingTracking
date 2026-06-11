package com.drivesense.app;

import java.util.List;

public class RaspResult {
    public final boolean secure;
    public final List<String> threats;

    public RaspResult(boolean secure, List<String> threats) {
        this.secure = secure;
        this.threats = threats;
    }
}
