import { clamp, pearsonCorrelation } from '@/lib/mathUtils';
import { scoringValue } from '@/lib/scoringConstants';

const SIGNAL_DECAY_MIN_HALF_LIFE_DAYS = scoringValue('SIGNAL_DECAY_MIN_HALF_LIFE_DAYS') ?? 7;
const SIGNAL_DECAY_MAX_HALF_LIFE_DAYS = scoringValue('SIGNAL_DECAY_MAX_HALF_LIFE_DAYS') ?? 60;
const SIGNAL_DECAY_DEFAULT_HALF_LIFE_DAYS = scoringValue('SIGNAL_DECAY_DEFAULT_HALF_LIFE_DAYS') ?? 21;
const SIGNAL_DECAY_AUTOCORR_THRESHOLD = scoringValue('SIGNAL_DECAY_AUTOCORR_THRESHOLD') ?? 0.5;
const SIGNAL_DECAY_MIN_TRIPS_FOR_AUTOCORR = scoringValue('SIGNAL_DECAY_MIN_TRIPS_FOR_AUTOCORR') ?? 20;

const HABIT_CONSTANTS = {
  MIN_TRIPS_FOR_BUCKET: 3,
  MIN_TRIPS_FOR_DAY: 2,
  MIN_TRIPS_FOR_HOUR: 2,
  FULL_CALIBRATION_TRIPS: 30,
  TREND_WINDOW: 20,
  DEFAULT_AVG_SCORE: 70,
  DEFAULT_NEUTRAL_SCORE: 50,
  DEFAULT_FATIGUE_ONSET_MINUTES: 90,
  MIN_MULTI_TRIP_DAYS_FOR_FATIGUE: 10,
  FATIGUE_DROP_POINTS: 10,
};

const DEFAULT_HOURLY_RISK_PROFILE = scoringValue('DEFAULT_HOURLY_RISK_PROFILE');

const TIME_BUCKETS = ['Morning', 'Afternoon', 'Evening', 'Night'];

const FATIGUE_BANDS = [
  { min: 0, max: 30, midpoint: 15 },
  { min: 30, max: 60, midpoint: 45 },
  { min: 60, max: 90, midpoint: 75 },
  { min: 90, max: 120, midpoint: 105 },
  { min: 120, max: Infinity, midpoint: 135 },
];

export { clamp };

const getTripStartDate = (trip) => {
  const raw = trip?.startedAt ?? trip?.start_time ?? trip?.startTime ?? trip?.created_date;
  const date = new Date(raw || 0);
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null;
};

const getTripEndDate = (trip) => {
  const raw = trip?.endedAt ?? trip?.end_time ?? trip?.endTime ?? trip?.startedAt ?? trip?.start_time ?? trip?.startTime;
  const date = new Date(raw || 0);
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null;
};

const getTripScore = (trip) => {
  const score = Number(trip?.score ?? trip?.score_overall ?? trip?.overall_score);
  return Number.isFinite(score) ? clamp(score, 0, 100) : null;
};

const getTripDurationMinutes = (trip) => {
  const movingSeconds = Number(trip?.duration_seconds) - Number(trip?.idle_time_seconds || 0);
  if (Number.isFinite(movingSeconds) && movingSeconds > 0) return movingSeconds / 60;

  const start = getTripStartDate(trip);
  const end = new Date(trip?.endedAt ?? trip?.end_time ?? trip?.endTime ?? 0);
  if (!start || !Number.isFinite(end.getTime()) || end <= start) return 0;
  return Math.max(0, (end.getTime() - start.getTime()) / 60000);
};

const getLocalDayKey = (date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');

const getStats = (scores) => {
  if (!scores.length) {
    return {
      avgScore: null,
      riskScore: HABIT_CONSTANTS.DEFAULT_NEUTRAL_SCORE,
      stdDev: 0,
      tripCount: 0,
    };
  }

  const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + (score - avgScore) ** 2, 0) / scores.length;

  return {
    avgScore: Math.round(avgScore * 10) / 10,
    riskScore: clamp(Math.round(100 - avgScore), 0, 100),
    stdDev: Math.round(Math.sqrt(variance) * 10) / 10,
    tripCount: scores.length,
  };
};

/**
 * Resolve a local hour into the Road Sage time bucket label.
 * @param {number} hour - Local hour from 0 to 23.
 * @returns {'Morning'|'Afternoon'|'Evening'|'Night'} Matching bucket label.
 * @example getTimeBucket(23)
 */
export function getTimeBucket(hour) {
  const normalized = clamp(Math.trunc(hour), 0, 23);
  if (normalized >= 5 && normalized < 12) return 'Morning';
  if (normalized >= 12 && normalized < 17) return 'Afternoon';
  if (normalized >= 17 && normalized < 22) return 'Evening';
  return 'Night';
}

