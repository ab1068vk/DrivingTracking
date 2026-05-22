const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const MILEAGE_SCORE_WINDOW_DAYS = 365;
const MILEAGE_SCORE_WINDOW_MS = MILEAGE_SCORE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const UBI_CATEGORY_WEIGHTS = {
  mileage: 0.15,
  timeOfDay: 0.20,
  hardBraking: 0.25,
  acceleration: 0.20,
  cornering: 0.10,
  speedCompliance: 0.10,
};

export function ubiGrade(score) {
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

export function computeUBIReport(trips = [], settings = {}, vehicles = []) {
  const completed = (trips || []).filter((trip) => trip?.status === 'completed');
  const totalKm = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const totalDrivingMinutes = completed.reduce((sum, trip) => sum + (Number(trip.duration_seconds) || 0) / 60, 0);

  if (!completed.length) {
    return {
      generatedAt: new Date().toISOString(),
      periodStart: null,
      periodEnd: null,
      tripCount: 0,
      totalKm: 0,
      totalDrivingMinutes: 0,
      ubiScore: 0,
      ubiGrade: 'D',
      ubiTier: 'Non-preferred',
      categories: {
        mileage: category(0, 'Total mileage', '0.0 km'),
        timeOfDay: category(0, 'Time of day', '0% night'),
        hardBraking: category(0, 'Hard braking', '0.0/100 km'),
        acceleration: category(0, 'Rapid acceleration', '0.0/100 km'),
        cornering: category(0, 'Cornering', '0.0/100 km'),
        speedCompliance: category(0, 'Speed compliance', '0.0/100 km'),
      },
      disclaimer: 'This score is estimated from GPS data collected by Road Sage. It is not an official insurance rating.',
    };
  }

  const nightTrips = completed.filter((trip) => trip.night_driving === true);
  const nightRatio = nightTrips.length / Math.max(1, completed.length);
  const totalHarshBrakes = completed.reduce((sum, trip) => sum + (Number(trip.harsh_brakes_count) || 0), 0);
  const totalRapidAccel = completed.reduce((sum, trip) => sum + (Number(trip.rapid_accel_count) || 0), 0);
  const totalSharpTurns = completed.reduce((sum, trip) => sum + (Number(trip.sharp_turns_count) || 0), 0);
  const speedingEvents = completed.reduce((sum, trip) => sum + (Number(trip.speeding_events_count) || 0), 0);
  const per100 = (count) => (count / Math.max(1, totalKm)) * 100;
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

  const mileageScore = clamp(Math.round(100 - Math.max(0, (mileageWindowKm - 1000) / 1000) * 5), 20, 100);
  const timeOfDayScore = Math.round(Math.max(0, 100 - nightRatio * 150));
  const brakingScore = Math.max(0, Math.round(100 - brakesPer100Km * 8));
  const accelScore = Math.max(0, Math.round(100 - accelPer100Km * 8));
  const corneringScore = Math.max(0, Math.round(100 - turnsPer100Km * 6));
  const speedScore = Math.max(0, Math.round(100 - speedingPer100Km * 10));
  const ubiScore = Math.round(
    mileageScore * UBI_CATEGORY_WEIGHTS.mileage +
    timeOfDayScore * UBI_CATEGORY_WEIGHTS.timeOfDay +
    brakingScore * UBI_CATEGORY_WEIGHTS.hardBraking +
    accelScore * UBI_CATEGORY_WEIGHTS.acceleration +
    corneringScore * UBI_CATEGORY_WEIGHTS.cornering +
    speedScore * UBI_CATEGORY_WEIGHTS.speedCompliance
  );
  const starts = completed.map((trip) => new Date(trip.start_time).getTime()).filter(Number.isFinite);
  const ends = completed.map((trip) => new Date(trip.end_time || trip.start_time).getTime()).filter(Number.isFinite);

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
    categories: {
      mileage: category(mileageScore, '12-month mileage', `${mileageWindowKm.toFixed(1)} km`),
      timeOfDay: category(timeOfDayScore, 'Time of day', `${(nightRatio * 100).toFixed(0)}% night`),
      hardBraking: category(brakingScore, 'Hard braking', `${brakesPer100Km.toFixed(1)}/100 km`),
      acceleration: category(accelScore, 'Rapid acceleration', `${accelPer100Km.toFixed(1)}/100 km`),
      cornering: category(corneringScore, 'Cornering', `${turnsPer100Km.toFixed(1)}/100 km`),
      speedCompliance: category(speedScore, 'Speed compliance', `${speedingPer100Km.toFixed(1)}/100 km`),
    },
    disclaimer: 'This score is estimated from GPS data collected by Road Sage. It is not an official insurance rating.',
  };
}
