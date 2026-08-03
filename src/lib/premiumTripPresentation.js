// @ts-check
import { getTripComponentScore } from '@/lib/tripEngine';

export const PREMIUM_TRIP_TIME_PERIODS = Object.freeze({
  DAWN: 'dawn',
  DAY: 'day',
  DUSK: 'dusk',
  NIGHT: 'night',
});

const TIME_PRESENTATIONS = Object.freeze({
  dawn: { label: 'Morning Drive', shortLabel: 'Morning' },
  day: { label: 'Day Drive', shortLabel: 'Daytime' },
  dusk: { label: 'Evening Drive', shortLabel: 'Evening' },
  night: { label: 'Night Drive', shortLabel: 'Night' },
});

const TWILIGHT_PRESENTATION_WINDOW_MINUTES = 90;
const DEFAULT_NIGHT_START_MINUTES = 22 * 60;
const DEFAULT_NIGHT_END_MINUTES = 5 * 60;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isPlainTripRecord = (value) => (
  value != null &&
  typeof value === 'object' &&
  !(value instanceof Date) &&
  (
    Object.prototype.hasOwnProperty.call(value, 'start_time') ||
    Object.prototype.hasOwnProperty.call(value, 'night_driving') ||
    Object.prototype.hasOwnProperty.call(value, 'route_points')
  )
);

const hasValidCoordinates = (point) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
};

const representativeTripCoordinate = (trip = {}) => {
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  const point = points.find(hasValidCoordinates);
  return point ? { lat: Number(point.lat), lng: Number(point.lng) } : null;
};

const dayOfYear = (date) => {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((current - start) / 86400000);
};

const toRad = (degrees) => degrees * Math.PI / 180;

function sunEventMinutes(date, lat, lng, isSunrise, zenith = 90.833) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 89.8) return null;

  const n = dayOfYear(date);
  const lngHour = lng / 15;
  const t = n + (((isSunrise ? 6 : 18) - lngHour) / 24);
  const meanAnomaly = (0.9856 * t) - 3.289;
  let trueLongitude = meanAnomaly
    + (1.916 * Math.sin(toRad(meanAnomaly)))
    + (0.020 * Math.sin(toRad(2 * meanAnomaly)))
    + 282.634;
  trueLongitude = ((trueLongitude % 360) + 360) % 360;

  let rightAscension = Math.atan(0.91764 * Math.tan(toRad(trueLongitude))) * 180 / Math.PI;
  rightAscension = ((rightAscension % 360) + 360) % 360;
  const longitudeQuadrant = Math.floor(trueLongitude / 90) * 90;
  const ascensionQuadrant = Math.floor(rightAscension / 90) * 90;
  rightAscension = (rightAscension + longitudeQuadrant - ascensionQuadrant) / 15;

  const sinDec = 0.39782 * Math.sin(toRad(trueLongitude));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosHour = (Math.cos(toRad(zenith)) - (sinDec * Math.sin(toRad(lat)))) / (cosDec * Math.cos(toRad(lat)));
  if (cosHour > 1 || cosHour < -1) return null;

  const hourAngle = isSunrise
    ? 360 - (Math.acos(cosHour) * 180 / Math.PI)
    : Math.acos(cosHour) * 180 / Math.PI;
  const localMeanTime = (hourAngle / 15) + rightAscension - (0.06571 * t) - 6.622;
  const utcMinutes = ((localMeanTime - lngHour) * 60) % (24 * 60);
  return ((utcMinutes - date.getTimezoneOffset()) % (24 * 60) + (24 * 60)) % (24 * 60);
}

function isWithinClockWindow(minutes, startMinutes, endMinutes) {
  const dayMinutes = 24 * 60;
  const normalized = ((minutes % dayMinutes) + dayMinutes) % dayMinutes;
  const start = ((startMinutes % dayMinutes) + dayMinutes) % dayMinutes;
  const end = ((endMinutes % dayMinutes) + dayMinutes) % dayMinutes;
  if (start === end) return false;
  return start < end
    ? normalized >= start && normalized < end
    : normalized >= start || normalized < end;
}

function getClockTimePeriod(hour) {
  return hour >= 5 && hour < 9
    ? PREMIUM_TRIP_TIME_PERIODS.DAWN
    : hour >= 9 && hour < 17
      ? PREMIUM_TRIP_TIME_PERIODS.DAY
      : hour >= 17 && hour < 21
        ? PREMIUM_TRIP_TIME_PERIODS.DUSK
        : PREMIUM_TRIP_TIME_PERIODS.NIGHT;
}

function parseClockMinutes(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? hour * 60 + minute
    : fallback;
}

function finiteOffset(value) {
  const offset = Number(value);
  return Number.isFinite(offset) ? offset : 0;
}

