import { clamp } from '@/lib/mathUtils';
import {
  isEveningRushHour,
  isMorningRushHour,
  isNightRiskHour,
  NIGHT_END_HOUR,
  NIGHT_START_HOUR,
} from '@/lib/appConstants';
import { routeKeyForTrip as commuteRouteKeyForTrip } from '@/lib/commuteMatching';

export const DEFAULT_FUEL_PRICE_PER_LITER = 1.65;
export const DEFAULT_L_PER_100KM = 8.5;
export const DEFAULT_EV_KWH_PER_100KM = 18;
export const DEFAULT_GRID_CO2_KG_PER_KWH = 0.04;
export const DEFAULT_CO2_BASELINE_KG_PER_100KM = 12.0;
// USDA/Arbor Day cite >48 lb CO2/year for a mature tree; 21 kg/year keeps this as a conservative planning value.
export const DEFAULT_TREE_CO2_KG_PER_YEAR = 21.0;
export const ECO_DRIVING_MAX_ECONOMY_ADJUSTMENT = 0.08;
export const GASOLINE_CO2_KG_PER_LITER = 2.31;
export const CO2_KG_PER_LITER = {
  gasoline: 2.31,
  petrol: 2.31,
  diesel: 2.68,
  lpg: 1.65,
  cng: 2.0,
  hybrid: 2.10,
  electric: 0,
  ev: 0,
};
/**
 * Provisional maintenance conversion used for extra-wear estimates.
 *
 * Calibration intent: one driving stress unit is currently treated as about
 * 8 km of service-life reserve consumed. This has not been calibrated against
 * OEM tire/service interval data, so maintenance reminders should treat it as
 * a planning heuristic rather than a manufacturer-backed life estimate.
 */
export const WEAR_KM_PER_STRESS_UNIT = 8;
export const MAINTENANCE_CALIBRATION_REGISTRY = {
  wearKmPerStressUnit: {
    value: WEAR_KM_PER_STRESS_UNIT,
    unit: 'km_per_stress_unit',
    calibrationStatus: 'provisional',
    calibrationBasis: 'Not calibrated to OEM tire or maintenance interval data.',
    note: '1 stress unit is assumed to consume about 8 km of service-life reserve until manufacturer or fleet outcome data is available.',
  },
};
export const PERSONAL_BASELINE_MIN_TRIPS = 10;
export const PERSONAL_PERCENTILE_MIN_WEEKS = 4;
export const BEST_WINDOW_MIN_TRIPS = 3;
export const PERSONAL_BASELINE_DECAY = 0.85;
export const PERSONAL_BASELINE_INTERVAL_METHOD = 'normal_approximation_95';
export const PERSONAL_BASELINE_INTERVAL_NOTE = 'Approximate 95% CI assuming roughly normal score distribution; may be too narrow for bounded or skewed scores.';
export const PEAK_STRESS_MIN_TRIP_KM = 0.5;
export const RISK_EVENT_RATE_MIN_DISTANCE_KM = 50;
export const SCORE_TIP_MIN_TRIP_KM = 2;
export const SCORE_TIP_MIN_CONFIDENCE = 0.5;
export const FATIGUE_HEATMAP_SEGMENT_SECONDS = 30;
export const FATIGUE_HEATMAP_MIN_SEGMENTS = 20;

export const STRESS_UNITS = {
  harsh_brake: { low: 1.5, medium: 4, high: 8 },
  rapid_acceleration: { low: 1, medium: 3, high: 6 },
  sharp_turn: { low: 0.5, medium: 2, high: 4 },
  tailgate_cycle: { low: 1, medium: 3, high: 5 },
};

export const DEFAULT_MAINTENANCE_ITEMS = [
  { id: 'oil', label: 'Oil change', interval_km: 8000, last_service_km: 0 },
  { id: 'tires', label: 'Tire rotation', interval_km: 10000, last_service_km: 0 },
  { id: 'brakes', label: 'Brake check', interval_km: 20000, last_service_km: 0 },
  { id: 'inspection', label: 'Inspection', interval_km: 20000, last_service_km: 0 },
];

const DAY_MS = 86400000;

const distanceWeightedScore = (trips = [], field = 'score_overall') => {
  const scored = trips
    .map((trip) => ({
      score: Number(trip?.[field]),
      distance: Number(trip?.distance_km) || 0,
    }))
    .filter((item) => Number.isFinite(item.score));
  const totalKm = scored.reduce((sum, item) => sum + item.distance, 0);
  return totalKm > 0
    ? scored.reduce((sum, item) => sum + item.score * item.distance, 0) / totalKm
    : null;
};

export const DRIVING_CONSISTENCY_IQR_MULTIPLIERS = {
  // A 10-point IQR deducts 10 points on urban trips and 18 on highway trips,
  // where sustained speeds make the same spread a stronger inconsistency signal.
  urban: 1.0,
  residential: 1.2,
  mixed: 1.4,
  highway: 1.8,
};

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const startOfWeek = (date = new Date()) => {
  const d = startOfDay(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d;
};

export function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedArr[lower];
  return sortedArr[lower] + (sortedArr[upper] - sortedArr[lower]) * (idx - lower);
}

export function getSpeedColor(speedKmh = 0) {
  if (speedKmh >= 120) return '#ef4444';
  if (speedKmh >= 90) return '#f97316';
  if (speedKmh >= 55) return '#22c55e';
  if (speedKmh >= 15) return '#3b82f6';
  return '#94a3b8';
}

export function getSpeedLabel(speedKmh = 0) {
  if (speedKmh >= 120) return 'Risk';
  if (speedKmh >= 90) return 'Fast';
  if (speedKmh >= 55) return 'Cruise';
  if (speedKmh >= 15) return 'City';
  return 'Slow';
}

export function buildSpeedSegments(points = []) {
  const clean = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  const segments = [];

  for (let i = 1; i < clean.length; i++) {
    const prev = clean[i - 1];
    const curr = clean[i];
    const speed = Number.isFinite(curr.speed_kmh) ? curr.speed_kmh : prev.speed_kmh || 0;
    segments.push({
      from: prev,
      to: curr,
      speed_kmh: speed,
      color: getSpeedColor(speed),
      label: getSpeedLabel(speed),
    });
  }

  return segments;
}

export function detectTripStops(points = [], { minStopSeconds = 90, maxSpeedKmh = 5 } = {}) {
  const stops = [];
  let stopStart = null;
  let lastStoppedPoint = null;

  for (const point of points) {
    const time = new Date(point.timestamp).getTime();
    if (!Number.isFinite(time)) continue;
    const speed = Number(point.speed_kmh) || 0;
    const stopped = speed <= maxSpeedKmh;

    if (stopped) {
      stopStart ??= point;
      lastStoppedPoint = point;
      continue;
    }

    if (stopStart && lastStoppedPoint) {
      const durationSeconds = Math.round((new Date(lastStoppedPoint.timestamp).getTime() - new Date(stopStart.timestamp).getTime()) / 1000);
      if (durationSeconds >= minStopSeconds) {
        stops.push({
          lat: stopStart.lat,
          lng: stopStart.lng,
          start_time: stopStart.timestamp,
          end_time: lastStoppedPoint.timestamp,
          duration_seconds: durationSeconds,
        });
      }
    }
    stopStart = null;
    lastStoppedPoint = null;
  }

  if (stopStart && lastStoppedPoint) {
    const durationSeconds = Math.round((new Date(lastStoppedPoint.timestamp).getTime() - new Date(stopStart.timestamp).getTime()) / 1000);
    if (durationSeconds >= minStopSeconds) {
      stops.push({
        lat: stopStart.lat,
        lng: stopStart.lng,
        start_time: stopStart.timestamp,
        end_time: lastStoppedPoint.timestamp,
        duration_seconds: durationSeconds,
      });
    }
  }

  return stops;
}

export function getVehicleTripDistanceKm(vehicle, trips = []) {
  if (!vehicle?.id) return 0;
  return trips
    .filter((trip) => (
      trip.status === 'completed' &&
      (String(trip.vehicle_id) === String(vehicle.id) || (vehicle.is_default && !trip.vehicle_id))
    ))
    .reduce((sum, trip) => sum + (trip.distance_km || 0), 0);
}

export function getVehicleOdometerKm(vehicle, trips = []) {
  const baseOdometer = Number(vehicle?.odometer_km) || 0;
  const tripDistance = getVehicleTripDistanceKm(vehicle, trips);
  const anchoredDistance = Number(vehicle?.odometer_trip_distance_anchor_km) || 0;
  return Math.round(baseOdometer + Math.max(0, tripDistance - anchoredDistance));
}

export function getMaintenanceItems(vehicle) {
  const current = Array.isArray(vehicle?.maintenance_items) ? vehicle.maintenance_items : [];
  const byId = new Map(current.map((item) => [item.id, item]));
  return DEFAULT_MAINTENANCE_ITEMS.map((item) => ({
    ...item,
    ...(byId.get(item.id) || {}),
    interval_km: Number(byId.get(item.id)?.interval_km || item.interval_km),
    last_service_km: Number(byId.get(item.id)?.last_service_km || item.last_service_km || 0),
  }));
}

export function getMaintenanceStatus(vehicle, trips = []) {
  const odometer = getVehicleOdometerKm(vehicle, trips);
  return getMaintenanceItems(vehicle).map((item) => {
    const nextDueKm = item.last_service_km + item.interval_km;
    const remainingKm = nextDueKm - odometer;
    return {
      ...item,
      next_due_km: nextDueKm,
      remaining_km: remainingKm,
      status: remainingKm <= 0 ? 'due' : remainingKm <= 1000 ? 'soon' : 'ok',
    };
  });
}

