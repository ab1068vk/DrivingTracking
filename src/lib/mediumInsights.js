import { buildDangerZones } from '@/lib/dangerZoneEngine';

const DAY_MS = 86400000;

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const startOfWeek = (value = new Date()) => {
  const date = startOfDay(value);
  date.setDate(date.getDate() - date.getDay());
  return date;
};

const routeCell = (point) => `${Math.round(Number(point.lat) * 200) / 200},${Math.round(Number(point.lng) * 200) / 200}`;

export function routeKeyForTrip(trip = {}) {
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  if (points.length < 2) return null;
  return `${routeCell(points[0])}|${routeCell(points[points.length - 1])}`;
}

const average = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;

const timeBucketLabel = (dateInput) => {
  const date = new Date(dateInput);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  const minutes = date.getHours() * 60 + date.getMinutes();
  const bucket = Math.round(minutes / 30) * 30;
  const h = Math.floor(bucket / 60) % 24;
  const m = bucket % 60;
  const labelDate = new Date(date);
  labelDate.setHours(h, m, 0, 0);
  return labelDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

const inferRouteLabel = (trips = []) => {
  const hours = trips
    .map((trip) => new Date(trip.start_time).getHours())
    .filter((hour) => Number.isFinite(hour));
  const avgHour = average(hours) ?? 12;
  const weekdays = trips.filter((trip) => {
    const day = new Date(trip.start_time).getDay();
    return day >= 1 && day <= 5;
  }).length;
  const avgDistance = average(trips.map((trip) => Number(trip.distance_km) || 0)) ?? 0;

  if (weekdays / Math.max(1, trips.length) >= 0.65 && avgHour >= 5 && avgHour < 11) return 'Morning commute';
  if (weekdays / Math.max(1, trips.length) >= 0.65 && avgHour >= 15 && avgHour < 20) return 'Evening commute';
  if (avgDistance <= 8 && avgHour >= 16 && avgHour <= 22) return 'Gym route';
  if (avgDistance <= 10) return 'Errand route';
  return 'Repeated route';
};

export function buildRouteComparisons(trips = []) {
  const groups = new Map();
  trips
    .filter((trip) => trip.status === 'completed')
    .forEach((trip) => {
      const key = routeKeyForTrip(trip);
      if (!key) return;
      const group = groups.get(key) || [];
      group.push(trip);
      groups.set(key, group);
    });

  return [...groups.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([routeKey, group]) => {
      const sorted = [...group].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
      const scores = sorted.map((trip) => Number(trip.score_overall)).filter(Number.isFinite);
      const distanceValues = sorted.map((trip) => Number(trip.distance_km) || 0);
      const durationValues = sorted.map((trip) => Number(trip.duration_seconds) || 0);
      const byWindow = new Map();
      sorted.forEach((trip) => {
        const label = timeBucketLabel(trip.start_time);
        const current = byWindow.get(label) || [];
        current.push(Number(trip.score_overall) || 0);
        byWindow.set(label, current);
      });
      const bestWindow = [...byWindow.entries()]
        .map(([label, values]) => ({ label, avg: average(values) || 0, count: values.length }))
        .sort((a, b) => b.avg - a.avg || b.count - a.count)[0] || null;
      const recent = sorted.slice(-3);
      const firstAvg = average(sorted.slice(0, Math.min(3, sorted.length)).map((trip) => Number(trip.score_overall) || 0)) || 0;
      const recentAvg = average(recent.map((trip) => Number(trip.score_overall) || 0)) || 0;
      return {
        route_key: routeKey,
        label: inferRouteLabel(sorted),
        trip_count: sorted.length,
        avg_score: Math.round(average(scores) || 0),
        best_score: Math.max(...scores, 0),
        worst_score: Math.min(...scores, 100),
        avg_distance_km: Math.round((average(distanceValues) || 0) * 10) / 10,
        avg_duration_minutes: Math.round((average(durationValues) || 0) / 60),
        safest_time: bestWindow?.label || 'More trips needed',
        safest_time_score: bestWindow ? Math.round(bestWindow.avg) : null,
        trend: recentAvg > firstAvg + 3 ? 'improving' : recentAvg < firstAvg - 3 ? 'declining' : 'stable',
        last_trip_id: sorted[sorted.length - 1]?.id,
      };
    })
    .sort((a, b) => b.trip_count - a.trip_count || b.avg_score - a.avg_score);
}

export function buildTripCalendarMonth(trips = [], monthDate = new Date()) {
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const firstGridDay = startOfDay(monthStart);
  firstGridDay.setDate(firstGridDay.getDate() - firstGridDay.getDay());
  const days = [];
  const completed = trips.filter((trip) => trip.status === 'completed');

  for (let i = 0; i < 42; i++) {
    const date = new Date(firstGridDay.getTime() + i * DAY_MS);
    const dayTrips = completed.filter((trip) => startOfDay(trip.start_time).getTime() === date.getTime());
    const scores = dayTrips.map((trip) => Number(trip.score_overall)).filter(Number.isFinite);
    days.push({
      key: date.toISOString().slice(0, 10),
      date,
      inMonth: date.getMonth() === monthStart.getMonth(),
      trip_count: dayTrips.length,
      distance_km: Math.round(dayTrips.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0) * 10) / 10,
      avg_score: scores.length ? Math.round(average(scores)) : null,
      best_score: scores.length ? Math.max(...scores) : null,
      worst_score: scores.length ? Math.min(...scores) : null,
    });
  }

  const monthDays = days.filter((day) => day.inMonth);
  const driveDays = monthDays.filter((day) => day.trip_count > 0);
  let currentStreak = 0;
  let bestStreak = 0;
  monthDays.forEach((day) => {
    if (day.trip_count > 0) {
      currentStreak += 1;
      bestStreak = Math.max(bestStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  });

  return {
    label: monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    days,
    drive_days: driveDays.length,
    total_distance_km: Math.round(driveDays.reduce((sum, day) => sum + day.distance_km, 0) * 10) / 10,
    best_day: driveDays.sort((a, b) => (b.avg_score || 0) - (a.avg_score || 0))[0] || null,
    worst_day: driveDays.sort((a, b) => (a.avg_score || 100) - (b.avg_score || 100))[0] || null,
    best_streak_days: bestStreak,
  };
}

export function buildWeeklyDriverSummary(trips = [], settings = {}) {
  const weekStart = startOfWeek();
  const completed = trips.filter((trip) => (
    trip.status === 'completed' &&
    new Date(trip.start_time).getTime() >= weekStart.getTime()
  ));
  const previousStart = new Date(weekStart.getTime() - 7 * DAY_MS);
  const previous = trips.filter((trip) => {
    const time = new Date(trip.start_time).getTime();
    return trip.status === 'completed' && time >= previousStart.getTime() && time < weekStart.getTime();
  });
  const totalDistance = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const byDay = new Map();
  completed.forEach((trip) => {
    const key = new Date(trip.start_time).toLocaleDateString(undefined, { weekday: 'long' });
    const current = byDay.get(key) || [];
    current.push(trip);
    byDay.set(key, current);
  });
  const dayScores = [...byDay.entries()].map(([day, dayTrips]) => ({
    day,
    avg_score: Math.round(average(dayTrips.map((trip) => Number(trip.score_overall) || 0)) || 0),
  }));
  const bestDay = dayScores.sort((a, b) => b.avg_score - a.avg_score)[0]?.day || 'More trips needed';
  const issueCounts = {
    'late braking': completed.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0),
    'sharp turns': completed.reduce((sum, trip) => sum + (trip.sharp_turns_count || 0), 0),
    speeding: completed.reduce((sum, trip) => sum + (trip.speeding_events_count || 0), 0),
    acceleration: completed.reduce((sum, trip) => sum + (trip.rapid_accel_count || 0), 0),
  };
  const mainIssue = Object.entries(issueCounts).sort((a, b) => b[1] - a[1])[0];
  const avgFor = (items, field) => average(items.map((trip) => Number(trip[field])).filter(Number.isFinite));
  const improvements = [
    { label: 'smoother turns', delta: (avgFor(completed, 'cornering_consistency_score') ?? 0) - (avgFor(previous, 'cornering_consistency_score') ?? 0) },
    { label: 'better braking', delta: (avgFor(completed, 'braking_efficiency_score') ?? 0) - (avgFor(previous, 'braking_efficiency_score') ?? 0) },
    { label: 'steadier speed', delta: (avgFor(completed, 'svi_score') ?? 0) - (avgFor(previous, 'svi_score') ?? 0) },
    { label: 'higher safety score', delta: (avgFor(completed, 'score_safety') ?? 0) - (avgFor(previous, 'score_safety') ?? 0) },
  ].sort((a, b) => b.delta - a.delta);

  return {
    trip_count: completed.length,
    distance_km: Math.round(totalDistance * 10) / 10,
    best_day: bestDay,
    main_issue: mainIssue?.[1] > 0 ? mainIssue[0] : 'no major risk pattern',
    biggest_improvement: improvements[0]?.delta > 0 ? improvements[0].label : 'more trips needed',
    avg_score: completed.length ? Math.round(average(completed.map((trip) => Number(trip.score_overall) || 0))) : null,
    night_distance_km: Math.round(completed.filter((trip) => trip.night_driving).reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0) * 10) / 10,
    goals: buildGoalStatus(completed, settings),
  };
}