function getConfiguredTimePeriod(date, coordinate, settings = {}) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const fallbackStart = parseClockMinutes(settings.night_start_time, DEFAULT_NIGHT_START_MINUTES);
  const fallbackEnd = parseClockMinutes(settings.night_end_time, DEFAULT_NIGHT_END_MINUTES);
  const customMode = settings.night_detection_mode === 'custom';
  const civilTwilightMode = settings.night_detection_mode === 'civil_twilight';
  const zenith = civilTwilightMode ? 96 : 90.833;
  const tolerance = Math.max(0, Math.min(30, Number(settings.night_boundary_tolerance_minutes) || 0));
  const sunrise = coordinate ? sunEventMinutes(date, coordinate.lat, coordinate.lng, true, zenith) : null;
  const sunset = coordinate ? sunEventMinutes(date, coordinate.lat, coordinate.lng, false, zenith) : null;
  const solarAvailable = sunrise != null && sunset != null;
  const sunriseBoundary = solarAvailable
    ? sunrise + finiteOffset(settings.night_sunrise_offset_minutes) - tolerance
    : null;
  const sunsetBoundary = solarAvailable
    ? sunset + finiteOffset(settings.night_sunset_offset_minutes) + tolerance
    : null;
  const night = customMode || !solarAvailable
    ? isWithinClockWindow(minutes, fallbackStart, fallbackEnd)
    : isWithinClockWindow(minutes, sunsetBoundary, sunriseBoundary);

  if (night) return PREMIUM_TRIP_TIME_PERIODS.NIGHT;
  if (!solarAvailable) {
    const clockPeriod = getClockTimePeriod(date.getHours());
    return clockPeriod === PREMIUM_TRIP_TIME_PERIODS.NIGHT
      ? date.getHours() < 12
        ? PREMIUM_TRIP_TIME_PERIODS.DAWN
        : PREMIUM_TRIP_TIME_PERIODS.DUSK
      : clockPeriod;
  }
  if (isWithinClockWindow(minutes, sunriseBoundary, sunriseBoundary + TWILIGHT_PRESENTATION_WINDOW_MINUTES)) {
    return PREMIUM_TRIP_TIME_PERIODS.DAWN;
  }
  if (isWithinClockWindow(minutes, sunsetBoundary - TWILIGHT_PRESENTATION_WINDOW_MINUTES, sunsetBoundary)) {
    return PREMIUM_TRIP_TIME_PERIODS.DUSK;
  }
  if (isWithinClockWindow(minutes, sunset, sunrise)) {
    return date.getHours() < 12
      ? PREMIUM_TRIP_TIME_PERIODS.DAWN
      : PREMIUM_TRIP_TIME_PERIODS.DUSK;
  }
  return PREMIUM_TRIP_TIME_PERIODS.DAY;
}

/**
 * Uses saved trip evidence first, then GPS solar context, then the local clock
 * fallback used by the formatted trip time.
 * @param {string|number|Date|Record<string, any>|null|undefined} tripOrStartTime
 * @param {Record<string, any>} [nightSettings]
 */
export function getPremiumTripTimePresentation(tripOrStartTime, nightSettings = {}) {
  const trip = isPlainTripRecord(tripOrStartTime)
    ? /** @type {Record<string, any>} */ (tripOrStartTime)
    : null;
  const startTime = trip ? trip.start_time : tripOrStartTime;
  const date = startTime instanceof Date ? startTime : new Date(startTime || 0);
  const hour = Number.isFinite(date.getTime()) ? date.getHours() : 12;
  let period = getClockTimePeriod(hour);

  if (trip && Number.isFinite(date.getTime())) {
    if (trip.night_driving === true) {
      period = PREMIUM_TRIP_TIME_PERIODS.NIGHT;
    } else {
      period = getConfiguredTimePeriod(date, representativeTripCoordinate(trip), nightSettings);
      if (trip.night_driving === false && period === PREMIUM_TRIP_TIME_PERIODS.NIGHT) {
        period = hour < 12 ? PREMIUM_TRIP_TIME_PERIODS.DAWN : PREMIUM_TRIP_TIME_PERIODS.DUSK;
      }
    }
  }

  return { ...TIME_PRESENTATIONS[period], hour, period };
}

function formatStoredClockTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

