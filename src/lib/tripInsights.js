export const DEFAULT_FUEL_PRICE_PER_LITER = 1.65;
export const DEFAULT_L_PER_100KM = 8.5;
export const GASOLINE_CO2_KG_PER_LITER = 2.31;

export const DEFAULT_MAINTENANCE_ITEMS = [
  { id: 'oil', label: 'Oil change', interval_km: 8000, last_service_km: 0 },
  { id: 'tires', label: 'Tire rotation', interval_km: 10000, last_service_km: 0 },
  { id: 'inspection', label: 'Inspection', interval_km: 20000, last_service_km: 0 },
];

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
  const liters = distanceKm * lPer100Km / 100;
  const cost = liters * fuelPrice;
  const co2Kg = liters * GASOLINE_CO2_KG_PER_LITER;

  return {
    liters: Math.round(liters * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    co2_kg: Math.round(co2Kg * 100) / 100,
    l_per_100km: lPer100Km,
    fuel_price_per_liter: fuelPrice,
  };
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

export function calculateAchievementBadges(trips = []) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  const totalKm = completed.reduce((sum, trip) => sum + (trip.distance_km || 0), 0);
  const cleanTrips = completed.filter((trip) => (
    (trip.harsh_brakes_count || 0) === 0 &&
    (trip.rapid_accel_count || 0) === 0 &&
    (trip.sharp_turns_count || 0) === 0 &&
    (trip.speeding_events_count || 0) === 0
  ));
  const weekAgo = Date.now() - 7 * 86400000;
  const weekTrips = completed.filter((trip) => new Date(trip.start_time).getTime() >= weekAgo);
  const weekHarshBrakes = weekTrips.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0);
  const avgScore = completed.length
    ? completed.reduce((sum, trip) => sum + (trip.score_overall || 0), 0) / completed.length
    : 0;

  return [
    {
      id: 'perfect_trip',
      label: 'Perfect Trip',
      description: 'Complete a 95+ score trip with no risky events.',
      earned: completed.some((trip) => (trip.score_overall || 0) >= 95 && cleanTrips.includes(trip)),
    },
    {
      id: 'clean_week',
      label: 'Clean Week',
      description: 'Finish the last 7 days with no harsh braking.',
      earned: weekTrips.length > 0 && weekHarshBrakes === 0,
    },
    {
      id: 'hundred_km',
      label: '100 km Club',
      description: 'Record 100 km of completed driving.',
      earned: totalKm >= 100,
      progress: Math.min(100, Math.round(totalKm)),
    },
    {
      id: 'smooth_driver',
      label: 'Smooth Driver',
      description: 'Average 85+ over at least 10 trips.',
      earned: completed.length >= 10 && avgScore >= 85,
      progress: Math.min(10, completed.length),
    },
    {
      id: 'night_owl',
      label: 'Night Owl',
      description: 'Complete 5 night drives.',
      earned: completed.filter((trip) => trip.night_driving).length >= 5,
      progress: Math.min(5, completed.filter((trip) => trip.night_driving).length),
    },
  ];
}
