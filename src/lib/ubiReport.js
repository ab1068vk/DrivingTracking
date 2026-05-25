import { clamp } from '@/lib/mathUtils';
import { scoringValue } from '@/lib/scoringConstants';

const MILEAGE_SCORE_WINDOW_DAYS = 365;
const MILEAGE_SCORE_WINDOW_MS = MILEAGE_SCORE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const DEFAULT_OPTIMAL_ANNUAL_KM = scoringValue('UBI_OPTIMAL_ANNUAL_KM');
export const DEFAULT_MILEAGE_SCORE_SPREAD_KM = scoringValue('UBI_MILEAGE_SPREAD_KM');
export const MIN_UBI_REPORT_DISTANCE_KM = scoringValue('UBI_MIN_REPORT_DISTANCE_KM');

/**
 * Approximate UBI time-of-day penalty: this is not calibrated to an insurer
 * or a published geographic risk model. At 150, two-thirds night exposure
 * reaches the category score floor; revise only with documented evidence.
 */
export const TIME_OF_DAY_NIGHT_MULTIPLIER = scoringValue('UBI_NIGHT_MULTIPLIER');

/**
 * Internal UBI-style rate deductions per event/100 km. These constants are
 * approximations for personal feedback, not insurer-validated safe event rates.
 */
export const BRAKING_PENALTY_PER_100KM = scoringValue('UBI_BRAKING_PENALTY_PER_100KM');
export const ACCEL_PENALTY_PER_100KM = scoringValue('UBI_ACCEL_PENALTY_PER_100KM');
export const CORNERING_PENALTY_PER_100KM = scoringValue('UBI_CORNERING_PENALTY_PER_100KM');
export const SPEED_PENALTY_PER_100KM = scoringValue('UBI_SPEED_PENALTY_PER_100KM');

export const UBI_CATEGORY_WEIGHTS = {
  ...scoringValue('UBI_CATEGORY_WEIGHTS'),
};

export function ubiGrade(score) {
  if (score == null || score === '' || !Number.isFinite(Number(score))) return null;
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}

const category = (score, label, value) => ({
  score,
  grade: ubiGrade(score),
  label,
  value,
});

const unavailableCategory = (label, value) => ({
  score: null,
  grade: null,
  label,
  value,
});