/**
 * Convert fatigue progression segments into timeline heatmap points.
 * @param {{fatigue_progression?:Array|{segments?:Array},fatigue_heatmap?:{segments?:Array},segment_scores?:Array<number>,route_points?:Array,start_time?:string}} trip - Completed trip with route points.
 * @returns {Array<{minuteOffset:number,fatigueLevel:number,color:string,lat:number,lng:number}>} Timeline heatmap points.
 * @example
 * const heatmap = buildFatigueHeatmapData(trip);
 */
export function buildFatigueHeatmapData(trip) {
  let segments = Array.isArray(trip?.fatigue_progression)
    ? trip.fatigue_progression
    : Array.isArray(trip?.fatigue_progression?.segments)
      ? trip.fatigue_progression.segments
      : Array.isArray(trip?.fatigue_heatmap?.segments)
        ? trip.fatigue_heatmap.segments
      : [];
  const points = Array.isArray(trip?.route_points) ? trip.route_points : [];
  if (!segments.length && Array.isArray(trip?.segment_scores) && trip.segment_scores.length) {
    const segmentSize = Math.max(1, Math.floor(points.length / trip.segment_scores.length));
    segments = trip.segment_scores.map((score, index) => ({
      start_index: index * segmentSize,
      end_index: index === trip.segment_scores.length - 1 ? points.length - 1 : Math.min(points.length - 1, (index + 1) * segmentSize - 1),
      score,
    }));
  }
  if (segments.length < FATIGUE_HEATMAP_MIN_SEGMENTS || !points.length) return [];

  const tripStart = new Date(points[0]?.timestamp || trip.start_time || Date.now()).getTime();
  const raw = segments
    .map((segment) => {
      const midpointIndex = clamp(
        Math.round(((Number(segment.start_index) || 0) + (Number(segment.end_index) || 0)) / 2),
        0,
        points.length - 1
      );
      const point = points[midpointIndex];
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
      const fatigueLevel = clamp(100 - (Number(segment.score) || 0), 0, 100);
      return {
        minuteOffset: Math.round(((new Date(point.timestamp).getTime() - tripStart) / 60000) * 10) / 10,
        fatigueLevel,
        color: fatigueLevel >= 60 ? '#ef4444' : fatigueLevel >= 35 ? '#f97316' : '#22c55e',
        lat: point.lat,
        lng: point.lng,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.minuteOffset - b.minuteOffset);

  return raw.map((entry, index) => {
    const window = raw.slice(Math.max(0, index - 1), Math.min(raw.length, index + 2));
    const smoothed = Math.round(window.reduce((sum, item) => sum + item.fatigueLevel, 0) / window.length);
    return {
      ...entry,
      fatigueLevel: smoothed,
      color: smoothed >= 60 ? '#ef4444' : smoothed >= 35 ? '#f97316' : '#22c55e',
    };
  });
}

function iqr(values = []) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return percentile(sorted, 75) - percentile(sorted, 25);
}

const finiteScore = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

/**
 * Build a persistent driving style signature from recent trips.
 * @param {Array<Object>} trips - Completed trips, newest or oldest order accepted.
 * @returns {{archetype:string,dimensions:Object,braking_confidence:number,style_shifts:Array,trip_count_used:number}|null} Driver signature.
 * @example
 * const signature = buildDriverSignature(lastTwentyTrips);
 */
export function buildDriverSignature(trips) {
  const completed = (trips || [])
    .filter((trip) => trip.status === 'completed')
    .sort((a, b) => new Date(b.start_time || b.created_at || 0).getTime() - new Date(a.start_time || a.created_at || 0).getTime())
    .slice(0, 20);
  if (completed.length < 5) return null;

  const overallScores = completed.map((trip) => finiteScore(trip.score_overall)).filter(Number.isFinite);
  const scoreIqr = iqr(overallScores);
  const consistencyIdx = overallScores.length >= 2 ? clamp(1 - scoreIqr / 100, 0, 1) : null;
  const brakingScores = completed
    .map((trip) => trip.braking_efficiency_score)
    .filter((score) => score != null && Number.isFinite(Number(score)))
    .map((score) => Number(score));
  const brakingStyle = brakingScores.length >= 3
    ? clamp(brakingScores.reduce((sum, score) => sum + score, 0) / brakingScores.length / 100, 0, 1)
    : null;
  const brakingConfidence = clamp(brakingScores.length / 10, 0, 1);
  const featureRows = completed.map((trip) => {
    const aggressiveScore = finiteScore(trip.aggressive_driving_score);
    const smoothnessScore = finiteScore(trip.score_smoothness ?? trip.smoothness_score);
    const ecoScore = finiteScore(trip.score_eco ?? trip.eco_score);
    return {
      aggression: aggressiveScore == null ? null : clamp(1 - (aggressiveScore / 100), 0, 1),
      smoothness: smoothnessScore == null ? null : clamp(smoothnessScore / 100, 0, 1),
      ecoMindedness: ecoScore == null ? null : clamp(ecoScore / 100, 0, 1),
      speedTolerance: clamp(
        ((Number(trip.speeding_events_count) || 0) / Math.max(1, Number(trip.distance_km) || 1)) / 0.4,
        0,
        1
      ),
      brakingStyle: trip.braking_efficiency_score != null && Number.isFinite(Number(trip.braking_efficiency_score))
        ? clamp(Number(trip.braking_efficiency_score) / 100, 0, 1)
        : null,
      consistencyIdx,
    };
  });

  const numericKeys = ['aggression', 'smoothness', 'ecoMindedness', 'speedTolerance', 'consistencyIdx'];
  const keys = [...numericKeys, 'brakingStyle'];
  const avgDim = (rows, key) => {
    const validValues = rows.map((row) => row[key]).filter(Number.isFinite);
    if (!validValues.length || (key === 'brakingStyle' && validValues.length < 3)) return null;
    return validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
  };
  const dimensions = Object.fromEntries(numericKeys.map((key) => {
    const avg = avgDim(featureRows, key);
    return [key, avg == null ? null : Math.round(avg * 100) / 100];
  }));
  dimensions.brakingStyle = brakingStyle == null ? null : Math.round(brakingStyle * 100) / 100;

  const aggression = dimensions.aggression ?? 0;
  const smoothness = dimensions.smoothness ?? 0;
  const ecoMindedness = dimensions.ecoMindedness ?? 0;
  const speedTolerance = dimensions.speedTolerance ?? 0;
  const consistency = dimensions.consistencyIdx ?? 0;
  const archetype = aggression > 0.55 && speedTolerance > 0.6
    ? 'aggressive_commuter'
    : ecoMindedness > 0.75 && smoothness > 0.7
      ? 'eco_conscious'
      : consistency > 0.85
        ? 'precision_driver'
        : smoothness > 0.75 && aggression < 0.3
          ? 'smooth_cruiser'
          : 'balanced';

  const recent = featureRows.slice(0, 5);
  const prior = featureRows.slice(5, 20);
  const styleShifts = prior.length ? keys
    .map((key) => {
      const recentAvg = avgDim(recent, key);
      const priorAvg = avgDim(prior, key);
      if (recentAvg == null || priorAvg == null) return null;
      const delta = recentAvg - priorAvg;
      return Math.abs(delta) > 0.20
        ? { dimension: key, direction: delta > 0 ? 'increasing' : 'decreasing', delta: Math.round(Math.abs(delta) * 100) / 100 }
        : null;
    })
    .filter(Boolean)
    : [];

  return {
    archetype,
    dimensions,
    braking_confidence: Math.round(brakingConfidence * 100) / 100,
    style_shifts: styleShifts,
    trip_count_used: completed.length,
  };
}

/**
 * Adjust maintenance intervals based on measured driving stress.
 * @param {Array<Object>} trips - Trips for the vehicle.
 * @param {{oil_change_km?:number,oil_change_interval_km?:number,tire_rotation_km?:number,tire_rotation_interval_km?:number,inspection_km?:number,odometer_km?:number,maintenance_items?:Array}} vehicle - Vehicle service settings.
 * @param {Object} settings - User settings for fallback intervals.
 * @returns {{stress_index:number,aggression_index:number,brake_stress_index:number|null,corner_stress_index:number,has_missing_speed_data:boolean,missing_speed_event_count:number,oil_change:Object,tire_rotation:Object,inspection:Object}} Predictive maintenance.
 * @example
 * const maintenance = calculatePredictiveMaintenance(trips, vehicle, settings);
 */
export function calculatePredictiveMaintenance(trips, vehicle = {}, settings = {}) {
  const completed = (trips || []).filter((trip) => trip.status === 'completed');
  const mean = (values, fallback = 0) => {
    const finite = values.filter((value) => Number.isFinite(value));
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : fallback;
  };
  const aggressionIndex = clamp(1 - mean(completed.map((trip) => Number(trip.aggressive_driving_score)), 100) / 100, 0, 1);
  const brakingScores = completed
    .map((trip) => trip.braking_efficiency_score)
    .filter((score) => score != null && Number.isFinite(Number(score)))
    .map((score) => Number(score));
  const brakeStressIndex = completed.length >= 5 && brakingScores.length >= 3
    ? clamp(1 - mean(brakingScores) / 100, 0, 1)
    : null;
  const cornerStressIndex = clamp(mean(completed.map((trip) => Number(trip.trip_tire_wear_units)), 0) / 10, 0, 1);
  const missingSpeedEventCount = completed.reduce((sum, trip) => sum + getTripTireWearMissingSpeedEventCount(trip), 0);
  const hasMissingSpeedData = missingSpeedEventCount > 0 || completed.some((trip) => trip.trip_tire_wear_has_missing_speed_data === true);
  const brakeStressForComposite = brakeStressIndex ?? 0;
  const stressIndex = clamp(aggressionIndex * 0.40 + brakeStressForComposite * 0.35 + cornerStressIndex * 0.25, 0, 1);
  const adjustmentFactor = 1 - stressIndex * 0.40;
  const items = getMaintenanceItems(vehicle);
  const byId = new Map(items.map((item) => [item.id, item]));
  const odometer = getVehicleOdometerKm(vehicle, completed);
  const itemFor = (ids, fallbackInterval) => ids.map((id) => byId.get(id)).find(Boolean) || { interval_km: fallbackInterval, last_service_km: 0 };
  const build = (item, baseInterval) => {
    const adjustedInterval = Math.round(baseInterval * adjustmentFactor);
    const usedKm = odometer - (Number(item.last_service_km) || 0);
    const remainingKm = Math.round(adjustedInterval - usedKm);
    return {
      adjusted_interval_km: adjustedInterval,
      remaining_km: remainingKm,
      status: remainingKm <= 0 ? 'due' : remainingKm <= 500 ? 'soon' : 'ok',
      urgency_delta: adjustedInterval - baseInterval,
    };
  };

  const oilBase = Number(vehicle.oil_change_km || vehicle.oil_change_interval_km || settings.oil_change_km) || itemFor(['oil'], 8000).interval_km;
  const tireBase = Number(vehicle.tire_rotation_km || vehicle.tire_rotation_interval_km || settings.tire_rotation_km) || itemFor(['tires'], 10000).interval_km;
  const inspectionBase = Number(vehicle.inspection_km || settings.inspection_km) || itemFor(['inspection'], 20000).interval_km;

  return {
    stress_index: Math.round(stressIndex * 100) / 100,
    aggression_index: Math.round(aggressionIndex * 100) / 100,
    brake_stress_index: brakeStressIndex == null ? null : Math.round(brakeStressIndex * 100) / 100,
    corner_stress_index: Math.round(cornerStressIndex * 100) / 100,
    has_missing_speed_data: hasMissingSpeedData,
    missing_speed_event_count: missingSpeedEventCount,
    oil_change: build(itemFor(['oil'], oilBase), oilBase),
    tire_rotation: build(itemFor(['tires'], tireBase), tireBase),
    inspection: build(itemFor(['inspection'], inspectionBase), inspectionBase),
  };
}

export function calculateAverageEngineStressScore(trips = []) {
  const scores = (trips || [])
    .map((trip) => trip?.engine_stress_score)
    .filter((score) => Number.isFinite(score));

  return scores.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : null;
}

export function estimateTripEconomics(trip, vehicle = {}, settings = {}) {
  const distanceKm = Number(trip?.distance_km) || 0;
  const vehicleProfileAvailable = Boolean(vehicle && Object.keys(vehicle).length);
  const fuelType = String(vehicle?.fuel_type || settings.fuel_type || 'gasoline').trim().toLowerCase();
  const isElectric = fuelType === 'electric' || fuelType === 'ev';
  const lPer100Km = isElectric ? 0 : (Number(vehicle?.fuel_efficiency_l_per_100km) || Number(settings.default_l_per_100km) || DEFAULT_L_PER_100KM);
  const evKwhPer100Km = Number(vehicle?.ev_efficiency_kwh_per_100km ?? vehicle?.energy_efficiency_kwh_per_100km ?? settings.default_ev_kwh_per_100km) || DEFAULT_EV_KWH_PER_100KM;
  const gridCo2KgPerKwh = Number(vehicle?.grid_co2_kg_per_kwh ?? settings.grid_co2_kg_per_kwh);
  const hasKnownGridCo2 = Number.isFinite(gridCo2KgPerKwh);
  const effectiveGridCo2KgPerKwh = Number.isFinite(gridCo2KgPerKwh) ? gridCo2KgPerKwh : DEFAULT_GRID_CO2_KG_PER_KWH;
  const fuelPrice = Number(vehicle?.fuel_price_per_liter) || Number(settings.default_fuel_price_per_liter) || DEFAULT_FUEL_PRICE_PER_LITER;
  const rawEcoDrivingScore = trip?.eco_driving_score == null || trip?.eco_driving_score === ''
    ? NaN
    : Number(trip.eco_driving_score);
  const ecoDrivingScore = Number.isFinite(rawEcoDrivingScore) ? clamp(rawEcoDrivingScore, 0, 100) : null;
  const economyAdjustmentMultiplier = ecoDrivingScore == null
    ? 1
    : clamp(
      1 - ((ecoDrivingScore - 50) / 50) * ECO_DRIVING_MAX_ECONOMY_ADJUSTMENT,
      1 - ECO_DRIVING_MAX_ECONOMY_ADJUSTMENT,
      1 + ECO_DRIVING_MAX_ECONOMY_ADJUSTMENT
    );
  const actualLPer100Km = lPer100Km * economyAdjustmentMultiplier;
  const actualEvKwhPer100Km = evKwhPer100Km * economyAdjustmentMultiplier;
  const baselineLiters = distanceKm * lPer100Km / 100;
  const adjustedLiters = distanceKm * actualLPer100Km / 100;
  const baselineKwh = isElectric ? distanceKm * evKwhPer100Km / 100 : 0;
  const adjustedKwh = isElectric ? distanceKm * actualEvKwhPer100Km / 100 : 0;
  const cost = isElectric ? adjustedKwh * fuelPrice : adjustedLiters * fuelPrice;
  const baselineCost = isElectric ? baselineKwh * fuelPrice : baselineLiters * fuelPrice;
  const co2Factor = CO2_KG_PER_LITER[fuelType] ?? GASOLINE_CO2_KG_PER_LITER;
  const fuelCo2Kg = isElectric ? 0 : adjustedLiters * co2Factor;
  const gridCo2Kg = isElectric ? adjustedKwh * effectiveGridCo2KgPerKwh : 0;
  const co2Kg = fuelCo2Kg + gridCo2Kg;
  const fuelSavedLiters = vehicleProfileAvailable
    ? Math.max(0, baselineLiters - adjustedLiters)
    : null;
  const roundedCo2Kg = Math.round(co2Kg * 100) / 100;
  const roundedFuelCo2Kg = Math.round(fuelCo2Kg * 100) / 100;
  const roundedGridCo2Kg = Math.round(gridCo2Kg * 100) / 100;
  const vehicleBaselineCo2KgPer100Km = Number(vehicle?.co2_baseline_kg_per_100km);
  const settingsBaselineCo2KgPer100Km = Number(settings.co2_baseline_kg_per_100km);
  const baselineCo2KgPer100Km = Number.isFinite(vehicleBaselineCo2KgPer100Km)
    ? vehicleBaselineCo2KgPer100Km
    : Number.isFinite(settingsBaselineCo2KgPer100Km)
      ? settingsBaselineCo2KgPer100Km
      : DEFAULT_CO2_BASELINE_KG_PER_100KM;
  const baselineSource = Number.isFinite(vehicleBaselineCo2KgPer100Km)
    ? 'vehicle'
    : 'fleet average estimate';
  const estimateErrorPct = baselineSource === 'vehicle' ? 15 : 30;
  const avgCo2Kg = distanceKm * baselineCo2KgPer100Km / 100;
  const canClaimCo2Savings = vehicleProfileAvailable && (!isElectric || hasKnownGridCo2);
  const co2SavedKg = canClaimCo2Savings
    ? Math.max(0, Math.round((avgCo2Kg - roundedCo2Kg) * 100) / 100)
    : null;

  return {
    liters: Math.round(adjustedLiters * 100) / 100,
    baseline_liters: Math.round(baselineLiters * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    baseline_cost: Math.round(baselineCost * 100) / 100,
    co2_kg: roundedCo2Kg,
    fuel_co2_kg: roundedFuelCo2Kg,
    grid_co2_kg: roundedGridCo2Kg,
    co2_saved_kg: co2SavedKg,
    co2_baseline_kg_per_100km: baselineCo2KgPer100Km,
    co2_baseline_source: baselineSource,
    co2_saved_available: canClaimCo2Savings,
    estimate_error_pct: estimateErrorPct,
    estimate_label: `This is an estimate (+/-${estimateErrorPct}%).`,
    co2_saved_label: canClaimCo2Savings
      ? `vs. ${baselineSource} (+/-${estimateErrorPct}%)`
      : isElectric
        ? 'Unavailable until grid CO2 intensity is set.'
        : 'Unavailable until a vehicle is assigned.',
    vehicle_profile_available: vehicleProfileAvailable,
    grid_co2_intensity_known: hasKnownGridCo2,
    economy_adjustment_multiplier: Math.round(economyAdjustmentMultiplier * 1000) / 1000,
    l_per_100km: lPer100Km,
    actual_l_per_100km: Math.round(actualLPer100Km * 10) / 10,
    kwh: Math.round(adjustedKwh * 100) / 100,
    baseline_kwh: Math.round(baselineKwh * 100) / 100,
    ev_kwh_per_100km: evKwhPer100Km,
    actual_ev_kwh_per_100km: Math.round(actualEvKwhPer100Km * 10) / 10,
    grid_co2_kg_per_kwh: effectiveGridCo2KgPerKwh,
    fuel_saved_liters: fuelSavedLiters == null ? null : Math.round(fuelSavedLiters * 100) / 100,
    fuel_saved_available: vehicleProfileAvailable,
    fuel_price_per_liter: fuelPrice,
  };
}

export function suggestTripTag(trip = {}) {
  const start = new Date(trip.start_time || trip.created_at || Date.now());
  const hour = start.getHours();
  const dow = start.getDay();
  const durationMin = (Number(trip.duration_seconds) || 0) / 60;
  const distanceKm = Number(trip.distance_km) || 0;
  const weekday = dow >= 1 && dow <= 5;
  const weekend = dow === 0 || dow === 6;
  const rushHour = isMorningRushHour(hour) || isEveningRushHour(hour);

  if (trip.night_driving || isNightRiskHour(hour)) {
    return { auto_tag: 'night', auto_tag_confidence: trip.night_driving ? 'high' : 'medium' };
  }
  if (trip.slippery_proxy === 'likely_wet' || trip.slippery_proxy === 'possible_wet') {
    return { auto_tag: 'rain', auto_tag_confidence: 'medium' };
  }
  if (trip.dominant_road_type === 'highway' || trip.road_type === 'highway') {
    return { auto_tag: 'highway', auto_tag_confidence: 'medium' };
  }
  if (weekday && rushHour && durationMin >= 10 && durationMin <= 90 && distanceKm >= 5 && distanceKm <= 80) {
    return { auto_tag: 'commute', auto_tag_confidence: 'high' };
  }
  if (weekday && hour >= 6 && hour <= 18 && durationMin >= 15) {
    return { auto_tag: 'commute', auto_tag_confidence: 'medium' };
  }
  if (durationMin < 20 && distanceKm < 10) {
    return { auto_tag: 'errand', auto_tag_confidence: 'medium' };
  }
  if (weekend && hour >= 9 && hour <= 17 && distanceKm < 20) {
    return { auto_tag: 'errand', auto_tag_confidence: 'medium' };
  }
  if (distanceKm < 8 && durationMin >= 10) {
    return { auto_tag: 'practice', auto_tag_confidence: 'low' };
  }
  return { auto_tag: 'city', auto_tag_confidence: 'low' };
}

export function buildScoreTips(trips = []) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  if (!completed.length) {
    return ['Not enough data yet. Record a few trips to unlock personalized coaching tips.'];
  }
  const eligible = completed.filter((trip) => (
    (Number(trip.distance_km) || 0) >= SCORE_TIP_MIN_TRIP_KM &&
    Number.isFinite(Number(trip.score_confidence)) &&
    Number(trip.score_confidence) >= SCORE_TIP_MIN_CONFIDENCE
  ));
  if (!eligible.length) return ['Not enough data yet. Complete a trip of at least 2 km for coaching tips.'];

  const totals = {
    harsh_brake: eligible.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0),
    rapid_acceleration: eligible.reduce((sum, trip) => sum + (trip.rapid_accel_count || 0), 0),
    sharp_turn: eligible.reduce((sum, trip) => sum + (trip.sharp_turns_count || 0), 0),
    speeding: eligible.reduce((sum, trip) => sum + (trip.speeding_events_count || 0), 0),
  };

  const worst = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];
  const tips = [];

  if (worst?.[1] > 0) {
    const messages = {
      harsh_brake: 'Most score loss is coming from harsh braking. Leave a larger following gap and lift off earlier before stops.',
      rapid_acceleration: 'Rapid acceleration is your biggest pattern. Try smoother throttle starts to improve smoothness and fuel cost.',
      sharp_turn: 'Sharp turns are showing up most often. Slow before corners, then accelerate after the car is straight.',
      speeding: 'Speeding is your main risk event. Lowering cruise speed is the fastest way to improve safety score.',
    };
    tips.push(messages[worst[0]]);
  }

  const nightTrips = eligible.filter((trip) => trip.night_driving).length;
  if (nightTrips / eligible.length >= 0.35) {
    tips.push('A large share of trips happen at night, where Road Sage applies extra safety risk. Keep routes familiar and take breaks on longer drives.');
  }

  const avgScore = distanceWeightedScore(eligible) ?? 0;
  if (avgScore >= 85) {
    tips.push('Your recent average is excellent. Keep the streak going by protecting smooth starts and early braking.');
  } else if (avgScore < 70) {
    tips.push('Focus on one behavior this week instead of all of them. Cutting the top event type will move the score fastest.');
  }

  return tips.slice(0, 3);
}

