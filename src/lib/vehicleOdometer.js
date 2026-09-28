/**
 * DPD-035 — the vehicle odometer's one authority.
 *
 * The odometer is physical state: the owner's last reading plus the driving the
 * app has credited since. It used to be topped up from the Vehicles page's
 * bounded "latest 100 trips" window (`base + window sum − previous window sum`),
 * so once a fleet had more than 100 trips each new drive only added
 * (new trip − trip leaving the window): 300 km of driving over a 5,000-trip
 * history moved the odometer 33 km. A bounded display window must not own a
 * lifetime physical calculation.
 *
 * The rule now: a vehicle credits each of its completed trips exactly once, when
 * the trip started after the vehicle's sync point. The sync point only moves
 * forward, so older history — an import, a restore of past trips, a reassignment
 * of an old trip — never moves the odometer, which is what the window happened to
 * guarantee for imports and is kept on purpose. A deleted or edited trip keeps
 * the credit it already gave: the car still drove it.
 *
 * Fields on the vehicle record:
 * - `odometer_km`: the last reading (owner-entered, or the value frozen at
 *   migration); the sync never rewrites it.
 * - `odometer_credited_km_since_reading`: driving credited after that reading.
 * - `odometer_synced_through`: ISO start time; this vehicle's completed trips that
 *   started later are not credited yet.
 * - `odometer_credited_trips`: the most recent credits `{ id, km }`, kept so a
 *   reassigned trip moves its credit instead of counting twice.
 * - `odometer_basis`: `ODOMETER_BASIS` once the vehicle is on this rule. Without it
 *   the vehicle still reads the legacy window formula, unchanged, until its first
 *   sync migrates it — so upgrading never moves a displayed odometer.
 */

export const ODOMETER_BASIS = 'trip_credit_v1';
/** Credits remembered per vehicle for reassignment transfers. */
export const ODOMETER_CREDIT_RETENTION = 200;
/** Extra Q1 pages one sync may read to reach the oldest sync point. */
export const ODOMETER_SYNC_MAX_EXTRA_PAGES = 20;

const km = (value) => Math.max(0, Number(value) || 0);
const startMs = (trip) => {
  const ms = Date.parse(trip?.start_time ?? '');
  return Number.isFinite(ms) ? ms : null;
};
const isoOrNull = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export function tripBelongsToVehicle(trip, vehicle) {
  if (!vehicle?.id || trip?.status !== 'completed') return false;
  return String(trip.vehicle_id) === String(vehicle.id) || Boolean(vehicle.is_default && !trip.vehicle_id);
}

export function isOdometerMigrated(vehicle) {
  return vehicle?.odometer_basis === ODOMETER_BASIS;
}

/** The pre-DPD-035 display value, kept only to migrate without a jump. */
export function legacyOdometerKm(vehicle, trips = []) {
  const windowKm = trips
    .filter((trip) => tripBelongsToVehicle(trip, vehicle))
    .reduce((sum, trip) => sum + km(trip.distance_km), 0);
  const anchorKm = Number(vehicle?.odometer_trip_distance_anchor_km) || 0;
  return Math.round((Number(vehicle?.odometer_km) || 0) + Math.max(0, windowKm - anchorKm));
}

const creditedIds = (vehicle) => new Set(
  (Array.isArray(vehicle?.odometer_credited_trips) ? vehicle.odometer_credited_trips : [])
    .map((entry) => String(entry?.id)),
);

/** Trip ids already credited by any vehicle other than `vehicle`. */
export function creditedElsewhereFor(vehicle, vehicles = []) {
  const ids = new Set();
  vehicles.forEach((other) => {
    if (String(other?.id) === String(vehicle?.id)) return;
    creditedIds(other).forEach((id) => ids.add(id));
  });
  return ids;
}

/**
 * A trip this vehicle has not credited yet: completed, its own, started after the
 * sync point, and not credited here or on another vehicle.
 */