export function computeUBIReport(trips = [], settings = {}, vehicles = []) {
  const completed = (trips || []).filter((trip) => trip?.status === 'completed');
  const totalKm = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const totalDrivingMinutes = completed.reduce((sum, trip) => sum + (Number(trip.duration_seconds) || 0) / 60, 0);
  const starts = completed.map((trip) => new Date(trip.start_time).getTime()).filter(Number.isFinite);
  const ends = completed.map((trip) => new Date(trip.end_time || trip.start_time).getTime()).filter(Number.isFinite);

  if (!completed.length) {
    return {
      generatedAt: new Date().toISOString(),
      periodStart: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      periodEnd: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
      tripCount: 0,
      totalKm: 0,
      totalDrivingMinutes: 0,
      ubiScore: null,
      ubiGrade: null,
      ubiTier: null,
      insufficientData: true,
      minimumDistanceKm: MIN_UBI_REPORT_DISTANCE_KM,
      categories: {
        mileage: unavailableCategory('Total mileage', '0.0 km'),
        timeOfDay: unavailableCategory('Time of day', 'Insufficient data'),
        hardBraking: unavailableCategory('Hard braking', 'Insufficient data'),
        acceleration: unavailableCategory('Rapid acceleration', 'Insufficient data'),
        cornering: unavailableCategory('Cornering', 'Insufficient data'),
        speedCompliance: unavailableCategory('Speed compliance', 'Insufficient data'),
      },
      disclaimer: `Complete at least ${MIN_UBI_REPORT_DISTANCE_KM} km before generating a UBI-style score.`,
    };
  }

  if (totalKm < MIN_UBI_REPORT_DISTANCE_KM) {
    return {
      generatedAt: new Date().toISOString(),
      periodStart: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      periodEnd: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
      tripCount: completed.length,
      totalKm: Math.round(totalKm * 10) / 10,
      totalDrivingMinutes: Math.round(totalDrivingMinutes),
      ubiScore: null,
      ubiGrade: null,
      ubiTier: null,
      insufficientData: true,
      minimumDistanceKm: MIN_UBI_REPORT_DISTANCE_KM,
      categories: {
        mileage: unavailableCategory('Total mileage', `${totalKm.toFixed(1)} km`),
        timeOfDay: unavailableCategory('Time of day', 'Insufficient data'),
        hardBraking: unavailableCategory('Hard braking', 'Insufficient data'),
        acceleration: unavailableCategory('Rapid acceleration', 'Insufficient data'),
        cornering: unavailableCategory('Cornering', 'Insufficient data'),
        speedCompliance: unavailableCategory('Speed compliance', 'Insufficient data'),
      },
      disclaimer: `Complete at least ${MIN_UBI_REPORT_DISTANCE_KM} km before generating a UBI-style score.`,
    };
  }

  const nightDrivingMinutes = completed
    .filter((trip) => trip.night_driving === true)
    .reduce((sum, trip) => sum + (Number(trip.duration_seconds) || 0) / 60, 0);
  const nightRatio = totalDrivingMinutes > 0 ? nightDrivingMinutes / totalDrivingMinutes : 0;
  const totalHarshBrakes = completed.reduce((sum, trip) => sum + (Number(trip.harsh_brakes_count) || 0), 0);
  const totalRapidAccel = completed.reduce((sum, trip) => sum + (Number(trip.rapid_accel_count) || 0), 0);
  const totalSharpTurns = completed.reduce((sum, trip) => sum + (Number(trip.sharp_turns_count) || 0), 0);
  const speedingEvents = completed.reduce((sum, trip) => sum + (Number(trip.speeding_events_count) || 0), 0);
  const per100 = (count) => (count / totalKm) * 100;
  const brakesPer100Km = per100(totalHarshBrakes);
  const accelPer100Km = per100(totalRapidAccel);
  const turnsPer100Km = per100(totalSharpTurns);
  const speedingPer100Km = per100(speedingEvents);

  const generatedAt = new Date();
  const mileageWindowEnd = generatedAt.getTime();
  const mileageWindowStart = mileageWindowEnd - MILEAGE_SCORE_WINDOW_MS;
  const mileageWindowKm = completed
    .filter((trip) => {
      const tripTime = new Date(trip.end_time || trip.start_time).getTime();
      return Number.isFinite(tripTime) && tripTime >= mileageWindowStart && tripTime <= mileageWindowEnd;
    })
    .reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);

  const optimalAnnualKm = Number.isFinite(Number(settings.ubi_optimal_annual_km)) && Number(settings.ubi_optimal_annual_km) > 0
    ? Number(settings.ubi_optimal_annual_km)
    : DEFAULT_OPTIMAL_ANNUAL_KM;
  const mileageScoreSpreadKm = Number.isFinite(Number(settings.ubi_mileage_score_spread_km)) && Number(settings.ubi_mileage_score_spread_km) > 0
    ? Number(settings.ubi_mileage_score_spread_km)
    : DEFAULT_MILEAGE_SCORE_SPREAD_KM;
  const mileageScore = clamp(Math.round(
    100 * Math.exp(-0.5 * ((mileageWindowKm - optimalAnnualKm) / mileageScoreSpreadKm) ** 2)
  ), 0, 100);
  const timeOfDayScore = Math.round(Math.max(0, 100 - nightRatio * TIME_OF_DAY_NIGHT_MULTIPLIER));
  const brakingScore = Math.max(0, Math.round(100 - brakesPer100Km * BRAKING_PENALTY_PER_100KM));
  const accelScore = Math.max(0, Math.round(100 - accelPer100Km * ACCEL_PENALTY_PER_100KM));
  const corneringScore = Math.max(0, Math.round(100 - turnsPer100Km * CORNERING_PENALTY_PER_100KM));
  const speedScore = Math.max(0, Math.round(100 - speedingPer100Km * SPEED_PENALTY_PER_100KM));
  const ubiScore = Math.round(
    mileageScore * UBI_CATEGORY_WEIGHTS.mileage +
    timeOfDayScore * UBI_CATEGORY_WEIGHTS.timeOfDay +
    brakingScore * UBI_CATEGORY_WEIGHTS.hardBraking +
    accelScore * UBI_CATEGORY_WEIGHTS.acceleration +
    corneringScore * UBI_CATEGORY_WEIGHTS.cornering +
    speedScore * UBI_CATEGORY_WEIGHTS.speedCompliance
  );
  return {
    generatedAt: generatedAt.toISOString(),
    periodStart: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    periodEnd: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
    tripCount: completed.length,
    totalKm: Math.round(totalKm * 10) / 10,
    totalDrivingMinutes: Math.round(totalDrivingMinutes),
    ubiScore,
    ubiGrade: ubiGrade(ubiScore),
    ubiTier: ubiScore >= 85 ? 'Preferred' : ubiScore >= 70 ? 'Standard' : 'Non-preferred',
    insufficientData: false,
    categories: {
      mileage: category(mileageScore, '12-month mileage', `${mileageWindowKm.toFixed(1)} km`),
      timeOfDay: category(timeOfDayScore, 'Time of day', `${(nightRatio * 100).toFixed(0)}% night`),
      hardBraking: category(brakingScore, 'Hard braking', `${brakesPer100Km.toFixed(1)}/100 km`),
      acceleration: category(accelScore, 'Rapid acceleration', `${accelPer100Km.toFixed(1)}/100 km`),
      cornering: category(corneringScore, 'Cornering', `${turnsPer100Km.toFixed(1)}/100 km`),
      speedCompliance: category(speedScore, 'Speed compliance', `${speedingPer100Km.toFixed(1)}/100 km`),
    },
    assumptions: {
      optimalAnnualKm,
      mileageScoreSpreadKm,
    },
    disclaimer: `Estimated score only. This UBI-style report uses internal GPS-derived approximations and is not an insurer-validated insurance rating, eligibility decision, or pricing estimate. Mileage scoring assumes an optimal ${optimalAnnualKm.toLocaleString()} km/year; adjust this in Settings if your region or use case differs.`,
  };
}