export function calculateWeeklyDrivingGoals(trips = [], settings = {}) {
  const weekStart = startOfWeek();
  const weekTrips = trips.filter((trip) => (
    trip.status === 'completed' &&
    new Date(trip.start_time).getTime() >= weekStart.getTime()
  ));
  const harshBrakes = weekTrips.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0);
  const speedingEvents = weekTrips.reduce((sum, trip) => sum + (trip.speeding_events_count || 0), 0);
  const nightTrips = weekTrips.filter((trip) => trip.night_driving).length;
  const nightDistanceKm = Math.round(weekTrips
    .filter((trip) => trip.night_driving)
    .reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0) * 10) / 10;
  const weightedScore = distanceWeightedScore(weekTrips);
  const avgScore = weightedScore == null ? 0 : Math.round(weightedScore);

  return [
    {
      id: 'harsh_brakes',
      label: 'Harsh brakes',
      value: harshBrakes,
      target: Number(settings.weekly_goal_harsh_brakes ?? 5),
      direction: 'under',
      met: harshBrakes <= Number(settings.weekly_goal_harsh_brakes ?? 5),
    },
    {
      id: 'speeding',
      label: 'Speeding events',
      value: speedingEvents,
      target: Number(settings.weekly_goal_speeding_events ?? 3),
      direction: 'under',
      met: speedingEvents <= Number(settings.weekly_goal_speeding_events ?? 3),
    },
    {
      id: 'avg_score',
      label: 'Average score',
      value: avgScore,
      target: Number(settings.weekly_goal_min_avg_score ?? 80),
      direction: 'over',
      met: weightedScore != null && avgScore >= Number(settings.weekly_goal_min_avg_score ?? 80),
    },
    {
      id: 'night_distance',
      label: 'Night distance',
      value: nightDistanceKm,
      target: Number(settings.weekly_goal_max_night_km ?? 20),
      direction: 'under',
      met: nightDistanceKm <= Number(settings.weekly_goal_max_night_km ?? 20),
      unit: 'km',
    },
    {
      id: 'night_trips',
      label: 'Night trips',
      value: nightTrips,
      target: Number(settings.weekly_goal_max_night_trips ?? 3),
      direction: 'under',
      met: nightTrips <= Number(settings.weekly_goal_max_night_trips ?? 3),
    },
  ];
}

