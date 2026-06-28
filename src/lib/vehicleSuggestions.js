const DAYPARTS = [
  { id: 'early', label: 'early-day pattern', start: 0, end: 6 },
  { id: 'morning', label: 'morning pattern', start: 6, end: 11 },
  { id: 'midday', label: 'midday pattern', start: 11, end: 16 },
  { id: 'evening', label: 'evening pattern', start: 16, end: 22 },
  { id: 'night', label: 'night pattern', start: 22, end: 24 },
];

const parseTripDate = (trip = {}) => {
  const date = new Date(trip.start_time || trip.end_time || trip.created_at || 0);
  return Number.isNaN(date.getTime()) ? null : date;
};

const tripTimeProfile = (trip = {}) => {
  const date = parseTripDate(trip);
  if (!date) return null;
  const hour = date.getHours();
  const daypart = DAYPARTS.find((item) => hour >= item.start && hour < item.end) || DAYPARTS[0];
  const dayType = [0, 6].includes(date.getDay()) ? 'weekend' : 'weekday';
  return { daypart: daypart.id, daypartLabel: daypart.label, dayType };
};

const assignedTripsFor = (vehicle, trips = []) => trips
  .filter((trip) => (
    trip.status === 'completed' &&
    trip.vehicle_id &&
    trip.vehicle_assignment_status !== 'needs_confirmation' &&
    String(trip.vehicle_id) === String(vehicle.id)
  ))
  .sort((a, b) => (parseTripDate(b)?.getTime() || 0) - (parseTripDate(a)?.getTime() || 0));

const median = (values = []) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const addReason = (reasons, points, label, detail) => {
  if (points <= 0) return;
  reasons.push({ points, label, detail });
};

const scoreVehicleForTrip = (trip, vehicle, allTrips) => {
  const assigned = assignedTripsFor(vehicle, allTrips);
  const reasons = [];
  let score = 0;

  if (trip.route_key) {
    const routeMatches = assigned.filter((item) => item.route_key === trip.route_key).length;
    if (routeMatches > 0) {
      const points = Math.min(58, 42 + routeMatches * 4);
      score += points;
      addReason(reasons, points, 'Route match', `${routeMatches} confirmed trip${routeMatches === 1 ? '' : 's'} used this route.`);
    }
  }

  if (assigned.length > 0) {
    const latest = assigned[0];
    const latestAt = parseTripDate(latest)?.getTime();
    const tripAt = parseTripDate(trip)?.getTime();
    if (latestAt && tripAt) {
      const daysApart = Math.abs(tripAt - latestAt) / 86400000;
      if (daysApart <= 3) {
        const points = Math.max(8, Math.round(18 - daysApart * 3));
        score += points;
        addReason(reasons, points, 'Recent vehicle use', `${vehicle.name || 'This vehicle'} was confirmed within ${Math.max(1, Math.round(daysApart))} day${Math.round(daysApart) === 1 ? '' : 's'}.`);
      }
    }
  }

  const targetTime = tripTimeProfile(trip);
  if (targetTime && assigned.length > 0) {
    const matchingTime = assigned.filter((item) => {
      const profile = tripTimeProfile(item);
      return profile?.daypart === targetTime.daypart && profile?.dayType === targetTime.dayType;
    }).length;
    if (matchingTime > 0) {
      const ratio = matchingTime / assigned.length;
      const points = Math.min(16, Math.round(6 + ratio * 14));
      score += points;
      addReason(reasons, points, 'Schedule pattern', `${matchingTime} confirmed ${targetTime.dayType} ${targetTime.daypartLabel.replace(' pattern', '')} trip${matchingTime === 1 ? '' : 's'} used this vehicle.`);
    }
  }

  const tripDistance = Number(trip.distance_km);
  const vehicleMedianDistance = median(assigned.map((item) => Number(item.distance_km)));
  if (Number.isFinite(tripDistance) && tripDistance > 0 && vehicleMedianDistance > 0) {
    const differenceRatio = Math.abs(tripDistance - vehicleMedianDistance) / vehicleMedianDistance;
    if (differenceRatio <= 0.4) {
      const points = Math.max(3, Math.round(10 - differenceRatio * 12));
      score += points;
      addReason(reasons, points, 'Distance profile', `Trip distance is close to this vehicle's ${vehicleMedianDistance.toFixed(1)} km median.`);
    }
  }

  if (vehicle.is_default) {
    score += assigned.length > 0 ? 6 : 18;
    addReason(
      reasons,
      assigned.length > 0 ? 6 : 18,
      'Default vehicle',
      assigned.length > 0
        ? 'Default vehicle used as a light fallback.'
        : 'No confirmed assignment history yet, so the default vehicle is the best available fallback.'
    );
  }

  return {
    vehicle,
    confidence: Math.max(0, Math.min(98, Math.round(score))),
    reasons: reasons.sort((a, b) => b.points - a.points).slice(0, 3),
    evidenceTripCount: assigned.length,
  };
};

export function suggestVehicleForTrip(trip, vehicles = [], allTrips = []) {
  if (!trip || !vehicles.length) return null;
  const candidates = vehicles
    .map((vehicle) => scoreVehicleForTrip(trip, vehicle, allTrips))
    .sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] || null;
  if (!best || best.confidence <= 0) return null;
  return {
    ...best,
    confidenceLabel: best.confidence >= 75 ? 'high' : best.confidence >= 45 ? 'medium' : 'low',
    alternatives: candidates.slice(1, 3),
  };
}

export function buildVehicleAssignmentSuggestions(trips = [], vehicles = [], allTrips = []) {
  return new Map(
    trips.map((trip) => [String(trip.id), suggestVehicleForTrip(trip, vehicles, allTrips)])
  );
}
