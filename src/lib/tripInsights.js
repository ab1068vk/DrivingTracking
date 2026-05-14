export const DEFAULT_FUEL_PRICE_PER_LITER = 1.65;
export const DEFAULT_L_PER_100KM = 8.5;
export const GASOLINE_CO2_KG_PER_LITER = 2.31;
export const WEAR_KM_PER_STRESS_UNIT = 8;

export const STRESS_UNITS = {
  harsh_brake: { low: 1.5, medium: 4, high: 8 },
  rapid_acceleration: { low: 1, medium: 3, high: 6 },
  sharp_turn: { low: 0.5, medium: 2, high: 4 },
  tailgate_cycle: { low: 1, medium: 3, high: 5 },
  lane_change: { low: 0.5, medium: 1.5, high: 3 },
};

export const DEFAULT_MAINTENANCE_ITEMS = [
  { id: 'oil', label: 'Oil change', interval_km: 8000, last_service_km: 0 },
  { id: 'tires', label: 'Tire rotation', interval_km: 10000, last_service_km: 0 },
  { id: 'inspection', label: 'Inspection', interval_km: 20000, last_service_km: 0 },
];

const DAY_MS = 86400000;

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
  return Math.round((Number(vehicle?.odometer_km) || 0) + getVehicleTripDistanceKm(vehicle, trips));
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

export function estimateTripEconomics(trip, vehicle = {}, settings = {}) {
  const distanceKm = Number(trip?.distance_km) || 0;
  const lPer100Km = Number(vehicle?.fuel_efficiency_l_per_100km) || Number(settings.default_l_per_100km) || DEFAULT_L_PER_100KM;
  const fuelPrice = Number(vehicle?.fuel_price_per_liter) || Number(settings.default_fuel_price_per_liter) || DEFAULT_FUEL_PRICE_PER_LITER;
  const ecoDrivingScore = Number.isFinite(Number(trip?.eco_driving_score)) ? Number(trip.eco_driving_score) : 50;
  const efficiencyMultiplier = Math.max(0.6, 1 + (ecoDrivingScore - 50) / 500);
  const actualLPer100Km = lPer100Km / efficiencyMultiplier;
  const liters = distanceKm * lPer100Km / 100;
  const actualLiters = distanceKm * actualLPer100Km / 100;
  const cost = liters * fuelPrice;
  const co2Kg = actualLiters * GASOLINE_CO2_KG_PER_LITER;
  const fuelSavedLiters = Math.max(0, liters - actualLiters);

  return {
    liters: Math.round(actualLiters * 100) / 100,
    baseline_liters: Math.round(liters * 100) / 100,
    cost: Math.round(actualLiters * fuelPrice * 100) / 100,
    baseline_cost: Math.round(cost * 100) / 100,
    co2_kg: Math.round(co2Kg * 100) / 100,
    l_per_100km: lPer100Km,
    actual_l_per_100km: Math.round(actualLPer100Km * 10) / 10,
    fuel_saved_liters: Math.round(fuelSavedLiters * 100) / 100,
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
  const rushHour = (hour >= 6 && hour <= 9) || (hour >= 16 && hour <= 19);

  if (weekday && rushHour && durationMin >= 10 && durationMin <= 90 && distanceKm >= 5 && distanceKm <= 80) {
    return { auto_tag: 'work', auto_tag_confidence: 'high' };
  }
  if (weekday && hour >= 6 && hour <= 18 && durationMin >= 15) {
    return { auto_tag: 'work', auto_tag_confidence: 'medium' };
  }
  if (durationMin < 20 && distanceKm < 10) {
    return { auto_tag: 'errands', auto_tag_confidence: 'medium' };
  }
  if (weekend && hour >= 9 && hour <= 17 && distanceKm < 20) {
    return { auto_tag: 'errands', auto_tag_confidence: 'medium' };
  }
  if ((hour >= 20 || hour <= 1) && dow >= 4 && dow <= 6) {
    return { auto_tag: 'personal', auto_tag_confidence: 'medium' };
  }
  return { auto_tag: 'personal', auto_tag_confidence: 'low' };
}

export function buildScoreTips(trips = []) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  if (!completed.length) {
    return ['Record a few trips to unlock personalized coaching tips.'];
  }

  const totals = {
    harsh_brake: completed.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0),
    rapid_acceleration: completed.reduce((sum, trip) => sum + (trip.rapid_accel_count || 0), 0),
    sharp_turn: completed.reduce((sum, trip) => sum + (trip.sharp_turns_count || 0), 0),
    speeding: completed.reduce((sum, trip) => sum + (trip.speeding_events_count || 0), 0),
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

  const nightTrips = completed.filter((trip) => trip.night_driving).length;
  if (nightTrips / completed.length >= 0.35) {
    tips.push('A large share of trips happen at night, where DriveSense applies extra safety risk. Keep routes familiar and take breaks on longer drives.');
  }

  const avgScore = completed.reduce((sum, trip) => sum + (trip.score_overall || 0), 0) / completed.length;
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
  const scoreCount = weekTrips.filter((trip) => trip.score_overall > 0).length;
  const avgScore = scoreCount
    ? Math.round(weekTrips.reduce((sum, trip) => sum + (trip.score_overall || 0), 0) / scoreCount)
    : 0;

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
      met: scoreCount > 0 && avgScore >= Number(settings.weekly_goal_min_avg_score ?? 80),
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
    { id: 'night', label: 'Night', range: '10p-5a', from: 22, to: 29 },
  ];

  return buckets.map((bucket) => {
    const bucketTrips = trips.filter((trip) => {
      if (trip.status !== 'completed') return false;
      const hour = new Date(trip.start_time).getHours();
      const normalized = hour < 5 ? hour + 24 : hour;
      return normalized >= bucket.from && normalized < bucket.to;
    });
    const scoreCount = bucketTrips.filter((trip) => trip.score_overall > 0).length;
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
      avgScore: scoreCount
        ? Math.round(bucketTrips.reduce((sum, trip) => sum + (trip.score_overall || 0), 0) / scoreCount)
        : null,
      events,
    };
  });
}