export function buildGoalStatus(weekTrips = [], settings = {}) {
  const harshBrakes = weekTrips.reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0);
  const avgScore = weekTrips.length
    ? Math.round(average(weekTrips.map((trip) => Number(trip.score_overall) || 0)))
    : 0;
  const nightKm = weekTrips
    .filter((trip) => trip.night_driving)
    .reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const harshBrakeTarget = Number(settings.weekly_goal_harsh_brakes ?? 0);
  const minAverageScore = Number(settings.weekly_goal_min_avg_score ?? 85);
  const maxNightKm = Number(settings.weekly_goal_max_night_km ?? 20);
  return [
    {
      id: 'no_harsh_braking',
      label:
        harshBrakeTarget === 0
          ? 'No harsh braking this week'
          : `Keep harsh braking at ${harshBrakeTarget} or less`,
      value: harshBrakes,
      target: harshBrakeTarget,
      met: harshBrakes <= harshBrakeTarget,
      display: `${harshBrakes}/${harshBrakeTarget}`,
    },
    {
      id: 'average_score',
      label: `Keep average score above ${minAverageScore}`,
      value: avgScore,
      target: minAverageScore,
      met: weekTrips.length > 0 && avgScore >= minAverageScore,
      display: weekTrips.length ? `${avgScore}/${minAverageScore}` : 'No trips',
    },
    {
      id: 'night_distance',
      label: `Drive under ${maxNightKm} km at night`,
      value: Math.round(nightKm * 10) / 10,
      target: maxNightKm,
      met: nightKm <= maxNightKm,
      display: `${Math.round(nightKm * 10) / 10}/${maxNightKm} km`,
    },
  ];
}