export function calculateNoHarshBrakeStreak(trips = []) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  if (!completed.length) return 0;

  const byDay = new Map();
  completed.forEach((trip) => {
    const day = startOfDay(trip.start_time).toISOString().slice(0, 10);
    const current = byDay.get(day) || { trips: 0, harshBrakes: 0 };
    current.trips += 1;
    current.harshBrakes += trip.harsh_brakes_count || 0;
    byDay.set(day, current);
  });

  let cursor = startOfDay(new Date());
  if (!byDay.has(cursor.toISOString().slice(0, 10))) {
    const latestTripDay = completed
      .map((trip) => startOfDay(trip.start_time).getTime())
      .sort((a, b) => b - a)[0];
    cursor = new Date(latestTripDay);
  }

  let streak = 0;
  while (true) {
    const key = cursor.toISOString().slice(0, 10);
    const day = byDay.get(key);
    if (!day) break;
    if (day.harshBrakes > 0) break;
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return streak;
}

export function analyzeTimeOfDay(trips = []) {
  const buckets = [
    { id: 'morning', label: 'Morning', range: '5a-12p', from: 5, to: 12 },
    { id: 'afternoon', label: 'Afternoon', range: '12p-5p', from: 12, to: 17 },
    { id: 'evening', label: 'Evening', range: '5p-10p', from: 17, to: 22 },
    { id: 'night', label: 'Night', range: '10p-5a', from: NIGHT_START_HOUR, to: NIGHT_END_HOUR + 24 },
  ];

  return buckets.map((bucket) => {
    const bucketTrips = trips.filter((trip) => {
      if (trip.status !== 'completed') return false;
      const hour = new Date(trip.start_time).getHours();
      const normalized = hour < NIGHT_END_HOUR ? hour + 24 : hour;
      return normalized >= bucket.from && normalized < bucket.to;
    });
    const weightedScore = distanceWeightedScore(bucketTrips);
    const events = bucketTrips.reduce((sum, trip) => (
      sum +
      (trip.harsh_brakes_count || 0) +
      (trip.rapid_accel_count || 0) +
      (trip.sharp_turns_count || 0) +
      (trip.speeding_events_count || 0)
    ), 0);
    return {
      ...bucket,
      trips: bucketTrips.length,
      avgScore: weightedScore == null ? null : Math.round(weightedScore),
      events,
    };
  });
}

export function analyzeDayOfWeek(trips = []) {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return labels.map((label, index) => {
    const dayTrips = trips.filter((trip) => trip.status === 'completed' && new Date(trip.start_time).getDay() === index);
    const weightedScore = distanceWeightedScore(dayTrips);
    const events = dayTrips.reduce((sum, trip) => (
      sum +
      (trip.harsh_brakes_count || 0) +
      (trip.rapid_accel_count || 0) +
      (trip.sharp_turns_count || 0) +
      (trip.speeding_events_count || 0)
    ), 0);
    return {
      day: label,
      trips: dayTrips.length,
      avgScore: weightedScore == null ? null : Math.round(weightedScore),
      events,
    };
  });
}

export function calculateFatigueRisk(trips = [], settings = {}) {
  const thresholdMinutes = Number(settings.threshold_long_drive_minutes || 120);
  const longTrips = trips.filter((trip) => (trip.duration_seconds || 0) / 60 >= thresholdMinutes);
  const totalLongMinutes = longTrips.reduce((sum, trip) => sum + (trip.duration_seconds || 0) / 60, 0);
  const longestTripMinutes = trips.reduce((max, trip) => Math.max(max, (trip.duration_seconds || 0) / 60), 0);
  return {
    threshold_minutes: thresholdMinutes,
    long_trip_count: longTrips.length,
    total_long_minutes: Math.round(totalLongMinutes),
    longest_trip_minutes: Math.round(longestTripMinutes),
    level: longTrips.length >= 3 || longestTripMinutes >= thresholdMinutes * 1.5 ? 'high' : longTrips.length > 0 ? 'medium' : 'low',
  };
}