const pendingFor = (vehicle, trips, creditedElsewhere) => {
  const syncedMs = Date.parse(vehicle?.odometer_synced_through ?? '');
  const own = creditedIds(vehicle);
  return trips.filter((trip) => (
    tripBelongsToVehicle(trip, vehicle)
    && Number.isFinite(syncedMs) && startMs(trip) != null && startMs(trip) > syncedMs
    && !own.has(String(trip.id))
    && !creditedElsewhere?.has(String(trip.id))
  ));
};

/**
 * The odometer to show and to measure maintenance on. For a migrated vehicle the
 * trips passed in only add driving not yet credited, so a bounded list can make
 * the value a floor but never counts a trip twice.
 */
export function getVehicleOdometerKm(vehicle, trips = [], { creditedElsewhere = null } = {}) {
  if (!isOdometerMigrated(vehicle)) return legacyOdometerKm(vehicle, trips);
  const pendingKm = pendingFor(vehicle, trips, creditedElsewhere).reduce((sum, trip) => sum + km(trip.distance_km), 0);
  return Math.round(
    (Number(vehicle.odometer_km) || 0) + km(vehicle.odometer_credited_km_since_reading) + pendingKm,
  );
}

/**
 * Fields for a new vehicle, or for an edit whose odometer differs from what the
 * owner was shown: the typed value is a fresh reading that already includes all
 * driving until now. An edit that leaves the odometer alone changes none of them.
 */
export function odometerReadingPatch({ previousDisplayedKm = null, nextKm, now = new Date() } = {}) {
  const reading = Math.max(0, Math.round(Number(nextKm) || 0));
  if (previousDisplayedKm != null && reading === Math.round(Number(previousDisplayedKm) || 0)) return null;
  return {
    odometer_km: reading,
    odometer_basis: ODOMETER_BASIS,
    odometer_credited_km_since_reading: 0,
    odometer_synced_through: now.toISOString(),
    odometer_credited_trips: [],
  };
}

const ODOMETER_OWNED_FIELDS = [
  'odometer_km', 'odometer_basis', 'odometer_credited_km_since_reading', 'odometer_synced_through',
  'odometer_credited_trips', 'odometer_trip_distance_anchor_km', 'auto_odometer_last_sync_at',
];

/**
 * A vehicle form's save data with the odometer handled as a reading. The form
 * shows the displayed odometer; if the owner changed it the typed value becomes
 * the new reading, otherwise every odometer-owned field is dropped from the
 * write so an unrelated edit (a rename) can never rewind or re-anchor it.
 * `previousDisplayedKm` is `null` for a new vehicle.
 */
export function applyOdometerReading(formData = {}, previousDisplayedKm = null, now = new Date()) {
  const reading = odometerReadingPatch({ previousDisplayedKm, nextKm: formData.odometer_km, now });
  if (reading) return { ...formData, ...reading };
  const rest = { ...formData };
  ODOMETER_OWNED_FIELDS.forEach((field) => { delete rest[field]; });
  return rest;
}

/** Newest start time among the rows, or `null`. */
export function newestStartIso(rows = []) {
  const newest = rows.reduce((max, trip) => Math.max(max, startMs(trip) ?? -Infinity), -Infinity);
  return isoOrNull(newest);
}

/**
 * Whether the rows (newest first) reach back to every migrated vehicle's sync
 * point. When they do not and more history exists, trips between the sync point
 * and the oldest row may be uncredited, so the caller reads another page.
 */
export function rowsCoverSyncPoints(vehicles = [], rows = []) {
  const oldest = rows.reduce((min, trip) => Math.min(min, startMs(trip) ?? Infinity), Infinity);
  if (!Number.isFinite(oldest)) return true;
  return vehicles.every((vehicle) => {
    if (!isOdometerMigrated(vehicle)) return true;
    const synced = Date.parse(vehicle.odometer_synced_through ?? '');
    return !Number.isFinite(synced) || synced >= oldest;
  });
}