function formatStoredUtcOffset(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return null;
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(Math.round(minutes));
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

export function getNightClassificationExplanation(trip = {}) {
  const classification = trip?.night_classification;
  if (!classification || typeof classification !== 'object') {
    return trip?.night_driving
      ? {
        headline: 'Night driving recorded',
        detail: 'This older trip does not include the saved night-decision details.',
        timezone: null,
      }
      : null;
  }

  const isNight = classification.is_night === true || trip.night_driving === true;
  const startTime = formatStoredClockTime(classification.trip_start_local_time);
  const decisionTime = formatStoredClockTime(classification.decision_local_time);
  const eveningTime = formatStoredClockTime(classification.evening_event_local_time);
  const morningTime = formatStoredClockTime(classification.morning_event_local_time);
  const customStart = formatStoredClockTime(classification.custom_start_time);
  const customEnd = formatStoredClockTime(classification.custom_end_time);
  const tolerance = Math.max(0, Number(classification.boundary_tolerance_minutes) || 0);
  const timezoneId = classification.timezone_id || trip.trip_timezone_id || null;
  const utcOffset = formatStoredUtcOffset(
    classification.utc_offset_minutes ?? trip.trip_utc_offset_minutes
  );
  const timezone = [timezoneId, utcOffset ? `${utcOffset} at trip time` : null].filter(Boolean).join(' · ') || null;

  if (classification.method === 'custom_fallback') {
    const unavailableReason = String(classification.fallback_reason || '').includes('solar_event_unavailable')
      ? 'solar events could not be calculated for that location and date'
      : 'usable GPS coordinates were unavailable';
    return {
      headline: isNight ? 'Night determined with the custom fallback' : 'Day determined with the custom fallback',
      detail: `Road Sage used ${customStart || 'the configured start'}–${customEnd || 'the configured end'} because ${unavailableReason}.`,
      timezone,
    };
  }

  if (classification.mode === 'custom') {
    return {
      headline: isNight ? 'Night: inside the custom window' : 'Day: outside the custom window',
      detail: `Configured window: ${customStart || 'start'}–${customEnd || 'end'}${startTime ? `; trip started at ${startTime}` : ''}.`,
      timezone,
    };
  }

  const civilTwilight = classification.mode === 'civil_twilight';
  const eveningLabel = civilTwilight ? 'civil twilight ended' : 'sunset';
  const morningLabel = civilTwilight ? 'civil twilight began' : 'sunrise';
  const sampleLabel = classification.trip_started_in_night ? 'trip started' : 'first night sample';
  const boundaryDetail = [
    eveningTime ? `${eveningLabel} was ${eveningTime}` : null,
    morningTime ? `${morningLabel} was ${morningTime}` : null,
    isNight && decisionTime ? `${sampleLabel} at ${decisionTime}` : startTime ? `trip started at ${startTime}` : null,
  ].filter(Boolean).join('; ');
  const solarDetail = boundaryDetail || 'Solar boundaries were calculated from the recorded GPS and date.';
  const punctuatedSolarDetail = solarDetail.endsWith('.') ? solarDetail : `${solarDetail}.`;
  return {
    headline: isNight
      ? `Night: ${civilTwilight ? 'civil-twilight' : 'sunset'} boundary reached`
      : `Day: outside the ${civilTwilight ? 'civil-twilight' : 'sunset'} night window`,
    detail: `${punctuatedSolarDetail}${tolerance ? ` A ${tolerance}-minute boundary buffer was applied.` : ''}`,
    timezone,
  };
}

const SCORE_TONES = Object.freeze([
  { minimum: 85, tone: 'excellent', label: 'Excellent', hue: '151 79% 53%' },
  { minimum: 70, tone: 'good', label: 'Good', hue: '198 91% 55%' },
  { minimum: 55, tone: 'fair', label: 'Fair', hue: '39 96% 56%' },
  { minimum: 40, tone: 'poor', label: 'Poor', hue: '25 95% 55%' },
  { minimum: 0, tone: 'risky', label: 'Risky', hue: '0 88% 61%' },
]);

/** @param {unknown} score */
export function getPremiumTripScorePresentation(score) {
  const numeric = score == null || score === '' ? null : Number(score);
  if (!Number.isFinite(numeric)) {
    return {
      degrees: 0,
      label: 'Unavailable',
      normalizedScore: null,
      tone: 'unavailable',
      hue: '215 18% 58%',
    };
  }

  const normalizedScore = Math.max(0, Math.min(100, numeric));
  const selected = SCORE_TONES.find(({ minimum }) => normalizedScore >= minimum) || SCORE_TONES[SCORE_TONES.length - 1];
  return {
    ...selected,
    degrees: Math.round(normalizedScore * 36) / 10,
    normalizedScore,
  };
}

/**
 * Dusk receives the two risk-sensitive city treatments shown in the visual
 * reference. Other periods keep their distinct time-of-day scenes.
 * @param {string} period
 * @param {string} scoreTone
 * @param {{eventCount?: number, distanceKm?: number, aggressive?: boolean, proximityCount?: number}} [context]
 */
export function getPremiumTripSceneVariant(period, scoreTone, context = {}) {
  if (period !== PREMIUM_TRIP_TIME_PERIODS.DUSK) return period;
  const eventCount = Math.max(0, Number(context.eventCount) || 0);
  const distanceKm = Math.max(0, Number(context.distanceKm) || 0);
  const eventDensity = distanceKm > 0 ? eventCount / distanceKm : eventCount;
  const needsAttention = context.aggressive === true ||
    (Number(context.proximityCount) || 0) > 0 ||
    eventCount >= 4 ||
    (eventCount >= 3 && eventDensity >= 1.5);

  if (scoreTone === 'fair' && needsAttention) return 'dusk-risk';
  if (scoreTone === 'fair') return 'dusk-caution';
  if (scoreTone === 'poor' || scoreTone === 'risky') return 'dusk-risk';
  return PREMIUM_TRIP_TIME_PERIODS.DUSK;
}

/** @param {Record<string, any>} trip */
export function getConfirmedPhoneUseCount(trip = {}) {
  const confirmedEvents = [
    ...(Array.isArray(trip.phone_use_events) ? trip.phone_use_events : []),
    ...(Array.isArray(trip.driving_events)
      ? trip.driving_events.filter((event) => event?.type === 'phone_use')
      : []),
  ].filter((event) => (
    event?.source === 'android_usage_access' ||
    (event?.type === 'phone_use' && event?.diagnostic_only !== true && event?.source !== 'gps_proxy')
  ));

  if (trip.phone_use_score_available !== true && trip.phone_use_score_status !== 'android_usage_access') return 0;
  return Math.max(Number(trip.phone_use_window_count) || 0, confirmedEvents.length);
}

/** @param {Record<string, any>} trip */
export function getPremiumTripEventCount(trip = {}) {
  return (Number(trip.harsh_brakes_count) || 0)
    + (Number(trip.rapid_accel_count) || 0)
    + (Number(trip.sharp_turns_count) || 0)
    + (Number(trip.speeding_events_count) || 0)
    + getConfirmedPhoneUseCount(trip);
}

/**
 * Selects situational Trip Detail artwork from live trip evidence. Neutral
 * fact cards stay stable; identity, score, and behavior surfaces can react to
 * time of day and meaningful risk/evidence changes.
 * @param {Record<string, any>} trip
 * @param {Record<string, any>} [nightSettings]
 */
export function getPremiumTripDetailPresentation(trip = {}, nightSettings = {}) {
  const time = getPremiumTripTimePresentation(trip, nightSettings);
  const score = getPremiumTripScorePresentation(getTripComponentScore(trip, 'overall').value);
  const eventCount = getPremiumTripEventCount(trip);
  const proximityCount = Math.max(0, Number(trip.close_proximity_count) || 0);
  const scene = getPremiumTripSceneVariant(time.period, score.tone, {
    aggressive: ['assertive', 'aggressive'].includes(String(trip.aggressive_grade || '').toLowerCase()),
    distanceKm: trip.distance_km,
    eventCount,
    proximityCount,
  });
  const behaviorTone = proximityCount > 0 ||
    ['poor', 'risky'].includes(score.tone) ||
    scene === 'dusk-risk'
    ? 'risk'
    : eventCount > 0 || score.tone === 'fair'
      ? 'attention'
      : 'calm';

  return {
    behaviorTone,
    eventCount,
    scene,
    scoreTone: score.tone,
    timePeriod: time.period,
  };
}

/**
 * Compares a trip with up to five immediately preceding scored trips.
 * @param {Record<string, any>} trip
 * @param {Array<Record<string, any>>} trips
 */
export function getPremiumTripScoreDelta(trip, trips = []) {
  const recent = [...(Array.isArray(trips) ? trips : [])].sort(
    (a, b) => new Date(b?.start_time || 0).getTime() - new Date(a?.start_time || 0).getTime()
  );
  const index = recent.findIndex((item) => String(item?.id) === String(trip?.id));
  const currentScore = getTripComponentScore(trip, 'overall').value;
  if (index < 0 || !Number.isFinite(currentScore)) return null;

  const previousFive = recent
    .slice(index + 1, index + 6)
    .map((item) => getTripComponentScore(item, 'overall').value)
    .filter(Number.isFinite);

  if (previousFive.length < 3) {
    return {
      delta: null,
      direction: 'flat',
      insufficientBaseline: true,
      sampleCount: previousFive.length,
    };
  }

  const average = previousFive.reduce((sum, score) => sum + score, 0) / previousFive.length;
  const delta = currentScore - average;
  return {
    delta,
    direction: delta >= 3 ? 'up' : delta <= -3 ? 'down' : 'flat',
    insufficientBaseline: false,
    sampleCount: previousFive.length,
  };
}
