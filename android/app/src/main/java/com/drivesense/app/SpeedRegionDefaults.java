package com.drivesense.app;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Regional speed-limit defaults for the background service.
 *
 * When no saved road speed matches, the service used to fall back to a flat
 * `threshold_speeding_kmh` (100 km/h) and treat that guess as speakable. The
 * webview never does either: it resolves a regional default for the road context
 * it inferred from GPS behaviour, and because that source carries a confidence of
 * {@link #REGION_DEFAULT_CONFIDENCE} it sits below the alert floor and is never
 * spoken. A background drive down a residential street therefore assumed 100 km/h
 * and announced nothing until 112, where a foreground drive assumed 50 and stayed
 * deliberately quiet.
 *
 * This mirrors REGION_SPEED_DEFAULTS and roadContextFromGpsBehaviour in
 * src/lib/speedLimitSource.js, plus zoneFromP85 in src/lib/tripEngine.js.
 * src/lib/__tests__/nativeSpeedRegionParity.test.js parses {@link #TABLE} and
 * fails if the two tables drift, so this file is hand-written but not unchecked.
 */
final class SpeedRegionDefaults {

    /**
     * Confidence of a regional default and of a purely GPS-inferred limit, from
     * SPEED_LIMIT_SOURCE_PROFILES in src/lib/speedLimitConfidence.js. Both are
     * below SPEED_ALERT_MIN_CONFIDENCE, which is the whole point: an estimate this
     * weak may inform a recorded event but must never be spoken aloud.
     */
    static final double REGION_DEFAULT_CONFIDENCE = 0.40d;
    static final double GPS_INFERRED_CONFIDENCE = 0.35d;

    static final String SOURCE_REGION_DEFAULT = "region_default_estimate";

    /** The key REGION_SPEED_DEFAULTS uses for a country's province-independent row. */
    private static final String COUNTRY_ROW = "_country";

    /**
     * `COUNTRY|REGION|context:kmh,...` rows, one per region, `null` where a region
     * publishes no limit at all (German motorways).
     *
     * A packed string rather than a block of map literals so the parity test can
     * compare it to the JavaScript object without parsing Java.
     */
    private static final String TABLE =
        "CA|_country|urban:50,suburban:60,rural:80,expressway:100;" +
        "CA|ON|urban:50,suburban:60,rural:80,expressway:100;" +
        "CA|BC|urban:50,suburban:60,rural:80,expressway:90,highway:100;" +
        "CA|AB|urban:50,suburban:60,rural:100,highway:110;" +
        "CA|QC|urban:50,suburban:70,rural:90,highway:100;" +
        "CA|MB|urban:50,suburban:60,rural:90,highway:100;" +
        "CA|SK|urban:50,suburban:60,rural:100,highway:110;" +
        "US|_country|residential:40,urban:56,rural:88,highway:104;" +
        "US|CA|urban:40,rural:88,highway:104;" +
        "US|TX|urban:56,rural:112,highway:120;" +
        "US|NY|residential:40,urban:56,rural:88,highway:104;" +
        "GB|_country|urban:48,rural_single:96,dual_carriageway:112,motorway:112;" +
        "GB|ENG|urban:48,rural_single:96,dual_carriageway:112,motorway:112;" +
        "GB|WLS|urban:32,rural_single:96,dual_carriageway:112,motorway:112;" +
        "DE|_country|urban:50,rural:100,motorway:null,motorwayAdvisory:130;" +
        "AU|_country|urban:50,rural:100,highway:110;" +
        "AU|NSW|urban:50,rural:100,highway:110;" +
        "AU|VIC|urban:50,rural:100,highway:110;" +
        "AU|QLD|urban:50,rural:100,highway:110;" +
        "FR|_country|urban:50,secondary:80,national:80,expressway:110,autoroute:130;" +
        "GLOBAL|_country|urban:50,suburban:60,rural:80,expressway:100,highway:100";

    /** country -> region -> road context -> km/h, with a null value meaning "no limit". */
    private static final Map<String, Map<String, Map<String, Double>>> DEFAULTS = parseTable(TABLE);

    private SpeedRegionDefaults() {
    }

    private static Map<String, Map<String, Map<String, Double>>> parseTable(String table) {
        Map<String, Map<String, Map<String, Double>>> countries = new LinkedHashMap<>();
        for (String row : table.split(";")) {
            String[] parts = row.split("\\|");
            if (parts.length != 3) continue;
            Map<String, Double> limits = new LinkedHashMap<>();
            for (String entry : parts[2].split(",")) {
                int colon = entry.indexOf(':');
                if (colon <= 0) continue;
                String context = entry.substring(0, colon);
                String value = entry.substring(colon + 1);
                // containsKey stays true for these, which is what distinguishes
                // "this region publishes no limit" from "we have no row for it".
                limits.put(context, "null".equals(value) ? null : Double.parseDouble(value));
            }
            Map<String, Map<String, Double>> country = countries.get(parts[0]);
            if (country == null) {
                country = new LinkedHashMap<>();
                countries.put(parts[0], country);
            }
            country.put(parts[1], Collections.unmodifiableMap(limits));
        }
        return Collections.unmodifiableMap(countries);
    }

    /**
     * Split a `configurable_country_defaults` value (`"CA-ON"`, `"global"`) into a
     * country and an optional province, matching speedDefaultRegionFromSettings.
     *
     * @return `{ countryCode, provinceCode }`, the province null when unset.
     */
    static String[] regionFromSetting(String raw) {
        String value = raw == null ? "" : raw.trim();
        int dash = value.indexOf('-');
        String country = dash < 0 ? value : value.substring(0, dash);
        String province = dash < 0 ? "" : value.substring(dash + 1);
        boolean global = country.isEmpty() || "global".equalsIgnoreCase(country);
        return new String[] {
            global ? "GLOBAL" : country.toUpperCase(Locale.US),
            province.isEmpty() ? null : province.toUpperCase(Locale.US),
        };
    }

    /**
     * The regional default for a road context, or NaN where the JavaScript
     * resolver would return null (unknown context, or a region with no limit).
     */
    static double estimateKmh(String countryCode, String provinceCode, String roadContext) {
        if (roadContext == null || roadContext.isEmpty()) return Double.NaN;
        String countryKey = countryCode == null || countryCode.isEmpty()
            ? "GLOBAL"
            : countryCode.toUpperCase(Locale.US);
        Map<String, Map<String, Double>> country = DEFAULTS.get(countryKey);
        if (country == null) country = DEFAULTS.get("GLOBAL");
        Map<String, Double> countryRow = country.get(COUNTRY_ROW);
        Map<String, Double> region = countryRow;
        if (provinceCode != null && !provinceCode.isEmpty()) {
            Map<String, Double> province = country.get(provinceCode.toUpperCase(Locale.US));
            if (province != null) region = province;
        }

        Double direct = coalesce(region, countryRow, roadContext);
        if (defines(region, countryRow, roadContext)) {
            return direct == null ? Double.NaN : direct;
        }
        // `highway` is the GPS-inferred name for what a mapped table calls a
        // motorway, so it is the one context worth a second lookup.
        if ("highway".equals(roadContext)) {
            Double motorway = coalesce(region, countryRow, "motorway");
            return motorway == null ? Double.NaN : motorway;
        }
        return Double.NaN;
    }

    private static Double coalesce(Map<String, Double> region, Map<String, Double> countryRow, String key) {
        Double value = region == null ? null : region.get(key);
        if (value != null) return value;
        return countryRow == null ? null : countryRow.get(key);
    }

    private static boolean defines(Map<String, Double> region, Map<String, Double> countryRow, String key) {
        return (region != null && region.containsKey(key)) ||
            (countryRow != null && countryRow.containsKey(key));
    }

    /** roadContextFromGpsBehaviour in src/lib/speedLimitSource.js. */
    static String roadContextFromGpsBehaviour(double inferredZoneKmh) {
        if (inferredZoneKmh <= 50d) return "urban";
        if (inferredZoneKmh <= 80d) return "suburban";
        if (inferredZoneKmh <= 100d) return "rural";
        return "highway";
    }

    /** zoneFromP85 in src/lib/tripEngine.js: recent driving speed to a zone. */
    static double zoneKmhFromP85(double p85Kmh) {
        if (p85Kmh < 30d) return 30d;
        if (p85Kmh < 55d) return 50d;
        if (p85Kmh < 80d) return 70d;
        if (p85Kmh < 110d) return 100d;
        return 120d;
    }

    /** complianceFallbackLimit in src/lib/speedLimitSource.js. */
    static double complianceFallbackLimitKmh(String roadContext, double speedingFallbackKmh) {
        if ("urban".equals(roadContext)) return 50d;
        if ("suburban".equals(roadContext)) return 60d;
        if ("rural".equals(roadContext)) return 80d;
        if ("expressway".equals(roadContext)) return 100d;
        return speedingFallbackKmh;
    }

    /**
     * The limit to assume when nothing has been saved for this road, or NaN when
     * recent speeds say nothing useful.
     *
     * @param regionSetting      `configurable_country_defaults`, e.g. "CA-ON"
     * @param p85Kmh             85th percentile of recent speeds
     * @param speedingFallbackKmh the driver's `threshold_speeding_kmh`
     */
    static double fallbackLimitKmh(String regionSetting, double p85Kmh, double speedingFallbackKmh) {
        if (!Double.isFinite(p85Kmh) || p85Kmh <= 0d) return Double.NaN;
        String[] region = regionFromSetting(regionSetting);
        String roadContext = roadContextFromGpsBehaviour(zoneKmhFromP85(p85Kmh));
        double estimate = estimateKmh(region[0], region[1], roadContext);
        if (!Double.isFinite(estimate) || estimate <= 0d) return Double.NaN;
        // Only the global table is clamped. A driver who named their region asked
        // for that region's numbers, and quietly capping them with a generic
        // speeding threshold would be answering a different question.
        if (!"GLOBAL".equals(region[0])) return estimate;
        return Math.min(estimate, complianceFallbackLimitKmh(roadContext, speedingFallbackKmh));
    }

    /** Linear-interpolated percentile over ascending values; percentileFromSorted in tripEngine.js. */
    static double percentileFromSorted(double[] sortedValues, double percentile) {
        if (sortedValues == null || sortedValues.length == 0) return 0d;
        double index = (percentile / 100d) * (sortedValues.length - 1);
        int lower = (int) Math.floor(index);
        int upper = (int) Math.ceil(index);
        if (lower == upper) return sortedValues[lower];
        return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
    }
}