export function calculateRiskEventRate(trips = []) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  const distanceKm = completed.reduce((sum, trip) => sum + (trip.distance_km || 0), 0);
  const totals = {
    harsh_brakes: completed.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0),
    rapid_accel: completed.reduce((sum, trip) => sum + (trip.rapid_accel_count || 0), 0),
    sharp_turns: completed.reduce((sum, trip) => sum + (trip.sharp_turns_count || 0), 0),
    speeding: completed.reduce((sum, trip) => sum + (trip.speeding_events_count || 0), 0),
    heading_deviations: completed.reduce((sum, trip) => sum + (trip.heading_deviation_count ?? 0), 0),
    stop_start_patterns: completed.reduce((sum, trip) => sum + (trip.stop_start_pattern_count ?? trip.tailgate_cycle_count ?? 0), 0),
    erratic_speed: completed.reduce((sum, trip) => sum + (trip.distraction_events_count || 0), 0),
    brake_turn_alerts: completed.reduce((sum, trip) => sum + (trip.close_proximity_count ?? 0), 0),
  };
  const totalEvents = Object.values(totals).reduce((sum, count) => sum + count, 0);
  const sufficientData = distanceKm >= RISK_EVENT_RATE_MIN_DISTANCE_KM;
  const per100Km = sufficientData ? Math.round((totalEvents / distanceKm) * 1000) / 10 : null;
  const worst = Object.entries(totals).sort((a, b) => b[1] - a[1])[0] || ['none', 0];

  return {
    distance_km: Math.round(distanceKm * 10) / 10,
    total_events: totalEvents,
    events_per_100km: per100Km,
    insufficient_data: !sufficientData,
    minimum_distance_km: RISK_EVENT_RATE_MIN_DISTANCE_KM,
    worst_event: worst[0],
    worst_event_count: worst[1],
    totals,
  };
}

function isoWeekKey(dateInput) {
  const date = startOfDay(dateInput);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() + 4 - day);
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / DAY_MS) + 1) / 7);
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function computePersonalBaseline(completedTrips = []) {
  const completed = [...completedTrips]
    .filter((trip) => trip.status === 'completed' && Number(trip.score_overall) > 0)
    .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
  const avg = (items) => {
    const score = distanceWeightedScore(items);
    return score == null ? null : Math.round(score);
  };
  const exponentiallyWeighted = (items) => {
    const valid = items.filter((trip) => Number.isFinite(Number(trip.score_overall)));
    if (!valid.length) return { average: null, interval: null };
    const weighted = valid.map((trip, index) => ({
      score: Number(trip.score_overall),
      weight: Math.pow(PERSONAL_BASELINE_DECAY, index),
    }));
    const weightSum = weighted.reduce((sum, item) => sum + item.weight, 0);
    const averageScore = weighted.reduce((sum, item) => sum + item.score * item.weight, 0) / weightSum;
    const variance = weighted.reduce((sum, item) => sum + item.weight * ((item.score - averageScore) ** 2), 0) / weightSum;
    const weightSquares = weighted.reduce((sum, item) => sum + item.weight ** 2, 0);
    const effectiveSamples = weightSum ** 2 / Math.max(weightSquares, 1);
    const interval = Math.ceil(1.96 * Math.sqrt(variance / Math.max(1, effectiveSamples)));
    return { average: Math.round(averageScore), interval };
  };

  const now = new Date();
  const fourWeeksAgo = new Date(now.getTime() - 28 * DAY_MS);
  const weekStart = startOfWeek(now);
  const baselineTrips = completed.filter((trip) => new Date(trip.start_time) >= fourWeeksAgo);
  const thisWeekTrips = completed.filter((trip) => new Date(trip.start_time) >= weekStart);
  const weightedBaseline = exponentiallyWeighted(baselineTrips);
  const baselineAvg = baselineTrips.length >= PERSONAL_BASELINE_MIN_TRIPS ? weightedBaseline.average : null;
  const baselineInterval = baselineAvg == null ? null : weightedBaseline.interval;
  const thisWeekAvg = avg(thisWeekTrips);
  const delta = thisWeekAvg != null && baselineAvg != null ? thisWeekAvg - baselineAvg : null;
  const trend = delta == null ? 'unknown' : delta >= 5 ? 'improving' : delta <= -5 ? 'declining' : 'steady';

  const twelveWeeksAgo = new Date(now.getTime() - 12 * 7 * DAY_MS);
  const byWeek = new Map();
  completed
    .filter((trip) => new Date(trip.start_time) >= twelveWeeksAgo)
    .forEach((trip) => {
      const key = isoWeekKey(trip.start_time);
      const current = byWeek.get(key) || [];
      current.push(trip);
      byWeek.set(key, current);
    });
  const weeklyAverages = [...byWeek.values()]
    .map((trips) => avg(trips))
    .filter((score) => score != null)
    .sort((a, b) => a - b);
  const weeksBelow = thisWeekAvg == null ? 0 : weeklyAverages.filter((score) => score < thisWeekAvg).length;
  const percentileValue = weeklyAverages.length ? (weeksBelow / weeklyAverages.length) * 100 : 0;

  return {
    baseline_avg: baselineAvg,
    baseline_confidence_interval: baselineInterval,
    baseline_confidence_interval_method: baselineAvg == null ? null : PERSONAL_BASELINE_INTERVAL_METHOD,
    baseline_confidence_interval_note: baselineAvg == null ? null : PERSONAL_BASELINE_INTERVAL_NOTE,
    baseline_trip_count: baselineTrips.length,
    baseline_confidence: baselineAvg == null ? 'insufficient_data' : baselineTrips.length >= 20 ? 'high' : 'developing',
    this_week_avg: thisWeekAvg,
    delta,
    trend,
    percentile: weeklyAverages.length >= PERSONAL_PERCENTILE_MIN_WEEKS ? Math.round(percentileValue) : null,
    percentile_label: 'Percentile among your recorded weeks',
    percentile_min_weeks: PERSONAL_PERCENTILE_MIN_WEEKS,
    personal_best_week_avg: weeklyAverages.length ? Math.max(...weeklyAverages) : null,
    personal_best_trip_score: weeklyAverages.length
      ? Math.max(...completed.map((trip) => finiteScore(trip.score_overall)).filter(Number.isFinite))
      : null,
    weeks_analyzed: weeklyAverages.length,
  };
}

export function calculatePeakHourStress(completedTrips = []) {
  const peakHours = new Set([7, 8, 16, 17, 18]);
  const peakRates = [];
  const offPeakRates = [];

  completedTrips
    .filter((trip) => trip.status === 'completed' && (Number(trip.distance_km) || 0) >= PEAK_STRESS_MIN_TRIP_KM)
    .forEach((trip) => {
      const hour = new Date(trip.start_time).getHours();
      const eventCount =
        (trip.harsh_brakes_count || 0) +
        (trip.rapid_accel_count || 0) +
        (trip.sharp_turns_count || 0) +
        (trip.speeding_events_count || 0);
      const eventsPerKm = eventCount / Number(trip.distance_km);
      if (peakHours.has(hour)) peakRates.push(eventsPerKm);
      else offPeakRates.push(eventsPerKm);
    });

  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const peakAvg = mean(peakRates);
  const offPeakAvg = mean(offPeakRates);
  const insufficientData = peakRates.length === 0 || offPeakRates.length === 0 || offPeakAvg <= 0.01;
  const stressRatio = insufficientData ? null : Math.min(5, peakAvg / offPeakAvg);
  const peakStressScore = stressRatio == null ? null : Math.max(0, Math.round(100 - (stressRatio - 1) * 40));

  return {
    peak_trips_event_rate: insufficientData ? null : Math.round(peakAvg * 100) / 100,
    off_peak_trips_event_rate: insufficientData ? null : Math.round(offPeakAvg * 100) / 100,
    stress_ratio: stressRatio == null ? null : Math.round(stressRatio * 10) / 10,
    peak_stress_score: peakStressScore,
    peak_stress_label: insufficientData
      ? 'insufficient off-peak data'
      : peakStressScore >= 85
      ? 'consistent'
      : peakStressScore >= 65
        ? 'slightly stressed'
        : peakStressScore >= 40
          ? 'traffic-affected'
          : 'significantly stressed',
    peak_trip_count: peakRates.length,
    off_peak_trip_count: offPeakRates.length,
    insufficient_data: insufficientData,
  };
}

export function identifyCommutePatterns(completedTrips = []) {
  const groups = new Map();
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  completedTrips
    .filter((trip) => trip.status === 'completed' && Array.isArray(trip.route_points) && trip.route_points.length >= 2)
    .forEach((trip) => {
      const routeKey = commuteRouteKeyForTrip(trip);
      if (!routeKey) return;
      const group = groups.get(routeKey) || [];
      group.push(trip);
      groups.set(routeKey, group);
    });

  return [...groups.entries()]
    .filter(([, trips]) => trips.length >= 3)
    .map(([routeKey, trips]) => {
      const sorted = [...trips].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
      const scores = sorted.map((trip) => finiteScore(trip.score_overall)).filter(Number.isFinite);
      const avgScore = distanceWeightedScore(sorted) ?? 0;
      const recentAvg = distanceWeightedScore(sorted.slice(-3)) ?? 0;
      const firstDriven = new Date(sorted[0].start_time).getTime();
      const lastDriven = new Date(sorted[sorted.length - 1].start_time).getTime();
      const weeksInRange = Math.max(1, (lastDriven - firstDriven) / (7 * DAY_MS));
      const avgDurationMinutes = mean(sorted.map((trip) => (trip.duration_seconds || 0) / 60));

      return {
        route_key: routeKey,
        trip_count: sorted.length,
        avg_distance_km: Math.round(mean(sorted.map((trip) => trip.distance_km || 0)) * 10) / 10,
        avg_duration_minutes: Math.round(avgDurationMinutes),
        avg_score: Math.round(avgScore),
        best_score: scores.length ? Math.max(...scores) : null,
        worst_score: scores.length ? Math.min(...scores) : null,
        score_trend: recentAvg > avgScore + 3 ? 'improving' : recentAvg < avgScore - 3 ? 'declining' : 'stable',
        last_driven: new Date(lastDriven).toISOString(),
        weekly_minutes_estimate: Math.round((sorted.length / weeksInRange) * avgDurationMinutes),
      };
    })
    .sort((a, b) => b.trip_count - a.trip_count)
    .slice(0, 10);
}