/**
 * Pearson autocorrelation of a score array at a given lag.
 * @param {number[]} scores - Ordered score sequence.
 * @param {number} lag - Lag in trips.
 * @returns {number} Correlation in [-1, 1], or 0 when insufficient/flat.
 * @example scoreAutocorrelation([80, 82, 81], 1)
 */
export function scoreAutocorrelation(scores = [], lag = 1) {
  const normalizedLag = Math.max(1, Math.trunc(Number(lag) || 1));
  const finiteScores = (scores || []).map(Number).filter(Number.isFinite);
  const n = finiteScores.length - normalizedLag;
  if (n < 2) return 0;
  const x = finiteScores.slice(0, n);
  const y = finiteScores.slice(normalizedLag);
  const identicalFlatSequence = x.every((value) => value === x[0]) &&
    y.every((value) => value === y[0]) &&
    x[0] === y[0];
  if (identicalFlatSequence) return 1;
  return pearsonCorrelation(x, y);
}

/**
 * Estimate the score-decay half-life from per-driver score persistence.
 * @param {object[]} sortedTrips - Chronologically sorted completed trips.
 * @param {number} threshold - Autocorrelation cutoff for temporal persistence.
 * @returns {number} Half-life in days, bounded by registry constants.
 * @example computeAdaptiveHalfLife(completedTrips)
 */
export function computeAdaptiveHalfLife(sortedTrips = [], threshold = SIGNAL_DECAY_AUTOCORR_THRESHOLD) {
  const scored = (sortedTrips || []).filter((trip) => getTripScore(trip) != null);
  if (scored.length < SIGNAL_DECAY_MIN_TRIPS_FOR_AUTOCORR) {
    return SIGNAL_DECAY_DEFAULT_HALF_LIFE_DAYS;
  }

  const scores = scored.map((trip) => getTripScore(trip));
  let totalGapDays = 0;
  let gapCount = 0;
  for (let i = 1; i < scored.length; i += 1) {
    const previous = getTripEndDate(scored[i - 1]) || getTripStartDate(scored[i - 1]);
    const current = getTripEndDate(scored[i]) || getTripStartDate(scored[i]);
    const gap = previous && current ? (current.getTime() - previous.getTime()) / 86_400_000 : NaN;
    if (Number.isFinite(gap) && gap > 0 && gap < 30) {
      totalGapDays += gap;
      gapCount += 1;
    }
  }
  const avgDaysPerTrip = gapCount > 0 ? totalGapDays / gapCount : 1;
  const maxLag = Math.min(30, Math.floor(scores.length / 2));
  const cutoff = Math.max(0, Number(threshold) || SIGNAL_DECAY_AUTOCORR_THRESHOLD);

  for (let lag = 1; lag <= maxLag; lag += 1) {
    if (Math.abs(scoreAutocorrelation(scores, lag)) < cutoff) {
      return clamp(
        Math.round(lag * avgDaysPerTrip),
        SIGNAL_DECAY_MIN_HALF_LIFE_DAYS,
        SIGNAL_DECAY_MAX_HALF_LIFE_DAYS
      );
    }
  }

  return SIGNAL_DECAY_MAX_HALF_LIFE_DAYS;
}

const defaultHourlyRiskForHour = (hour) => {
  const risk = DEFAULT_HOURLY_RISK_PROFILE?.[hour];
  return Number.isFinite(Number(risk)) ? clamp(Math.round(Number(risk)), 0, 100) : 20;
};

/**
 * Build a learned driving habit profile from completed trip history.
 * @param {Array<object>} trips - Completed trips with start timestamps and score fields.
 * @returns {object} Habit profile with confidence, bucket risks, trend risk, and fatigue onset.
 * @example buildHabitProfile(completedTrips)
 */
