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

  it('exposes phone-use permission requirements for UI unavailable states', () => {
    expect(METRIC_REGISTRY.phone_use_score).toMatchObject({
      permission_required: 'android_usage_access',
    });
    expect(METRIC_REGISTRY.phone_use_score.permissionRequiredNote).toContain('Android Usage Access');
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
    expect(METRIC_REGISTRY.score_safety.dataSources).toEqual(expect.arrayContaining(['obd_bluetooth']));
  });

  it('prefixes exported score values as estimates', () => {
    const csv = tripsToCSV([{
      id: 'trip-1',
      status: 'completed',
      start_time: '2026-05-01T08:00:00.000Z',
      end_time: '2026-05-01T08:15:00.000Z',
      duration_seconds: 900,
      distance_km: 10,
      score_overall: 82,
      score_safety: 80,
      score_smoothness: 84,
    }]);

    expect(csv).toContain('"~82","~80","~84"');
    expect(csv).not.toContain('"Eco Score Estimate"');
  });
});
