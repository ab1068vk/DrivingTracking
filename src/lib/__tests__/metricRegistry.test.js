import { describe, expect, it } from 'vitest';
import {
  CSV_METRIC_COLUMNS,
  CSV_RAW_COLUMNS,
  COMPONENT_METRIC_KEYS,
  METRIC_REGISTRY,
  MONTHLY_PDF_METRIC_KEYS,
  UBI_PDF_METRIC_KEYS,
} from '@/lib/metricRegistry';
import { calculateTripScores, DEFAULT_THRESHOLDS, tripsToCSV } from '@/lib/tripEngine';

const isCalculatedMetricField = ([key, value]) => (
  (Number.isFinite(value) || value == null) &&
  (
    key.startsWith('score_') ||
    /(_score|_count|_seconds|_ratio|_index|_bonus)$/.test(key)
  ) &&
  !key.endsWith('_confidence')
);

describe('metric registry', () => {
  it('registers each typed component and calculated numeric trip metric', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 10, duration_seconds: 600, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      DEFAULT_THRESHOLDS,
      600
    );
    const emittedMetricKeys = Object.entries(scores)
      .filter(isCalculatedMetricField)
      .map(([key]) => key);
    const unregisteredOutput = emittedMetricKeys.filter((key) => !METRIC_REGISTRY[key]);
    const unregisteredComponents = Object.entries(COMPONENT_METRIC_KEYS)
      .filter(([component, metricKey]) => !scores.component_scores[component] || !METRIC_REGISTRY[metricKey]);
    const componentsWithoutEvidenceThresholds = Object.values(COMPONENT_METRIC_KEYS)
      .filter((metricKey) => (
        !Number.isFinite(METRIC_REGISTRY[metricKey]?.minDistanceKm) ||
        !Number.isFinite(METRIC_REGISTRY[metricKey]?.minSamples)
      ));

    expect(unregisteredOutput).toEqual([]);
    expect(unregisteredComponents).toEqual([]);
    expect(componentsWithoutEvidenceThresholds).toEqual([]);
  });

  it('registers all annotated CSV and PDF report metrics', () => {
    const reportMetricKeys = [
      ...Object.values(CSV_METRIC_COLUMNS),
      ...MONTHLY_PDF_METRIC_KEYS,
      ...UBI_PDF_METRIC_KEYS,
    ];

    expect(reportMetricKeys.filter((key) => !METRIC_REGISTRY[key])).toEqual([]);
  });

  it('adds registry metadata below CSV metric headers', () => {
    const lines = tripsToCSV([]).split('\n');
    const headers = lines[0].slice(1, -1).split('","');

    expect(lines[0]).toContain('"Safety"');
    expect(lines[0]).toContain('"Attention-Pattern Estimate"');
    expect(lines[0]).not.toContain('"Focus Score"');
    expect(METRIC_REGISTRY.distraction_score.label).toBe('Attention-Pattern Estimate');
    expect(headers.filter((header) => !CSV_METRIC_COLUMNS[header] && !CSV_RAW_COLUMNS.includes(header))).toEqual([]);
    expect(lines[1]).toContain('"Metric Metadata"');
    expect(lines[1]).toContain('Safety Pattern Estimate: Penalises harsh braking');
    expect(lines[1]).toContain('gps_events; speed_limit_osm; phone_use_usage_access');
  });
});