export function analyzeDayOfWeek(trips = []) {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return labels.map((label, index) => {
    const dayTrips = trips.filter((trip) => trip.status === 'completed' && new Date(trip.start_time).getDay() === index);
    const scoreCount = dayTrips.filter((trip) => trip.score_overall > 0).length;
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
      avgScore: scoreCount ? Math.round(dayTrips.reduce((sum, trip) => sum + (trip.score_overall || 0), 0) / scoreCount) : null,
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
    lane_changes: completed.reduce((sum, trip) => sum + (trip.lane_changes_count || 0), 0),
    tailgate_cycles: completed.reduce((sum, trip) => sum + (trip.tailgate_cycle_count || 0), 0),
    erratic_speed: completed.reduce((sum, trip) => sum + (trip.distraction_events_count || 0), 0),
  };
  const totalEvents = Object.values(totals).reduce((sum, count) => sum + count, 0);
  const per100Km = distanceKm > 0 ? Math.round((totalEvents / distanceKm) * 1000) / 10 : 0;
  const worst = Object.entries(totals).sort((a, b) => b[1] - a[1])[0] || ['none', 0];

  return {
    distance_km: Math.round(distanceKm * 10) / 10,
    total_events: totalEvents,
    events_per_100km: per100Km,
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
  const week = Math.ceil((((date - yearStart) / DAY_MS) + 1) / 7);
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function computePersonalBaseline(completedTrips = []) {
  const completed = [...completedTrips]
    .filter((trip) => trip.status === 'completed' && Number(trip.score_overall) > 0)
    .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
  const avg = (items) => items.length
    ? Math.round(items.reduce((sum, trip) => sum + (Number(trip.score_overall) || 0), 0) / items.length)
    : null;

  const now = new Date();
  const fourWeeksAgo = new Date(now.getTime() - 28 * DAY_MS);
  const weekStart = startOfWeek(now);
  const baselineTrips = completed.filter((trip) => new Date(trip.start_time) >= fourWeeksAgo);
  const thisWeekTrips = completed.filter((trip) => new Date(trip.start_time) >= weekStart);
  const baselineAvg = baselineTrips.length >= 3 ? avg(baselineTrips) : null;
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
    this_week_avg: thisWeekAvg,
    delta,
    trend,
    percentile: Math.round(percentileValue),
    personal_best_week_avg: weeklyAverages.length ? Math.max(...weeklyAverages) : null,
    personal_best_trip_score: completed.length ? Math.max(...completed.map((trip) => Number(trip.score_overall) || 0)) : null,
    weeks_analyzed: weeklyAverages.length,
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

  return {
    total_stress_units: Math.round(totalStressUnits * 10) / 10,
    extra_wear_km: Math.round(totalStressUnits * WEAR_KM_PER_STRESS_UNIT),
    aggressive_ratio: Math.round(aggressiveRatio * 100),
    adjusted_oil_change_km: aggressiveRatio > 0.3 ? Math.round(oilBase * 0.85) : oilBase,
    adjusted_tire_rotation_km: aggressiveRatio > 0.3 ? Math.round(tireBase * 0.80) : tireBase,
    health_grade: totalStressUnits < 50 ? 'A' : totalStressUnits < 150 ? 'B' : totalStressUnits < 300 ? 'C' : 'D',
  };
}

export function calculateSpeedDiscipline(trips = [], settings = {}) {
  const speedLimit = Number(settings.threshold_speeding_kmh || 130);
  const warnLimit = speedLimit + Number(settings.threshold_speed_over_kmh ?? 10);
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
    max_speed_kmh: Math.round(speeds[speeds.length - 1]),
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

export function calculateDrivingConsistency(trips = []) {
  const scores = trips
    .filter((trip) => trip.status === 'completed' && Number(trip.score_overall) > 0)
    .map((trip) => Number(trip.score_overall))
    .sort((a, b) => a - b);

  if (scores.length < 3) {
    return {
      trip_count: scores.length,
      avg_score: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
      score_variation: null,
      consistency_score: null,
      iqr: null,
      q1: null,
      q3: null,
      level: 'unknown',
    };
  }

  const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const q1 = percentile(scores, 25);
  const q3 = percentile(scores, 75);
  const iqr = q3 - q1;
  const consistencyScore = Math.max(0, Math.round(100 - iqr * 1.8));

  return {
    trip_count: scores.length,
    avg_score: Math.round(avg),
    score_variation: Math.round(iqr),
    consistency_score: consistencyScore,
    iqr: Math.round(iqr * 10) / 10,
    q1: Math.round(q1 * 10) / 10,
    q3: Math.round(q3 * 10) / 10,
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
  const timeOfDay = analyzeTimeOfDay(completed);
  const bestWindow = timeOfDay
    .filter((bucket) => bucket.trips > 0 && bucket.avgScore !== null)
    .sort((a, b) => b.avgScore - a.avgScore || a.events - b.events)[0] || null;

  const eventLabels = {
    harsh_brakes: 'braking',
    rapid_accel: 'acceleration',
    sharp_turns: 'cornering',
    speeding: 'speed control',
    lane_changes: 'lane discipline',
    tailgate_cycles: 'following distance',
    erratic_speed: 'distraction risk',
  };
  const focusArea = riskRate.worst_event_count > 0
    ? eventLabels[riskRate.worst_event]
    : speed.level === 'needs_attention'
      ? 'speed control'
      : fatigue.level === 'high'
        ? 'fatigue breaks'
        : 'consistency';

  const actions = [];
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
  if ((riskRate.totals.tailgate_cycles || 0) > 0) {
    actions.push('Open the gap on highway segments and start easing off before traffic compresses.');
  }
  if ((riskRate.totals.lane_changes || 0) > 0) {
    actions.push('Hold lane position longer at highway speed and plan exits earlier.');
  }
  if ((riskRate.totals.erratic_speed || 0) > 0) {
    actions.push('On city routes, keep a steadier throttle through low-speed stretches.');
  }
  if (baseline.trend === 'improving') {
    actions.push(`This week is ${baseline.delta} points above your 4-week baseline. Protect that pattern.`);
  }
  if (bestWindow) {
    actions.push(`Your strongest driving window is ${bestWindow.label.toLowerCase()}; compare tougher trips against that baseline.`);
  }

  return {
    trip_count: completed.length,
    focus_area: focusArea,
    risk_rate: riskRate,
    speed_discipline: speed,
    consistency,
    fatigue,
    baseline,
    best_window: bestWindow,
    actions: actions.length ? actions.slice(0, 4) : ['Record more trips to build a personalized driving plan.'],
  };
}

export function calculateAchievementBadges(trips = []) {
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
  const recentFiveAvg = recentFive.length
    ? recentFive.reduce((sum, trip) => sum + (trip.score_overall || 0), 0) / recentFive.length
    : 0;
  const avgScore = completed.length
    ? completed.reduce((sum, trip) => sum + (trip.score_overall || 0), 0) / completed.length
    : 0;

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
  ];
}