/**
 * One sync over the fleet. `windowRows` is the page the legacy display read (for
 * the no-jump migration); `rows` is every row the sync walked (newest first,
 * reaching back to the sync points when possible). Returns `{ id, patch }` per
 * vehicle that must be written — nothing for a vehicle whose state already holds.
 * Every patch carries absolute values from the vehicle's own snapshot, so running
 * the same plan twice writes the same record.
 */
export function planOdometerSync(vehicles = [], { windowRows = [], rows = windowRows, now = new Date() } = {}) {
  const patches = new Map();
  const state = new Map(vehicles.map((vehicle) => [String(vehicle.id), {
    creditedKm: km(vehicle.odometer_credited_km_since_reading),
    credits: Array.isArray(vehicle.odometer_credited_trips) ? [...vehicle.odometer_credited_trips] : [],
    touched: false,
  }]));
  const coveredThrough = newestStartIso(rows) || now.toISOString();

  // Migration first: freeze the value the legacy display showed.
  vehicles.forEach((vehicle) => {
    if (isOdometerMigrated(vehicle)) return;
    patches.set(String(vehicle.id), {
      odometer_km: legacyOdometerKm(vehicle, windowRows),
      odometer_basis: ODOMETER_BASIS,
      odometer_credited_km_since_reading: 0,
      odometer_synced_through: newestStartIso(windowRows) || now.toISOString(),
      odometer_credited_trips: [],
      auto_odometer_last_sync_at: now.toISOString(),
    });
  });

  // A credited trip that now belongs to another vehicle moves its credit there.
  const byTripId = new Map(rows.map((trip) => [String(trip.id), trip]));
  vehicles.forEach((vehicle) => {
    if (!isOdometerMigrated(vehicle)) return;
    const own = state.get(String(vehicle.id));
    own.credits = own.credits.filter((entry) => {
      const trip = byTripId.get(String(entry?.id));
      if (!trip || trip.status !== 'completed' || tripBelongsToVehicle(trip, vehicle)) return true;
      const receiver = vehicles.find((other) => isOdometerMigrated(other) && tripBelongsToVehicle(trip, other));
      if (!receiver) return true;
      const target = state.get(String(receiver.id));
      own.creditedKm = Math.max(0, own.creditedKm - km(entry.km));
      target.creditedKm += km(entry.km);
      target.credits.push({ id: String(trip.id), km: km(entry.km) });
      own.touched = true;
      target.touched = true;
      return false;
    });
  });

  vehicles.forEach((vehicle) => {
    if (!isOdometerMigrated(vehicle)) return;
    const own = state.get(String(vehicle.id));
    const elsewhere = new Set();
    state.forEach((other, id) => {
      if (id !== String(vehicle.id)) other.credits.forEach((entry) => elsewhere.add(String(entry.id)));
    });
    const fresh = pendingFor({ ...vehicle, odometer_credited_trips: own.credits }, rows, elsewhere);
    fresh.forEach((trip) => {
      own.creditedKm += km(trip.distance_km);
      own.credits.push({ id: String(trip.id), km: km(trip.distance_km) });
    });
    const syncedMs = Date.parse(vehicle.odometer_synced_through ?? '');
    const advance = !Number.isFinite(syncedMs) || Date.parse(coveredThrough) > syncedMs;
    if (!fresh.length && !own.touched && !advance) return;
    patches.set(String(vehicle.id), {
      odometer_credited_km_since_reading: Math.round(own.creditedKm * 1000) / 1000,
      odometer_credited_trips: own.credits.slice(-ODOMETER_CREDIT_RETENTION),
      odometer_synced_through: advance ? coveredThrough : vehicle.odometer_synced_through,
      ...(fresh.length || own.touched ? { auto_odometer_last_sync_at: now.toISOString() } : {}),
    });
  });

  return [...patches].map(([id, patch]) => ({ id, patch }));
}
