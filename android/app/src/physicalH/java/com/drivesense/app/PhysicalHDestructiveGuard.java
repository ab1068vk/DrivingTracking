package com.drivesense.app;

import android.content.Context;
import android.provider.Settings;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/** Single fail-closed gate for every mutating Physical H case. */
public final class PhysicalHDestructiveGuard {
    public static final String REQUIRED_PACKAGE = "com.drivesense.app.p35h";

    private PhysicalHDestructiveGuard() {}

    public static Decision evaluate(String packageId, String observedAndroidId, String embeddedAllowlist) {
        Set<String> allowlist = parseAllowlist(embeddedAllowlist);
        Decision preflight = preflight(packageId, allowlist);
        if (preflight != null) return preflight;
        String androidId = clean(observedAndroidId);
        if (androidId.isEmpty()) return Decision.refused("PHYSICAL_H_ANDROID_ID_UNAVAILABLE");
        if (!allowlist.contains(androidId)) return Decision.refused("PHYSICAL_H_ANDROID_ID_NOT_APPROVED");
        return Decision.allowed(androidId);
    }

    public static Decision evaluate(Context context) {
        String packageId = context == null ? "" : context.getPackageName();
        Set<String> allowlist = parseAllowlist(BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS);
        Decision preflight = preflight(packageId, allowlist);
        if (preflight != null) return preflight;
        return evaluate(packageId, readAndroidId(context), BuildConfig.PHYSICAL_H_APPROVED_ANDROID_IDS);
    }

    public static Decision require(Context context) {
        Decision decision = evaluate(context);
        if (!decision.allowed) throw new GuardRefusal(decision.code);
        return decision;
    }

    static Set<String> parseAllowlist(String raw) {
        String source = clean(raw);
        if (source.isEmpty()) return Collections.emptySet();
        Set<String> values = new LinkedHashSet<>();
        for (String value : source.split("[,;\\r\\n]+")) {
            String androidId = clean(value);
            if (!androidId.isEmpty()) values.add(androidId);
        }
        return Collections.unmodifiableSet(values);
    }

    static String readAndroidId(Context context) {
        if (context == null) return "";
        try {
            return clean(Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID));
        } catch (RuntimeException unavailable) {
            return "";
        }
    }

    private static Decision preflight(String packageId, Set<String> allowlist) {
        if (!REQUIRED_PACKAGE.equals(clean(packageId))) {
            return Decision.refused("PHYSICAL_H_WRONG_PACKAGE");
        }
        if (allowlist.isEmpty()) return Decision.refused("PHYSICAL_H_ANDROID_ID_ALLOWLIST_EMPTY");
        return null;
    }

    private static String clean(String value) { return value == null ? "" : value.trim(); }

    public static final class Decision {
        public final boolean allowed;
        public final String code;
        public final String approvedAndroidId;

        private Decision(boolean allowed, String code, String approvedAndroidId) {
            this.allowed = allowed;
            this.code = code;
            this.approvedAndroidId = approvedAndroidId;
        }

        static Decision refused(String code) { return new Decision(false, code, ""); }
        static Decision allowed(String androidId) { return new Decision(true, "PHYSICAL_H_GUARD_APPROVED", androidId); }
    }

    public static final class GuardRefusal extends SecurityException {
        public final String code;
        GuardRefusal(String code) {
            super(code);
            this.code = code;
        }
    }
}