export function calculateTireWearUnits(events = []) {
  const severityBase = { low: 1, medium: 2.5, high: 5 };
  let units = 0;
  let missingSpeedEventCount = 0;
  for (const event of events) {
    if (event.type !== 'harsh_brake' && event.type !== 'sharp_turn') continue;
    const referenceSpeed = event.type === 'harsh_brake' ? 50 : 40;
    const speed = Number(event.speed_kmh);
    const hasSpeed = event.speed_kmh != null && event.speed_kmh !== '' && Number.isFinite(speed) && speed >= 0;
    if (!hasSpeed) missingSpeedEventCount++;
    const speedFactor = hasSpeed ? Math.pow(speed / referenceSpeed, 2) : 1;
    units += (severityBase[event.severity] || 0) * speedFactor;
  }
  return {
    trip_tire_wear_units: Math.round(units * 10) / 10,
    trip_tire_wear_has_missing_speed_data: missingSpeedEventCount > 0,
    trip_tire_wear_missing_speed_event_count: missingSpeedEventCount,
  };
}

function getTripTireWearMissingSpeedEventCount(trip = {}) {
  const storedCount = Number(trip.trip_tire_wear_missing_speed_event_count);
  if (
    trip.trip_tire_wear_missing_speed_event_count != null &&
    trip.trip_tire_wear_missing_speed_event_count !== '' &&
    Number.isFinite(storedCount) &&
    storedCount >= 0
  ) return storedCount;
  if (
    trip.trip_tire_wear_units == null ||
    trip.trip_tire_wear_units === '' ||
    !Number.isFinite(Number(trip.trip_tire_wear_units))
  ) return 0;
  return calculateTireWearUnits(Array.isArray(trip.driving_events) ? trip.driving_events : [])
    .trip_tire_wear_missing_speed_event_count;
}

export function calculateCarbonImpact(completedTrips = [], settings = {}, vehicles = null) {
  const vehicleForTrip = (trip) => {
    if (!vehicles) return {};
    if (vehicles instanceof Map) return vehicles.get(String(trip?.vehicle_id)) || null;
    if (Array.isArray(vehicles)) {
      return vehicles.find((vehicle) => String(vehicle.id) === String(trip?.vehicle_id)) || null;
    }
    return null;
  };
  let eligibleTripCount = 0;
  const totalCo2SavedKg = Math.round(completedTrips.reduce((sum, trip) => {
    if (trip?.status !== 'completed' || !(Number(trip?.distance_km) > 0)) return sum;
    const vehicle = vehicleForTrip(trip);
    if (vehicles && !vehicle) return sum;
    const saved = vehicles ? null : Number(trip?.co2_saved_kg);
    if (Number.isFinite(saved)) {
      eligibleTripCount += 1;
      return sum + saved;
    }
    const estimatedSaved = estimateTripEconomics(trip, vehicle, settings).co2_saved_kg;
    if (!Number.isFinite(estimatedSaved)) return sum;
    eligibleTripCount += 1;
    return sum + estimatedSaved;
  }, 0) * 10) / 10;
  const treeCo2KgPerYear = Number(settings.tree_co2_kg_per_year);
  const effectiveTreeCo2KgPerYear = Number.isFinite(treeCo2KgPerYear) && treeCo2KgPerYear > 0
    ? treeCo2KgPerYear
    : DEFAULT_TREE_CO2_KG_PER_YEAR;
  const treesEquivalent = Math.round((totalCo2SavedKg / effectiveTreeCo2KgPerYear) * 10) / 10;
  return {
    total_co2_saved_kg: totalCo2SavedKg,
    eligible_trip_count: eligibleTripCount,
    savings_available: eligibleTripCount > 0,
    trees_equivalent: treesEquivalent,
    carbon_grade: totalCo2SavedKg >= 100
      ? 'Climate Champion'
      : totalCo2SavedKg >= 50
        ? 'Green Driver'
        : totalCo2SavedKg >= 20
          ? 'Eco Aware'
          : totalCo2SavedKg >= 5
            ? 'Getting There'
            : 'Starting Out',
  };
}

export function calculateVehicleHealthImpact(vehicleTrips = [], vehicle = {}) {
  const completed = vehicleTrips.filter((trip) => trip.status === 'completed');
  let totalStressUnits = 0;
  let aggressiveKm = 0;

  for (const trip of completed) {
    const events = Array.isArray(trip.driving_events) ? trip.driving_events : [];
    const tripStress = events.reduce((sum, event) => (
      sum + (STRESS_UNITS[event.type]?.[event.severity] || 0)
    ), 0);
    totalStressUnits += tripStress;
    if (events.length > 0) aggressiveKm += Number(trip.distance_km) || 0;
  }

  const totalDistanceKm = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const aggressiveRatio = totalDistanceKm > 0 ? aggressiveKm / totalDistanceKm : 0;
  const oilBase = Number(vehicle.oil_change_interval_km) || 8000;
  const tireBase = Number(vehicle.tire_rotation_interval_km) || 10000;
  const totalTireWear = completed.reduce((sum, trip) => sum + (Number(trip.trip_tire_wear_units) || 0), 0);
  const tireWearMissingSpeedEventCount = completed.reduce((sum, trip) => sum + getTripTireWearMissingSpeedEventCount(trip), 0);
  const tireWearHasMissingSpeedData = tireWearMissingSpeedEventCount > 0 || completed.some((trip) => trip.trip_tire_wear_has_missing_speed_data === true);
  const tireWearGrade = totalTireWear < 50 ? 'minimal' : totalTireWear < 150 ? 'normal' : totalTireWear < 300 ? 'elevated' : 'accelerated';
  const avgEngineStressScore = calculateAverageEngineStressScore(completed);
  const baseHealthGrade = totalStressUnits < 50 ? 'A' : totalStressUnits < 150 ? 'B' : totalStressUnits < 300 ? 'C' : 'D';
  const downgrade = (grade) => ({ A: 'B', B: 'C', C: 'D', D: 'D' }[grade] || grade);
  const healthGrade = avgEngineStressScore != null && avgEngineStressScore < 55
    ? downgrade(baseHealthGrade)
    : baseHealthGrade;
  const engineStressGrade = avgEngineStressScore == null
    ? 'unknown'
    : avgEngineStressScore >= 90
      ? 'low stress'
      : avgEngineStressScore >= 70
        ? 'moderate'
        : avgEngineStressScore >= 50
          ? 'high'
          : 'critical';

  return {
    total_stress_units: Math.round(totalStressUnits * 10) / 10,
    extra_wear_km: Math.round(totalStressUnits * WEAR_KM_PER_STRESS_UNIT),
    aggressive_ratio: Math.round(aggressiveRatio * 100),
    adjusted_oil_change_km: aggressiveRatio > 0.3 ? Math.round(oilBase * 0.85) : oilBase,
    adjusted_tire_rotation_km: aggressiveRatio > 0.3 ? Math.round(tireBase * 0.80) : tireBase,
    health_grade: healthGrade,
    engine_stress_score: avgEngineStressScore == null ? null : Math.round(avgEngineStressScore),
    engine_stress_grade: engineStressGrade,
    vehicle_tire_wear_total: Math.round(totalTireWear * 10) / 10,
    tire_wear_grade: tireWearGrade,
    tire_wear_has_missing_speed_data: tireWearHasMissingSpeedData,
    tire_wear_missing_speed_event_count: tireWearMissingSpeedEventCount,
    tire_life_impact_km: Math.round(totalTireWear * 0.5),
  };
}

export function calculateSpeedDiscipline(trips = [], settings = {}) {
  const speedLimit = Number(settings.threshold_speeding_kmh ?? 100);
  const warnLimit = speedLimit + Number(settings.threshold_speed_over_kmh ?? 5);
  const speeds = trips
    .filter((trip) => trip.status === 'completed')
    .flatMap((trip) => Array.isArray(trip.route_points) ? trip.route_points : [])
    .map((point) => Number(point.speed_kmh))
    .filter((speed) => Number.isFinite(speed) && speed > 5)
    .sort((a, b) => a - b);

  if (!speeds.length) {
    return {
      sample_points: 0,
      max_speed_kmh: 0,
      avg_speed_kmh: 0,
      p85_speed_kmh: 0,
      over_limit_points: 0,
      over_warn_points: 0,
      over_warn_count: 0,
      over_limit_percent: 0,
      over_limit_pct: 0,
      level: 'unknown',
    };
  }

  const overLimit = speeds.filter((speed) => speed > speedLimit).length;
  const overWarn = speeds.filter((speed) => speed > warnLimit).length;
  const overLimitPercent = Math.round((overLimit / speeds.length) * 100);
  const p85Speed = percentile(speeds, 85);
  const avgSpeed = speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
  const level = overWarn > 0 || overLimitPercent >= 10
    ? 'needs_attention'
    : overLimitPercent > 0 || p85Speed > speedLimit * 0.85
      ? 'watch'
      : 'steady';

  return {
    sample_points: speeds.length,
    max_speed_kmh: Math.round(Math.max(...speeds)),
    avg_speed_kmh: Math.round(avgSpeed * 10) / 10,
    p85_speed_kmh: Math.round(p85Speed * 10) / 10,
    over_limit_points: overLimit,
    over_warn_points: overWarn,
    over_warn_count: overWarn,
    over_limit_percent: overLimitPercent,
    over_limit_pct: overLimitPercent,
    level,
  };
}

function consistencyRoadTypeForTrip(trip = {}) {
  const explicitType = trip.dominant_road_type || trip.road_type;
  if (DRIVING_CONSISTENCY_IQR_MULTIPLIERS[explicitType]) return explicitType;
  return null;
}