const roadTypeForTrip = (trip = {}) => {
  if ((trip.parking_stop_duration_seconds || 0) >= 180 || trip.parking_approach_grade === 'rough') return 'parking';
  if (trip.dominant_road_type) return trip.dominant_road_type;
  if (trip.road_type) return trip.road_type;
  if ((trip.avg_running_speed_kmh ?? trip.avg_speed_kmh ?? 0) > 85) return 'highway';
  if ((trip.distance_km || 0) > 25 && (trip.stop_count || 0) <= 2) return 'rural';
  return 'city';
};

export function buildRoadTypeBreakdown(trips = []) {
  const labels = {
    city: 'City',
    urban: 'City',
    highway: 'Highway',
    residential: 'Residential',
    rural: 'Rural',
    parking: 'Parking areas',
    mixed: 'Mixed',
  };
  const groups = new Map();
  trips.filter((trip) => trip.status === 'completed').forEach((trip) => {
    const key = roadTypeForTrip(trip);
    const current = groups.get(key) || [];
    current.push(trip);
    groups.set(key, current);
  });

  return [...groups.entries()].map(([key, group]) => ({
    id: key,
    label: labels[key] || key,
    trip_count: group.length,
    avg_score: Math.round(average(group.map((trip) => Number(trip.score_overall) || 0)) || 0),
    avg_safety: Math.round(average(group.map((trip) => Number(trip.score_safety) || 0)) || 0),
    distance_km: Math.round(group.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0) * 10) / 10,
    risk_events: group.reduce((sum, trip) => sum +
      (trip.harsh_brakes_count || 0) +
      (trip.rapid_accel_count || 0) +
      (trip.sharp_turns_count || 0) +
      (trip.speeding_events_count || 0), 0),
  })).sort((a, b) => b.distance_km - a.distance_km);
}