export function buildHabitProfile(trips = []) {
  const completed = (trips || [])
    .filter((trip) => !trip?.status || trip.status === 'completed')
    .map((trip) => ({ trip, start: getTripStartDate(trip), score: getTripScore(trip) }))
    .filter((entry) => entry.start && entry.score != null);

  const allScores = completed.map((entry) => entry.score);
  const allTimeAvgScore = allScores.length
    ? Math.round((allScores.reduce((sum, score) => sum + score, 0) / allScores.length) * 10) / 10
    : HABIT_CONSTANTS.DEFAULT_AVG_SCORE;
  const sortedChronologicalTrips = [...completed]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((entry) => entry.trip);
  const sortedRecent = [...completed].sort((a, b) => b.start.getTime() - a.start.getTime());
  const recentScores = sortedRecent.slice(0, HABIT_CONSTANTS.TREND_WINDOW).map((entry) => entry.score);
  const recentAvgScore = recentScores.length
    ? Math.round((recentScores.reduce((sum, score) => sum + score, 0) / recentScores.length) * 10) / 10
    : allTimeAvgScore;

  const bucketScores = Object.fromEntries(TIME_BUCKETS.map((bucket) => [bucket, []]));
  const dayScores = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, []]));
  const hourScores = Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [hour, []]));

  completed.forEach((entry) => {
    const hour = entry.start.getHours();
    bucketScores[getTimeBucket(hour)].push(entry.score);
    dayScores[entry.start.getDay()].push(entry.score);
    hourScores[hour].push(entry.score);
  });

  const timeBuckets = Object.fromEntries(TIME_BUCKETS.map((bucket) => {
    const stats = getStats(bucketScores[bucket]);
    return [
      bucket,
      {
        ...stats,
        insufficient: stats.tripCount < HABIT_CONSTANTS.MIN_TRIPS_FOR_BUCKET,
      },
    ];
  }));

  const dayOfWeek = Object.fromEntries(Array.from({ length: 7 }, (_, day) => {
    const stats = getStats(dayScores[day]);
    return [
      day,
      {
        avgScore: stats.avgScore,
        riskScore: stats.riskScore,
        stdDev: stats.stdDev,
        tripCount: stats.tripCount,
        insufficient: stats.tripCount < HABIT_CONSTANTS.MIN_TRIPS_FOR_DAY,
      },
    ];
  }));

  const hourlyRisk = Object.fromEntries(Object.entries(hourScores)
    .filter(([, scores]) => scores.length >= HABIT_CONSTANTS.MIN_TRIPS_FOR_HOUR)
    .map(([hour, scores]) => {
      const stats = getStats(scores);
      return [hour, { riskScore: stats.riskScore, tripCount: stats.tripCount }];
    }));

  const tripsByDay = new Map();
  completed.forEach((entry) => {
    const dayKey = getLocalDayKey(entry.start);
    const dayTrips = tripsByDay.get(dayKey) || [];
    dayTrips.push(entry);
    tripsByDay.set(dayKey, dayTrips);
  });

  const multiTripDays = [...tripsByDay.values()].filter((dayTrips) => dayTrips.length >= 2);
  const fatigueBandScores = FATIGUE_BANDS.map(() => []);
  if (multiTripDays.length >= HABIT_CONSTANTS.MIN_MULTI_TRIP_DAYS_FOR_FATIGUE) {
    multiTripDays.forEach((dayTrips) => {
      let cumulativeMinutes = 0;
      [...dayTrips]
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .forEach((entry) => {
          cumulativeMinutes += getTripDurationMinutes(entry.trip);
          const bandIndex = FATIGUE_BANDS.findIndex((band) => cumulativeMinutes >= band.min && cumulativeMinutes < band.max);
          fatigueBandScores[Math.max(0, bandIndex)].push(entry.score);
        });
    });
  }

  const fatigueBand = fatigueBandScores.find((scores) => {
    if (!scores.length) return false;
    const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return avgScore < allTimeAvgScore - HABIT_CONSTANTS.FATIGUE_DROP_POINTS;
  });
  const fatigueBandIndex = fatigueBand ? fatigueBandScores.indexOf(fatigueBand) : -1;
  const fatigueOnsetMinutes = fatigueBandIndex >= 0
    ? FATIGUE_BANDS[fatigueBandIndex].midpoint
    : HABIT_CONSTANTS.DEFAULT_FATIGUE_ONSET_MINUTES;

  return {
    confidence: clamp(completed.length / HABIT_CONSTANTS.FULL_CALIBRATION_TRIPS, 0, 1),
    timeBuckets,
    dayOfWeek,
    hourlyRisk,
    trendRisk: clamp(Math.round(100 - recentAvgScore), 0, 100),
    recentAvgScore,
    allTimeAvgScore,
    trendDelta: Math.round((recentAvgScore - allTimeAvgScore) * 10) / 10,
    fatigueOnsetMinutes,
    halfLifeDays: computeAdaptiveHalfLife(sortedChronologicalTrips),
  };
}

/**
 * Return a clock-risk fallback scaled by a calibrated driver's average score.
 * @param {number} hour - Local hour from 0 to 23.
 * @param {object|null} profile - Optional habit profile returned by buildHabitProfile.
 * @returns {number} Fallback time risk from 0 to 100.
 * @example getFallbackTimeRisk(23, habitProfile)
 */
export function getFallbackTimeRisk(hour, profile = null) {
  const normalizedHour = ((Math.trunc(Number(hour) || 0) % 24) + 24) % 24;
  const baseFallback = defaultHourlyRiskForHour(normalizedHour);
  if (!profile || Number(profile.confidence) < 0.5) return baseFallback;

  const avgScore = Number.isFinite(Number(profile.allTimeAvgScore))
    ? Number(profile.allTimeAvgScore)
    : HABIT_CONSTANTS.DEFAULT_AVG_SCORE;
  const personalScale = 1 - (avgScore - 50) / 100;
  return clamp(Math.round(baseFallback * personalScale), 0, 100);
}