function calculateConsistencyIqrMultiplier(trips = []) {
  const counts = trips.reduce((acc, trip) => {
    const roadType = consistencyRoadTypeForTrip(trip);
    if (roadType) acc.set(roadType, (acc.get(roadType) || 0) + 1);
    return acc;
  }, new Map());

  if (!counts.size) return DRIVING_CONSISTENCY_IQR_MULTIPLIERS.highway;

  const [dominantType] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return DRIVING_CONSISTENCY_IQR_MULTIPLIERS[dominantType];
}

export function calculateDrivingConsistency(trips = []) {
  const completedWithScores = trips
    .filter((trip) => trip.status === 'completed' && Number(trip.score_overall) > 0);
  const scores = completedWithScores
    .map((trip) => Number(trip.score_overall))
    .sort((a, b) => a - b);

  if (scores.length < 3) {
    const weightedScore = distanceWeightedScore(completedWithScores);
    return {
      trip_count: scores.length,
      avg_score: weightedScore == null ? 0 : Math.round(weightedScore),
      score_variation: null,
      consistency_score: null,
      iqr: null,
      q1: null,
      q3: null,
      level: 'unknown',
    };
  }

  const avg = distanceWeightedScore(completedWithScores) ?? (scores.reduce((sum, score) => sum + score, 0) / scores.length);
  const q1 = percentile(scores, 25);
  const q3 = percentile(scores, 75);
  const iqr = q3 - q1;
  const iqrMultiplier = calculateConsistencyIqrMultiplier(completedWithScores);
  const consistencyScore = Math.max(0, Math.round(100 - iqr * iqrMultiplier));

  return {
    trip_count: scores.length,
    avg_score: Math.round(avg),
    score_variation: Math.round(iqr),
    consistency_score: consistencyScore,
    iqr: Math.round(iqr * 10) / 10,
    q1: Math.round(q1 * 10) / 10,
    q3: Math.round(q3 * 10) / 10,
    iqr_multiplier: iqrMultiplier,
    level: consistencyScore >= 85 ? 'steady' : consistencyScore >= 70 ? 'mixed' : 'inconsistent',
  };
}