export function buildRiskHotspots(trips = []) {
  return buildDangerZones(trips, {
    eventTypes: ['harsh_brake', 'near_miss', 'sharp_turn', 'aggressive_overtake', 'speeding'],
    minEvents: 2,
  });
}

export function buildVehicleCostSummary(vehicle = {}, trips = []) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  const totalDistance = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const fuelLiters = completed.reduce((sum, trip) => {
    const lPer100 = Number(vehicle.fuel_efficiency_l_per_100km) || 8.5;
    return sum + ((Number(trip.distance_km) || 0) * lPer100 / 100);
  }, 0);
  const fuelCost = fuelLiters * (Number(vehicle.fuel_price_per_liter) || 1.65);
  const reservePerKm = Number(vehicle.maintenance_reserve_per_km) || 0.08;
  const maintenanceReserve = totalDistance * reservePerKm;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthTrips = completed.filter((trip) => new Date(trip.start_time).getTime() >= monthStart.getTime());
  const monthlyDistance = monthTrips.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const monthlyFuelCost = monthlyDistance * (Number(vehicle.fuel_efficiency_l_per_100km) || 8.5) / 100 * (Number(vehicle.fuel_price_per_liter) || 1.65);
  const monthlyReserve = monthlyDistance * reservePerKm;
  const totalCost = fuelCost + maintenanceReserve;

  return {
    total_distance_km: Math.round(totalDistance * 10) / 10,
    fuel_liters: Math.round(fuelLiters * 10) / 10,
    fuel_cost: Math.round(fuelCost * 100) / 100,
    maintenance_reserve: Math.round(maintenanceReserve * 100) / 100,
    total_cost: Math.round(totalCost * 100) / 100,
    cost_per_km: totalDistance > 0 ? Math.round((totalCost / totalDistance) * 100) / 100 : 0,
    monthly_cost: Math.round((monthlyFuelCost + monthlyReserve) * 100) / 100,
    monthly_distance_km: Math.round(monthlyDistance * 10) / 10,
    maintenance_reserve_per_km: reservePerKm,
  };
}

export function buildMaintenanceReminders(vehicle = {}, trips = []) {
  const odometer = Number(vehicle.odometer_km) + trips.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const items = Array.isArray(vehicle.maintenance_items) ? vehicle.maintenance_items : [];
  const distanceReminders = items.map((item) => {
    const interval = Number(item.interval_km) || 0;
    const last = Number(item.last_service_km) || 0;
    const remaining = last + interval - odometer;
    return {
      id: item.id,
      label: item.label,
      type: 'distance',
      remaining_km: Math.round(remaining),
      status: remaining <= 0 ? 'due' : remaining <= Math.max(500, interval * 0.1) ? 'soon' : 'ok',
    };
  });
  const dateItems = [
    { id: 'registration', label: 'Registration renewal', date: vehicle.registration_renewal_date },
    { id: 'insurance', label: 'Insurance renewal', date: vehicle.insurance_renewal_date },
  ].filter((item) => item.date);
  const dateReminders = dateItems.map((item) => {
    const days = Math.ceil((new Date(item.date).getTime() - Date.now()) / DAY_MS);
    return {
      ...item,
      type: 'date',
      remaining_days: days,
      status: days <= 0 ? 'due' : days <= 30 ? 'soon' : 'ok',
    };
  });
  return [...distanceReminders, ...dateReminders].sort((a, b) => {
    const severity = { due: 0, soon: 1, ok: 2 };
    return severity[a.status] - severity[b.status];
  });
}
