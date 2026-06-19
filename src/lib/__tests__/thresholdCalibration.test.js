import { describe, expect, it } from 'vitest';
import {
  applyCalibrationProfile,
  computeCalibrationProfile,
  summarizeCalibrationSurveyLabels,
  summarizeSurveyCoverage,
} from '@/lib/thresholdCalibration';

const point = (seconds, speedKmh) => ({
  lat: 43.6532 + seconds * 0.0001,
  lng: -79.3832,
  speed_kmh: speedKmh,
  accuracy: 5,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString(),
});

const trip = (index, distanceKm = 15, speeds = [20, 80, 20]) => ({
  id: `t${index}`,
  status: 'completed',
  distance_km: distanceKm,
  start_time: new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString(),
  end_time: new Date(Date.UTC(2026, 0, index + 1, 13)).toISOString(),
  route_points: speeds.map((speed, i) => point(i * 5, speed)),
  driving_events: [],
});

const thresholds = {
  HARSH_BRAKE_MS2: 4.5,
  RAPID_ACCEL_MS2: 3.5,
  SHARP_TURN_G_LOW: 0.3,
  SHARP_TURN_G_MEDIUM: 0.45,
  SHARP_TURN_G_HIGH: 0.6,
};

describe('thresholdCalibration', () => {
  it('returns insufficient when fewer than 15 trips', () => {
    expect(computeCalibrationProfile([trip(1)], thresholds).insufficient).toBe(true);
  });

  it('allows calibration after the trip threshold even when total distance is short', () => {
    const profile = computeCalibrationProfile(Array.from({ length: 15 }, (_, i) => trip(i, 5)), thresholds);
    expect(profile.insufficient).toBe(false);
  });

  it('clamps suggested harsh brake threshold to [3.0, 7.0]', () => {
    const profile = computeCalibrationProfile(Array.from({ length: 15 }, (_, i) => trip(i, 20, [120, 0])), thresholds);
    expect(profile.suggested.threshold_harsh_brake_ms2).toBeLessThanOrEqual(7);
    expect(profile.suggested.threshold_harsh_brake_ms2).toBeGreaterThanOrEqual(3);
  });

  it('clamps suggested rapid acceleration threshold to [2.0, 6.0]', () => {
    const profile = computeCalibrationProfile(Array.from({ length: 15 }, (_, i) => trip(i, 20, [0, 120])), thresholds);
    expect(profile.suggested.threshold_rapid_accel_ms2).toBeLessThanOrEqual(6);
    expect(profile.suggested.threshold_rapid_accel_ms2).toBeGreaterThanOrEqual(2);
  });

  it('applyCalibrationProfile merges into settings', async () => {
    let saved = null;
    const profile = {
      suggested: { threshold_harsh_brake_ms2: 5, threshold_rapid_accel_ms2: 4 },
    };
    const settings = await applyCalibrationProfile(profile, { units: 'metric' }, async (next) => { saved = next; });

    expect(settings.threshold_harsh_brake_ms2).toBe(5);
    expect(saved.threshold_rapid_accel_ms2).toBe(4);
  });

  it('computes delta as suggested minus current', () => {
    const profile = computeCalibrationProfile(Array.from({ length: 15 }, (_, i) => trip(i, 20)), thresholds);
    expect(profile.delta.threshold_harsh_brake_ms2).toBeCloseTo(
      profile.suggested.threshold_harsh_brake_ms2 - profile.current.threshold_harsh_brake_ms2,
      1
    );
  });

  it('uses repeated wrong event feedback even before the mileage baseline is met', () => {
    const profile = computeCalibrationProfile([
      {
        ...trip(1, 10, [30, 35, 32]),
        event_feedback: {
          e1: { type: 'harsh_brake', verdict: 'wrong', value: 4.9 },
          e2: { type: 'harsh_brake', verdict: 'wrong', value: 5.2 },
          e3: { type: 'rapid_acceleration', verdict: 'accurate', value: 3.3 },
        },
      },
    ], thresholds);

    expect(profile.insufficient).toBe(false);
    expect(profile.feedbackSummary.total).toBe(3);
    expect(profile.suggested.threshold_harsh_brake_ms2).toBeGreaterThan(thresholds.HARSH_BRAKE_MS2);
  });

  it('keeps turn feedback calibration at two-decimal g precision', () => {
    const profile = computeCalibrationProfile([
      {
        ...trip(1, 10, [30, 35, 32]),
        event_feedback: {
          e1: { type: 'sharp_turn', verdict: 'wrong', value: 0.51 },
          e2: { type: 'sharp_turn', verdict: 'wrong', value: 0.52 },
          e3: { type: 'sharp_turn', verdict: 'wrong', value: 0.53 },
        },
      },
    ], thresholds);

    expect(profile.suggested.threshold_sharp_turn_g_medium).toBe(0.58);
    expect(profile.delta.threshold_sharp_turn_g_medium).toBe(0.13);
  });

  it('summarizes survey labels as a score calibration signal', () => {
    const labels = [
      {
        eligibleForCalibration: true,
        upload_status: 'local_only',
        scoreOutput: { overall: 62 },
        surveyLabel: {
          overallDriveRating: 4,
          targetScore: 75,
          scoreAccuracy: 'too_low',
          wasDriver: 'yes',
          contextTags: ['traffic', 'weather'],
        },
      },
      {
        eligibleForCalibration: true,
        upload_status: 'uploaded',
        scoreOutput: { overall: 70 },
        surveyLabel: {
          overallDriveRating: 5,
          targetScore: 100,
          scoreAccuracy: 'too_low',
          wasDriver: 'yes',
          contextTags: ['traffic'],
        },
      },
    ];

    const summary = summarizeCalibrationSurveyLabels(labels);

    expect(summary).toMatchObject({
      total: 2,
      usable: 2,
      averageScoreDelta: 21.5,
      direction: 'scores_feel_too_harsh',
      scoreAccuracy: { tooLow: 2 },
      uploadStatus: { uploaded: 1, localOnly: 1 },
    });
    expect(summary.topContextTags[0]).toEqual({ tag: 'traffic', count: 2 });
  });

  it('includes survey summary in computed calibration profiles', () => {
    const profile = computeCalibrationProfile(Array.from({ length: 15 }, (_, i) => trip(i, 20)), thresholds, {
      surveyLabels: [{
        eligibleForCalibration: true,
        scoreOutput: { overall: 95 },
        surveyLabel: { overallDriveRating: 2, targetScore: 25, scoreAccuracy: 'too_high', wasDriver: 'yes' },
      }],
    });

    expect(profile.surveySummary).toMatchObject({
      total: 1,
      usable: 1,
      direction: 'scores_feel_too_generous',
    });
  });

  it('uses three consistent too-harsh score reviews to influence a personal threshold suggestion', () => {
    const surveyLabels = Array.from({ length: 3 }, (_, index) => ({
      eligibleForCalibration: true,
      scoreOutput: { overall: 70 + index },
      surveyLabel: {
        scoreAccuracy: 'too_low',
        scoreIssueTypes: ['harsh_brake'],
        overallDriveRating: 4,
        targetScore: 80 + index,
        wasDriver: 'yes',
      },
    }));
    const profile = computeCalibrationProfile([trip(1, 10, [30, 35, 32])], thresholds, { surveyLabels });

    expect(profile.insufficient).toBe(false);
    expect(profile.surveyThresholdSignals).toContainEqual(expect.objectContaining({
      issueType: 'harsh_brake',
      responseCount: 3,
      thresholdKey: 'threshold_harsh_brake_ms2',
    }));
    expect(profile.suggested.threshold_harsh_brake_ms2).toBeGreaterThan(thresholds.HARSH_BRAKE_MS2);
  });

  it('summarizes survey coverage by road type and context', () => {
    const labels = [
      {
        tripFeatureSummary: { cityRoadRatio: 0.8, highwayRoadRatio: 0.1, nightDrive: false, distanceKm: 8 },
        surveyLabel: { overallDriveRating: 4, contextTags: ['traffic'] },
      },
      {
        tripFeatureSummary: { cityRoadRatio: 0.1, highwayRoadRatio: 0.7, nightDrive: true, distanceKm: 12 },
        surveyLabel: { overallDriveRating: 3, contextTags: ['weather', 'gps_issue'] },
      },
      {
        tripFeatureSummary: { cityRoadRatio: 0.2, highwayRoadRatio: 0.2, nightDrive: false, distanceKm: 1.2 },
        surveyLabel: { overallDriveRating: 5, contextTags: [] },
      },
    ];

    expect(summarizeSurveyCoverage(labels)).toMatchObject({
      usable: 3,
      buckets: {
        city: 1,
        highway: 1,
        mixed: 1,
        night: 1,
        short: 1,
        traffic: 1,
        weather: 1,
        gpsIssue: 1,
      },
      enoughBreadth: false,
    });
  });
});