export function buildDrivingCoachInsights(trips = [], settings = {}) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  const riskRate = calculateRiskEventRate(completed);
  const speed = calculateSpeedDiscipline(completed, settings);
  const consistency = calculateDrivingConsistency(completed);
  const fatigue = calculateFatigueRisk(completed, settings);
  const baseline = computePersonalBaseline(completed);
  const peakHourStress = calculatePeakHourStress(completed);
  const commutePatterns = identifyCommutePatterns(completed);
  const carbonImpact = calculateCarbonImpact(completed, settings);
  const timeOfDay = analyzeTimeOfDay(completed);
  const bestWindow = timeOfDay
    .filter((bucket) => bucket.trips >= BEST_WINDOW_MIN_TRIPS && bucket.avgScore !== null)
    .sort((a, b) => b.avgScore - a.avgScore || a.events - b.events)[0] || null;

  const eventLabels = {
    harsh_brakes: 'braking',
    rapid_accel: 'acceleration',
    sharp_turns: 'cornering',
    speeding: 'speed control',
    heading_deviations: 'heading events',
    stop_start_patterns: 'stop-start patterns',
    erratic_speed: 'attention-pattern review',
    brake_turn_alerts: 'brake-turn alert review',
  };
  const recentTen = [...completed]
    .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime())
    .slice(0, 10);
  const recentManoeuvreAlerts = recentTen.reduce((sum, trip) => sum + (trip.close_proximity_count ?? 0), 0);
  const recentPhoneRiskyTrips = recentTen.filter((trip) => (
    trip.phone_use_score_available === true &&
    (trip.phone_use_risk === 'medium' || trip.phone_use_risk === 'high')
  )).length;
  const thirtyDaysAgo = Date.now() - 30 * DAY_MS;
  const recentThirty = completed.filter((trip) => new Date(trip.start_time || trip.created_at || 0).getTime() >= thirtyDaysAgo);
  const abruptBrakeOnsetTrips = recentThirty.filter((trip) => ['abrupt', 'very_abrupt'].includes(trip.brake_onset_smoothness_grade)).length;
  const emergencyHeavyTrips = recentThirty.filter((trip) =>
    ['poor', 'emergency_heavy'].includes(trip.braking_efficiency_grade)
  ).length;
  const common = (field) => {
    const counts = new Map();
    recentTen.forEach((trip) => counts.set(trip[field], (counts.get(trip[field]) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const focusArea = recentManoeuvreAlerts > 0
    ? 'brake-turn alert review'
    : recentPhoneRiskyTrips >= 3
      ? 'phone_distraction'
      : abruptBrakeOnsetTrips >= 3
      ? 'progressive braking'
      : emergencyHeavyTrips > 0
        ? 'progressive braking'
        : common('heading_drift_beta_level') === 'high'
      ? 'heading drift review'
      : common('aggressive_grade') === 'aggressive'
        ? 'aggressive driving'
        : riskRate.worst_event_count > 0
          ? eventLabels[riskRate.worst_event]
          : speed.level === 'needs_attention'
            ? 'speed control'
            : fatigue.level === 'high'
              ? 'fatigue breaks'
              : 'consistency';

  const actions = [];
  if (recentPhoneRiskyTrips >= 3) {
    actions.push(`Put your phone away before driving. Phone use patterns were recorded in ${recentPhoneRiskyTrips} of your last 10 trips; use Do Not Disturb, a mount, or Android Auto before starting.`);
  }
  if (riskRate.worst_event === 'harsh_brakes' && riskRate.worst_event_count > 0) {
    actions.push('Brake earlier for the next five stops and leave one extra car length ahead.');
  } else if (riskRate.worst_event === 'rapid_accel' && riskRate.worst_event_count > 0) {
    actions.push('Use a three-second throttle ramp after each stop instead of jumping to cruising speed.');
  } else if (riskRate.worst_event === 'sharp_turns' && riskRate.worst_event_count > 0) {
    actions.push('Set corner speed before the turn, then accelerate only after the steering wheel starts straightening.');
  } else if (riskRate.worst_event === 'speeding' && riskRate.worst_event_count > 0) {
    actions.push('Pick a cruise target 5 km/h below your alert threshold for the next week.');
  }

  if (speed.level === 'needs_attention') {
    actions.push('Review route replay for red/orange speed segments and find the roads where speed climbs most often.');
  }
  if (fatigue.level !== 'low') {
    actions.push(`Take a break before ${fatigue.threshold_minutes} minutes on long drives.`);
  }
  if ((riskRate.totals.stop_start_patterns || 0) > 0) {
    actions.push('Review repeated stop-start patterns on highway segments; this GPS signal does not measure vehicle gap.');
  }
  if ((riskRate.totals.heading_deviations || 0) > 0) {
    actions.push('Review heading events marked Beta; road curvature or GPS noise can explain these patterns.');
  }
  if ((riskRate.totals.erratic_speed || 0) > 0) {
    actions.push('On city routes, keep a steadier throttle through low-speed stretches.');
  }
  if (abruptBrakeOnsetTrips >= 3) {
    actions.push('Build braking force more progressively; recent detected stops have abrupt brake-onset patterns.');
  }
  if (emergencyHeavyTrips > 0) {
    actions.push('Start braking with light pressure, then build smoothly so full stops are less abrupt.');
  }
  const maxSpeedCreep = completed.reduce((max, trip) => Math.max(max, trip.max_speed_creep_kmh || 0), 0);
  if (maxSpeedCreep > 20) {
    actions.push('Set cruise control on highways to prevent unconscious speed creep.');
  }
  if (peakHourStress.stress_ratio > 1.8) {
    actions.push('Your driving becomes significantly more aggressive during rush hour. Try leaving 10 minutes earlier to reduce pressure.');
  }
  const poorMerges = completed.reduce((sum, trip) => sum + (trip.poor_merge_count || 0), 0);
  if (poorMerges > 0) {
    actions.push('Accelerate to highway speed before merging; aim for 100 km/h before joining traffic.');
  }
  const erraticSviTrips = completed.filter((trip) => ['erratic', 'very erratic'].includes(trip.svi_label)).length;
  if (erraticSviTrips > 0) {
    actions.push('Try to maintain a steadier speed. Anticipate traffic flow rather than reacting to it.');
  }
  if (baseline.trend === 'improving') {
    actions.push(`This week is ${baseline.delta} points above your 4-week baseline. Protect that pattern.`);
  }
  if (bestWindow) {
    actions.push(`Your strongest recorded driving window is ${bestWindow.label.toLowerCase()} (${bestWindow.trips} trips); compare tougher trips against that personal pattern.`);
  }

  return {
    trip_count: completed.length,
    focus_area: focusArea,
    risk_rate: riskRate,
    speed_discipline: speed,
    consistency,
    fatigue,
    baseline,
    peak_hour_stress: peakHourStress,
    peak_stress: peakHourStress,
    commute_patterns: commutePatterns,
    carbon_impact: carbonImpact,
    best_window: bestWindow,
    best_window_min_trips: BEST_WINDOW_MIN_TRIPS,
    actions: actions.length ? actions.slice(0, 4) : ['Record more trips to build a personalized driving plan.'],
  };
}

export function calculateAchievementBadges(trips = [], settings = {}, vehicles = null) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  const totalKm = completed.reduce((sum, trip) => sum + (trip.distance_km || 0), 0);
  const nightCount = completed.filter((trip) => trip.night_driving).length;
  const cleanTrips = completed.filter((trip) => (
    (trip.harsh_brakes_count || 0) === 0 &&
    (trip.rapid_accel_count || 0) === 0 &&
    (trip.sharp_turns_count || 0) === 0 &&
    (trip.speeding_events_count || 0) === 0
  ));
  const weekAgo = Date.now() - 7 * 86400000;
  const weekTrips = completed.filter((trip) => new Date(trip.start_time).getTime() >= weekAgo);
  const weekHarshBrakes = weekTrips.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0);
  const noHarshTrips = completed.filter((trip) => (trip.harsh_brakes_count || 0) === 0).length;
  const noRapidTrips = completed.filter((trip) => (trip.rapid_accel_count || 0) === 0).length;
  const noSharpTrips = completed.filter((trip) => (trip.sharp_turns_count || 0) === 0).length;
  const noSpeedingTrips = completed.filter((trip) => (trip.speeding_events_count || 0) === 0).length;
  const routeReplayTrips = completed.filter((trip) => {
    const points = Array.isArray(trip.route_points) ? trip.route_points : [];
    const pointCount = Number(trip.route_points_raw_count) || points.length;
    return pointCount >= 20 && points.some((point) => Number(point.speed_kmh) > 0);
  }).length;
  const cleanLongTrips = cleanTrips.filter((trip) => (trip.duration_seconds || 0) >= 60 * 60).length;
  const recentFive = [...completed]
    .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime())
    .slice(0, 5);
  const recentFiveAvg = distanceWeightedScore(recentFive) ?? 0;
  const avgScore = distanceWeightedScore(completed) ?? 0;
  const smoothBrakeTrips = completed.filter((trip) => trip.smooth_braking_ratio === 100).length;
  const distractionFreeTrips = completed.filter((trip) => (
    trip.phone_use_score_available === true && trip.phone_use_risk === 'none'
  )).length;
  const sortedRecent = [...completed].sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
  const lastTenDefensive = sortedRecent.slice(0, 10);
  const defensiveStreak = lastTenDefensive.length >= 10 && lastTenDefensive.every((trip) => (
    ['defensive', 'exemplary'].includes(trip.defensive_grade)
  ));
  const cruiseMasterTrips = completed.filter((trip) => trip.band_label === 'excellent cruise').length;
  const manoeuvreAlertFreeTrips = completed.filter((trip) => (trip.close_proximity_count ?? 0) === 0).length;
  const carbon = calculateCarbonImpact(completed, settings, vehicles);

  return [
    {
      id: 'first_drive',
      label: 'First Drive',
      description: 'Save your first completed trip.',
      category: 'Getting Started',
      earned: completed.length >= 1,
      current: Math.min(1, completed.length),
      target: 1,
      unit: 'trip',
    },
    {
      id: 'five_trips',
      label: 'Getting Rolling',
      description: 'Complete 5 tracked trips.',
      category: 'Consistency',
      earned: completed.length >= 5,
      current: Math.min(5, completed.length),
      target: 5,
      unit: 'trips',
    },
    {
      id: 'ten_trips',
      label: 'Road Regular',
      description: 'Complete 10 tracked trips.',
      category: 'Consistency',
      earned: completed.length >= 10,
      current: Math.min(10, completed.length),
      target: 10,
      unit: 'trips',
    },
    {
      id: 'perfect_trip',
      label: 'Perfect Trip',
      description: 'Complete a 95+ score trip with no risky events.',
      category: 'Score',
      earned: completed.some((trip) => (trip.score_overall || 0) >= 95 && cleanTrips.includes(trip)),
      current: completed.some((trip) => (trip.score_overall || 0) >= 95 && cleanTrips.includes(trip)) ? 1 : 0,
      target: 1,
    },
    {
      id: 'clean_week',
      label: 'Clean Week',
      description: 'Finish the last 7 days with no harsh braking.',
      category: 'Safety',
      earned: weekTrips.length > 0 && weekHarshBrakes === 0,
      current: weekTrips.length > 0 && weekHarshBrakes === 0 ? 1 : 0,
      target: 1,
    },
    {
      id: 'hundred_km',
      label: '100 km Club',
      description: 'Record 100 km of completed driving.',
      category: 'Distance',
      earned: totalKm >= 100,
      current: Math.min(100, Math.round(totalKm)),
      target: 100,
      unit: 'km',
    },
    {
      id: 'five_hundred_km',
      label: '500 km Club',
      description: 'Record 500 km of completed driving.',
      category: 'Distance',
      earned: totalKm >= 500,
      current: Math.min(500, Math.round(totalKm)),
      target: 500,
      unit: 'km',
    },
    {
      id: 'smooth_driver',
      label: 'Smooth Driver',
      description: 'Average 85+ over at least 10 trips.',
      category: 'Score',
      earned: completed.length >= 10 && avgScore >= 85,
      current: Math.min(10, completed.length),
      target: 10,
      unit: 'trips',
    },
    {
      id: 'steady_five',
      label: 'Steady Five',
      description: 'Average 85+ across your last 5 trips.',
      category: 'Score',
      earned: recentFive.length >= 5 && recentFiveAvg >= 85,
      current: Math.min(5, recentFive.length),
      target: 5,
      unit: 'trips',
    },
    {
      id: 'gentle_brakes',
      label: 'Gentle Brakes',
      description: 'Complete 10 trips without harsh braking.',
      category: 'Safety',
      earned: noHarshTrips >= 10,
      current: Math.min(10, noHarshTrips),
      target: 10,
      unit: 'trips',
    },
    {
      id: 'smooth_starts',
      label: 'Smooth Starts',
      description: 'Complete 10 trips without rapid acceleration.',
      category: 'Safety',
      earned: noRapidTrips >= 10,
      current: Math.min(10, noRapidTrips),
      target: 10,
      unit: 'trips',
    },
    {
      id: 'corner_control',
      label: 'Corner Control',
      description: 'Complete 10 trips without sharp turns.',
      category: 'Safety',
      earned: noSharpTrips >= 10,
      current: Math.min(10, noSharpTrips),
      target: 10,
      unit: 'trips',
    },
    {
      id: 'speed_sentinel',
      label: 'Speed Sentinel',
      description: 'Complete 10 trips without speeding events.',
      category: 'Speed',
      earned: noSpeedingTrips >= 10,
      current: Math.min(10, noSpeedingTrips),
      target: 10,
      unit: 'trips',
    },
    {
      id: 'daily_driver',
      label: 'Daily Driver',
      description: 'Complete 5 trips in the last 7 days.',
      category: 'Consistency',
      earned: weekTrips.length >= 5,
      current: Math.min(5, weekTrips.length),
      target: 5,
      unit: 'trips',
    },
    {
      id: 'route_replay_ready',
      label: 'Route Replay Ready',
      description: 'Record a trip with 20+ GPS points and speed data.',
      category: 'Routes',
      earned: routeReplayTrips >= 1,
      current: Math.min(1, routeReplayTrips),
      target: 1,
      unit: 'trip',
    },
    {
      id: 'long_drive_clean',
      label: 'Clean Long Drive',
      description: 'Complete a 60+ minute trip with no risky events.',
      category: 'Endurance',
      earned: cleanLongTrips >= 1,
      current: Math.min(1, cleanLongTrips),
      target: 1,
      unit: 'trip',
    },
    {
      id: 'night_owl',
      label: 'Night Owl',
      description: 'Complete 5 night drives.',
      category: 'Conditions',
      earned: completed.filter((trip) => trip.night_driving).length >= 5,
      current: Math.min(5, nightCount),
      target: 5,
      unit: 'drives',
    },
    {
      id: 'feather_foot',
      label: 'Feather Foot',
      description: '100% smooth braking ratio on 3 separate trips.',
      category: 'Smoothness',
      earned: smoothBrakeTrips >= 3,
      current: Math.min(3, smoothBrakeTrips),
      target: 3,
      unit: 'trips',
    },
    {
      id: 'defensive_driver',
      label: 'Defensive Driver',
      description: 'Score defensive or higher on 10 consecutive trips.',
      category: 'Safety',
      earned: defensiveStreak,
      current: defensiveStreak ? 10 : Math.min(10, lastTenDefensive.filter((trip) => ['defensive', 'exemplary'].includes(trip.defensive_grade)).length),
      target: 10,
      unit: 'trips',
    },
    {
      id: 'distraction_free',
      label: 'Distraction-Free',
      description: 'Complete 20 trips with Usage Access enabled and no confirmed phone use.',
      category: 'Focus',
      earned: distractionFreeTrips >= 20,
      current: Math.min(20, distractionFreeTrips),
      target: 20,
      unit: 'trips',
    },
    {
      id: 'tree_planter',
      label: 'Tree Planter',
      description: 'Save at least one tree-year of estimated CO2 versus the baseline.',
      category: 'Eco',
      earned: carbon.total_co2_saved_kg >= 21,
      current: Math.min(21, Math.round(carbon.total_co2_saved_kg)),
      target: 21,
      unit: 'kg CO2',
    },
    {
      id: 'green_fleet',
      label: 'Green Fleet',
      description: 'Save five tree-years of estimated CO2 versus the baseline.',
      category: 'Eco',
      earned: carbon.total_co2_saved_kg >= 105,
      current: Math.min(105, Math.round(carbon.total_co2_saved_kg)),
      target: 105,
      unit: 'kg CO2',
    },
    {
      id: 'climate_champion',
      label: 'Climate Champion',
      description: 'Reach the Climate Champion carbon grade.',
      category: 'Eco',
      earned: carbon.carbon_grade === 'Climate Champion',
      current: carbon.carbon_grade === 'Climate Champion' ? 1 : 0,
      target: 1,
    },
    {
      id: 'cruise_master',
      label: 'Cruise Master',
      description: 'Achieve excellent cruise band on 5 highway trips.',
      category: 'Eco',
      earned: cruiseMasterTrips >= 5,
      current: Math.min(5, cruiseMasterTrips),
      target: 5,
      unit: 'trips',
    },
    {
      id: 'manoeuvre_alert_free',
      label: 'Clear Path',
      description: 'Complete 25 trips with zero estimated brake-turn manoeuvre alerts.',
      category: 'Safety',
      earned: manoeuvreAlertFreeTrips >= 25,
      current: Math.min(25, manoeuvreAlertFreeTrips),
      target: 25,
      unit: 'trips',
    },
  ];
}
