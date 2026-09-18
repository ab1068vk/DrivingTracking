// @ts-check
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tripQueryKeys, tripService } from '@/api/trips';
import { vehicleQueryKeys, vehicleService } from '@/api/vehicles';
import { Car, Plus, Pencil, Trash2, Check, Star, X, Wrench, Fuel, Activity, AlertTriangle, Zap, ClipboardCheck, Route, CalendarClock, TrendingUp, Sparkles } from 'lucide-react';
import VehicleCompare from '@/components/VehicleCompare';
import VehicleMaintenancePanel from '@/components/VehicleMaintenancePanel';
import PremiumVehicleOverview from '@/components/PremiumVehicleOverview';
import PremiumFleetIntelligenceCard from '@/components/PremiumFleetIntelligenceCard';
import { estimateTripEconomics, getVehicleOdometerKm, getVehicleTripDistanceKm } from '@/lib/tripInsights';
import { buildVehicleCostSummary } from '@/lib/mediumInsights';
import { buildVehicleAssignmentSuggestions } from '@/lib/vehicleSuggestions';
import {
  buildVehicleMaintenancePlan,
  DRIVETRAIN_OPTIONS,
  normalizePowertrain,
  POWERTRAIN_OPTIONS,
  TRANSMISSION_OPTIONS,
} from '@/lib/vehicleMaintenance';
import { VEHICLE_MAINTENANCE_DISCLAIMER } from '@/lib/vehicleReferenceCatalog';
import { toast } from '@/components/ui/use-toast';
import { logError } from '@/lib/errorReporting';
import useLocalSettings from '@/hooks/useLocalSettings';
import { useVehicleAnalytics } from '@/hooks/useVehicleAnalytics';
import { formatCurrencyAmount, normalizeCurrencySymbol } from '@/lib/currency';
import { formatDistance, getTripComponentScore } from '@/lib/tripEngine';
import { convertPerDistanceRate, distanceUnitLabel, formatDistanceScope } from '@/lib/unitFormatting';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { PageEmptyState, PageHeader } from '@/components/PageChrome';
import { requestAppConfirm } from '@/lib/appDialog';

const COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#6b7280'];


let odometerSyncFailureCount = 0;
let odometerSyncFailureToastShown = false;
export const MAX_FUEL_PRICE_PER_UNIT = 100;
const FUEL_TYPES = POWERTRAIN_OPTIONS;
const humanizePowertrain = (value) => (
  POWERTRAIN_OPTIONS.find((option) => option.value === normalizePowertrain(value))?.label || 'Unknown'
);

export function validateVehicleForm(form) {
  const errors = [];
  const year = Number(form.year);
  const currentYear = new Date().getFullYear() + 1;
  const odometer = Number(form.odometer_km);
  const fuelType = normalizePowertrain(form.powertrain || form.fuel_type);
  const isElectric = fuelType === 'electric' || fuelType === 'ev';
  const efficiency = Number(form.fuel_efficiency_l_per_100km);
  const evEfficiency = Number(form.ev_efficiency_kwh_per_100km);
  const fuelPrice = Number(form.fuel_price_per_liter);
  const reserve = Number(form.maintenance_reserve_per_km);

  if (!String(form.name || '').trim()) errors.push('Nickname is required.');
  if (form.year && (!Number.isInteger(year) || year < 1900 || year > currentYear)) errors.push(`Year must be between 1900 and ${currentYear}.`);
  if (!Number.isFinite(odometer) || odometer < 0) errors.push('Odometer must be zero or higher.');
  if (!FUEL_TYPES.some((type) => type.value === fuelType)) errors.push('Powertrain is not supported.');
  if (!isElectric && (!Number.isFinite(efficiency) || efficiency < 3 || efficiency > 40)) errors.push('Fuel efficiency must be between 3 and 40 L/100km.');
  if (isElectric && (!Number.isFinite(evEfficiency) || evEfficiency < 5 || evEfficiency > 40)) errors.push('EV efficiency must be between 5 and 40 kWh/100km.');
  if (!Number.isFinite(fuelPrice) || fuelPrice < 0 || fuelPrice > MAX_FUEL_PRICE_PER_UNIT) {
    errors.push(`Fuel price must be between 0 and ${MAX_FUEL_PRICE_PER_UNIT}.`);
  }
  if (!Number.isFinite(reserve) || reserve < 0 || reserve > 5) errors.push('Maintenance reserve must be between 0 and 5 per km.');
  return errors;
}

export function getVehicleFormWarnings(form) {
  const fuelType = normalizePowertrain(form.powertrain || form.fuel_type);
  const efficiency = Number(form.fuel_efficiency_l_per_100km);
  if (!['electric', 'ev'].includes(fuelType) && Number.isFinite(efficiency) && efficiency > 25 && efficiency <= 40) {
    return ['Fuel efficiency above 25 L/100km is unusual. Confirm this value before saving.'];
  }
  return [];
}

export function calculateAverageVehicleScore(trips = []) {
  const scored = trips
    .map((trip) => ({
      score: getTripComponentScore(trip, 'overall').value,
      distance: Number(trip.distance_km) || 0,
    }))
    .filter((trip) => trip.score != null);
  if (!scored.length) return null;
  const totalKm = scored.reduce((sum, trip) => sum + trip.distance, 0);
  return totalKm > 0
    ? Math.round(scored.reduce((sum, trip) => sum + trip.score * trip.distance, 0) / totalKm)
    : null;
}

export function getTripsForVehicle(vehicle, trips = []) {
  if (!vehicle?.id) return [];
  return trips.filter((trip) => (
    trip.status === 'completed' &&
    (
      String(trip.vehicle_id || '') === String(vehicle.id) ||
      (vehicle.is_default && !trip.vehicle_id)
    )
  ));
}

/** One bounded fleet page; the control below adds another turn, not a bigger read. */
export const VEHICLE_PAGE_SIZE = 50;

/** One bounded page of retired profiles; the collection grows with deletions. */
export const RETIRED_PAGE_SIZE = 10;

/** One bounded history turn per user action while looking for affected trips. */
export const VEHICLE_RETIRED_SCAN_PAGE = 100;

/**
 * HPR-003. A count card must not look like a total while more remain.
 *
 * The footer used to carry the "at least" truth on its own, which left the
 * headline figure reading as the whole fleet.
 */
export function fleetCountLabel({ count = 0, hasMore = false } = {}) {
  return hasMore ? `at least ${count}` : String(count);
}

export function getUnassignedCompletedTrips(trips = []) {
  return trips.filter((trip) => trip.status === 'completed' && !trip.vehicle_id);
}

/**
 * HPR-010. A trip whose vehicle profile was retired needs a decision too.
 *
 * `retiredVehicleIds` comes from the retired-profile authority, never from the
 * loaded page: a vehicle outside the current prefix is not deleted, and
 * treating it as such would reassign history that is perfectly well attributed.
 */
export function getTripsNeedingVehicleReview(trips = [], { retiredVehicleIds = null, vehicleStates = null } = {}) {
  // `vehicleStates` is the per-reference answer from the id authority; the
  // retired-id set remains supported for callers that already hold one.
  const isRetiredReference = (id) => {
    const key = String(id);
    if (vehicleStates instanceof Map) return vehicleStates.get(key)?.retired === true;
    if (vehicleStates && typeof vehicleStates === 'object') return vehicleStates[key]?.retired === true;
    return retired.has(key);
  };
  const retired = retiredVehicleIds instanceof Set
    ? retiredVehicleIds
    : new Set((retiredVehicleIds || []).map((id) => String(id)));
  return trips.filter((trip) => (
    trip.status === 'completed' &&
    (
      !trip.vehicle_id ||
      trip.vehicle_assignment_status === 'needs_confirmation' ||
      isRetiredReference(trip.vehicle_id)
    )
  ));
}

/**
 * HPR-010. Bounded discovery of trips that still reference a retired profile.
 *
 * The repair workflow only ever saw the newest history page, so an older
 * retired reference could not be found at all. This walks the existing P7
 * completed-trip pagination **one page per call**, carries its continuation and
 * reports its own completeness, so more history means more bounded turns rather
 * than a foreground scan of everything. A refused cursor is reported as a
 * restart, never as completion.
 *
 * @param {{retiredVehicleIds?: Set<string>, readPage?: Function, cursor?: string|null}} [options]
 */
export async function discoverRetiredReferenceTrips({
  retiredVehicleIds = new Set(),
  readPage,
  cursor = null,
} = {}) {
  if (typeof readPage !== 'function' || !retiredVehicleIds.size) {
    return { trips: [], continuation: null, complete: true, restartRequired: false };
  }
  const page = await readPage({ cursor });
  if (page?.unavailable) {
    return {
      trips: [],
      continuation: null,
      complete: false,
      restartRequired: String(page.unavailable.code || '').startsWith('CURSOR_'),
      unavailable: page.unavailable,
    };
  }
  const rows = Array.isArray(page?.data) ? page.data : [];
  const continuation = page?.continuation ?? null;
  return {
    trips: rows.filter((trip) => (
      trip?.status === 'completed' && retiredVehicleIds.has(String(trip.vehicle_id || ''))
    )),
    continuation,
    complete: !continuation,
    restartRequired: false,
  };
}

/**
 * What a trip's vehicle reference actually resolves to.
 *
 * Four distinct answers, so no surface has to guess: an active vehicle, the
 * default for an unassigned trip, an explicitly retired profile, or `unknown`
 * when the reference simply is not in the collection this caller holds —
 * which is a statement about the caller's page, not about the vehicle.
 */
/**
 * HPR-010. Bounded navigation over the retired collection.
 *
 * The repository pages retired profiles, but the screen requested the first ten
 * and stopped, so profile eleven existed, was disclosed as "more", and could
 * never be loaded — and therefore could never be handed to repair discovery.
 * The page keeps the cursor it was given and the trail it came by, so forward
 * and back are the same bounded turn in either direction. Nothing here holds a
 * retired record; only the cursors between pages.
 */
export function retiredPageState() {
  return { cursor: null, pageIndex: 0, trail: [] };
}

/** Is there a further bounded turn to take, according to the page itself? */
export function canAdvanceRetiredPage(_state = retiredPageState(), page = null) {
  return Boolean(page?.hasMore && page?.continuation);
}

export function advanceRetiredPage(state = retiredPageState(), page = null) {
  if (!canAdvanceRetiredPage(state, page)) return state;
  return {
    cursor: page.continuation,
    pageIndex: state.pageIndex + 1,
    trail: [...state.trail, state.cursor],
  };
}

export function rewindRetiredPage(state = retiredPageState()) {
  if (!state.trail.length) return retiredPageState();
  const trail = state.trail.slice(0, -1);
  return {
    cursor: state.trail[state.trail.length - 1] ?? null,
    pageIndex: Math.max(0, state.pageIndex - 1),
    trail,
  };
}

/**
 * What a scan started from this page actually covers.
 *
 * "More deleted vehicles remain" and "more trip history remains" are two
 * different claims, and a scan that examined one page of deletions must not
 * read as coverage of every deletion.
 */
export function retiredScanScopeNote({ represented = 0, hasMoreProfiles = false, pageIndex = 0 } = {}) {
  // Scope is a property of the page's position in the collection, not only of
  // what follows it. A terminal page still has pages *before* it, and a scan
  // started there covered one profile — reading `hasMore === false` as "nothing
  // left to qualify" let the finished-history sentence stand alone and sound
  // like every deletion had been searched.
  const hasOtherProfiles = hasMoreProfiles || pageIndex > 0;
  if (!hasOtherProfiles) return null;
  const subject = `the ${represented} deleted vehicle${represented === 1 ? '' : 's'} on this page`;
  return hasMoreProfiles
    ? `This searches for ${subject}. Load the next page to search for the rest.`
    : `This searches for ${subject}. Earlier pages hold other deleted vehicles, which this search did not cover.`;
}

/**
 * HPR-010. Process-local discoveries converge with the durable mutation.
 *
 * A trip found beyond the recent page lives in this screen's own state, which
 * cache invalidation does not touch. After a successful reassignment it is no
 * longer a retired reference, so leaving it in the workflow offered the user a
 * repair that had already happened — repeatedly. Exactly the ids that settled
 * are removed, so a failed write keeps its trip repairable.
 */
export function clearReassignedDiscoveries(discovered = [], reassignedIds = []) {
  const removed = new Set((reassignedIds || []).filter(Boolean).map(String));
  if (!removed.size) return discovered;
  const kept = discovered.filter((trip) => !removed.has(String(trip?.id)));
  return kept.length === discovered.length ? discovered : kept;
}

/** Which assignments actually settled, so only those are treated as repaired. */
export function summarizeAssignmentOutcome(results = []) {
  const succeededIds = [];
  let failedCount = 0;
  for (const result of results) {
    if (result?.status === 'fulfilled' && result.value != null) succeededIds.push(String(result.value));
    else failedCount += 1;
  }
  return { succeededIds, failedCount };
}

/**
 * HPR-010. Bounded discovery feeds the same repair workflow as the recent page.
 *
 * A trip found beyond the newest page is repairable exactly like a recent one;
 * discovery that only counted would be a report, not a repair. Recent rows win
 * on identity, so nothing is listed twice and the recent row's own freshness is
 * the one that survives.
 */
export function mergeDiscoveredReviewTrips(recent = [], discovered = []) {
  if (!discovered.length) return recent;
  // One id appears once however many turns found it: a restart after the
  // history moved can legitimately re-read a page this scan already saw.
  const seen = new Set(recent.map((trip) => String(trip?.id)));
  const merged = [...recent];
  for (const trip of discovered) {
    if (!trip || seen.has(String(trip.id))) continue;
    seen.add(String(trip.id));
    merged.push(trip);
  }
  return merged;
}

export function resolveTripVehicle(trip = {}, vehicles = [], retiredVehicles = [], defaultVehicle = null) {
  const reference = String(trip?.vehicle_id || '');
  if (!reference) {
    // An unassigned trip follows the durable default. Deriving that default from
    // the loaded page handed the role to a visible stranger whenever the real
    // one sat outside it.
    const fallback = defaultVehicle
      || vehicles.find((vehicle) => vehicle.is_default)
      || null;
    return { vehicle: fallback, retired: false, unknown: false, assigned: false };
  }
  const active = vehicles.find((vehicle) => String(vehicle.id) === reference);
  if (active) return { vehicle: active, retired: false, unknown: false, assigned: true };
  const retired = retiredVehicles.find((vehicle) => String(vehicle.id) === reference);
  if (retired) return { vehicle: retired, retired: true, unknown: false, assigned: true };
  return { vehicle: null, retired: false, unknown: true, assigned: true };
}

const sameMonth = (date, now = new Date()) => {
  if (!date) return false;
  const parsed = new Date(date);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.getFullYear() === now.getFullYear() &&
    parsed.getMonth() === now.getMonth();
};

/**
 * @param {Array} vehicles
 * @param {Array} trips the bounded recent rows the assignment and service
 *   surfaces work on
 * @param {object} settings
 * @param {{fleet?: {trips: number, distanceKm: number}|null,
 *          byVehicleId?: Map<string, {trips: number, distanceKm: number, score: number|null}>}} [lifetime]
 *   authoritative lifetime totals from the D1 vehicle owner (Annex C O09/O10).
 *   When absent every figure falls back to the row array, which is what a
 *   direct caller without an owner gets; the page always supplies it.
 */
export function buildFleetIntelligence(vehicles = [], trips = [], settings = {}, lifetime = null, retiredVehicles = [], defaultVehicle = null) {
  const completedTrips = trips.filter((trip) => trip.status === 'completed');
  const lifetimeFor = (vehicle) => lifetime?.byVehicleId?.get(String(vehicle?.id)) || null;
  // HPR-010. A reference the fleet page cannot see is either retired or simply
  // outside this page; neither is "no vehicle", and neither is the default one.
  const vehicleForTrip = (trip) => resolveTripVehicle(trip, vehicles, retiredVehicles, defaultVehicle).vehicle || {};
  // Lifetime distance is an aggregate the D1 owner keys. Reducing the fetched
  // rows would report the window, not the fleet.
  const totalKm = lifetime?.fleet
    ? lifetime.fleet.distanceKm
    : completedTrips.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const monthTrips = completedTrips.filter((trip) => sameMonth(trip.start_time || trip.end_time));
  const monthlyCost = monthTrips.reduce((sum, trip) => (
    sum + estimateTripEconomics(trip, vehicleForTrip(trip), settings).cost
  ), 0);
  const unassignedTrips = getUnassignedCompletedTrips(completedTrips);
  const reviewTrips = getTripsNeedingVehicleReview(completedTrips);
  const serviceItems = vehicles.flatMap((vehicle) => {
    const odometerKm = getVehicleOdometerKm(vehicle, completedTrips);
    const plan = buildVehicleMaintenancePlan(vehicle, { odometerKm });
    return [...plan.due_items, ...plan.soon_items].map((item) => ({ vehicle, item }));
  });
  const ranked = vehicles
    .map((vehicle) => {
      const vehicleTrips = getTripsForVehicle(vehicle, completedTrips);
      const owned = lifetimeFor(vehicle);
      return {
        vehicle,
        // Trips, distance and the distance-weighted score are lifetime figures
        // the vehicle bucket already keys. Cost is per-trip economics that no
        // ledger keys, so it stays a figure over the bounded recent rows and the
        // UI labels it as such.
        trips: owned ? owned.trips : vehicleTrips.length,
        distanceKm: owned ? owned.distanceKm : vehicleTrips.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0),
        score: owned ? owned.score : calculateAverageVehicleScore(vehicleTrips),
        cost: vehicleTrips.reduce((sum, trip) => sum + estimateTripEconomics(trip, vehicle, settings).cost, 0),
        costIsRecentWindow: true,
      };
    })
    .sort((a, b) => b.distanceKm - a.distanceKm);

  return {
    vehicleCount: vehicles.length,
    completedTripCount: lifetime?.fleet ? lifetime.fleet.trips : completedTrips.length,
    /** `true` when the lifetime figures came from the D1 owner rather than the rows. */
    lifetimeExact: Boolean(lifetime?.fleet),
    unassignedTripCount: unassignedTrips.length,
    assignmentReviewCount: reviewTrips.length,
    totalKm,
    monthlyCost,
    serviceDueCount: serviceItems.length,
    busiestVehicle: ranked[0] || null,
    bestScoreVehicle: ranked
      .filter((entry) => entry.score != null)
      .sort((a, b) => b.score - a.score)[0] || null,
  };
}

function formatTripDate(trip) {
  const date = new Date(trip.start_time || trip.end_time || trip.created_at || Date.now());
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function suggestionTone(confidence = 0) {
  if (confidence >= 75) return 'text-emerald-700 border-emerald-200 bg-emerald-50 dark:text-emerald-300 dark:border-emerald-900/60 dark:bg-emerald-950/30';
  if (confidence >= 45) return 'text-blue-700 border-blue-200 bg-blue-50 dark:text-blue-300 dark:border-blue-900/60 dark:bg-blue-950/30';
  return 'text-muted-foreground border-border bg-secondary/50';
}

function VehicleForm({ initial = {}, onSave, onCancel, currencySymbol = '$' }) {
  const [form, setForm] = useState({
    name: '',
    make: '',
    model: '',
    trim: '',
    year: '',
    market: 'CA',
    engine: '',
    drivetrain: '',
    transmission: '',
    powertrain: 'gasoline',
    use_profile: 'normal',
    in_service_date: '',
    maintenance_monitor: 'none',
    color: '#3b82f6',
    odometer_km: 0,
    fuel_type: 'gasoline',
    fuel_efficiency_l_per_100km: 8.5,
    ev_efficiency_kwh_per_100km: 18,
    fuel_price_per_liter: 1.65,
    maintenance_reserve_per_km: 0.08,
    ...initial,
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const powertrain = normalizePowertrain(form.powertrain || form.fuel_type);
  const isElectric = powertrain === 'electric';
  const errors = validateVehicleForm(form);
  const warnings = getVehicleFormWarnings(form);
  const canSave = errors.length === 0;
  const displayCurrencySymbol = normalizeCurrencySymbol(currencySymbol);

  return (
    <div className="bg-secondary/50 rounded-2xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Nickname *</label>
          <input
            value={form.name} onChange={e => set('name', e.target.value)}
            placeholder="e.g. My Tesla"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Make</label>
          <input value={form.make} onChange={e => set('make', e.target.value)} placeholder="Toyota"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Model</label>
          <input value={form.model} onChange={e => set('model', e.target.value)} placeholder="Corolla"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Trim / configuration</label>
          <input value={form.trim || ''} onChange={e => set('trim', e.target.value)} placeholder="LE, Touring, Long Range"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Vehicle market</label>
          <select value={form.market || 'CA'} onChange={e => set('market', e.target.value)}
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary">
            <option value="CA">Canada</option>
            <option value="US">United States</option>
            <option value="OTHER">Other / imported</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Year</label>
          <input value={form.year} onChange={e => set('year', e.target.value)} placeholder="2022" type="number"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Odometer (km)</label>
          <input value={form.odometer_km} onChange={e => set('odometer_km', e.target.value)} placeholder="42000" type="number"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Powertrain</label>
          <select value={powertrain} onChange={e => setForm(current => ({ ...current, powertrain: e.target.value, fuel_type: e.target.value }))}
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary">
            {FUEL_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{isElectric ? 'Motor / battery configuration' : 'Engine / displacement'}</label>
          <input value={form.engine || ''} onChange={e => set('engine', e.target.value)} placeholder={isElectric ? 'Dual motor, battery option' : '2.0L turbo, engine code'}
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{isElectric ? 'EV kWh/100km' : 'Fuel L/100km'}</label>
          <input
            value={isElectric ? form.ev_efficiency_kwh_per_100km : form.fuel_efficiency_l_per_100km}
            onChange={e => set(isElectric ? 'ev_efficiency_kwh_per_100km' : 'fuel_efficiency_l_per_100km', e.target.value)}
            placeholder={isElectric ? '18' : '8.5'}
            type="number"
            step="0.1"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Drivetrain</label>
          <select value={form.drivetrain || ''} onChange={e => set('drivetrain', e.target.value)}
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary">
            <option value="">Select</option>
            {DRIVETRAIN_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Transmission</label>
          <select value={form.transmission || ''} onChange={e => set('transmission', e.target.value)}
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary">
            <option value="">Select</option>
            {TRANSMISSION_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">In-service date</label>
          <input type="date" value={form.in_service_date || ''} onChange={e => set('in_service_date', e.target.value)}
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Vehicle maintenance monitor</label>
          <select value={form.maintenance_monitor || 'none'} onChange={e => set('maintenance_monitor', e.target.value)}
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary">
            <option value="none">No / unknown</option>
            <option value="oil_life">Oil-life monitor</option>
            <option value="service_codes">Dashboard service codes</option>
            <option value="maintenance_summary">In-vehicle maintenance summary</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Operating profile</label>
          <select value={form.use_profile || 'normal'} onChange={e => set('use_profile', e.target.value)}
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary">
            <option value="normal">Normal personal use</option>
            <option value="short_trip_cold">Frequent short/cold trips</option>
            <option value="towing">Towing / heavy loads</option>
            <option value="commercial">Commercial / high-idle use</option>
            <option value="dusty">Dusty or off-road use</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">{isElectric ? `Energy Price (${displayCurrencySymbol}/kWh)` : `Fuel Price (${displayCurrencySymbol}/L)`}</label>
          <input value={form.fuel_price_per_liter} onChange={e => set('fuel_price_per_liter', e.target.value)} placeholder="1.65" type="number" step="0.01"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Maintenance reserve ({displayCurrencySymbol}/km)</label>
          <input value={form.maintenance_reserve_per_km} onChange={e => set('maintenance_reserve_per_km', e.target.value)} placeholder="0.08" type="number" step="0.01"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground mb-1.5 block">Color</label>
        <div className="flex gap-2 flex-wrap">
          {COLORS.map(c => (
            <button key={c} onClick={() => set('color', c)}
              className="w-7 h-7 rounded-full border-2 transition-all"
              style={{ background: c, borderColor: form.color === c ? 'white' : 'transparent', outline: form.color === c ? `2px solid ${c}` : 'none' }}
            />
          ))}
        </div>
      </div>
      {errors.length > 0 && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/30 dark:text-orange-300">
          {errors[0]}
        </div>
      )}
      {errors.length === 0 && warnings.length > 0 && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-xs text-yellow-700 dark:border-yellow-900/60 dark:bg-yellow-950/30 dark:text-yellow-300">
          {warnings[0]}
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 py-2 border border-border rounded-xl text-sm font-medium hover:bg-secondary transition-colors flex items-center justify-center gap-1.5">
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
        <button
          onClick={() => canSave && onSave({
            ...form,
            odometer_km: Number(form.odometer_km) || 0,
            powertrain,
            fuel_type: powertrain,
            fuel_efficiency_l_per_100km: Number(form.fuel_efficiency_l_per_100km) || 8.5,
            ev_efficiency_kwh_per_100km: Number(form.ev_efficiency_kwh_per_100km) || 18,
            fuel_price_per_liter: Number(form.fuel_price_per_liter) || 1.65,
            maintenance_reserve_per_km: Number(form.maintenance_reserve_per_km) || 0.08,
          })}
          disabled={!canSave}
          className="flex-1 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5 disabled:opacity-40"
        >
          <Check className="w-3.5 h-3.5" /> Save
        </button>
      </div>
    </div>
  );
}

export default function Vehicles() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const settings = useLocalSettings();
  const currencySymbol = normalizeCurrencySymbol(settings.currencySymbol);
  const units = settings.units || 'metric';

  // HPR-003. The fleet manager reads one bounded page and is told what that page
  // represents, so it can say "at least N" and offer the rest instead of ending
  // silently at a cap. HPR-010: retired profiles are their own bounded authority
  // — reference existence is never inferred from this page's contents.
  const [vehiclePageSize, setVehiclePageSize] = useState(VEHICLE_PAGE_SIZE);
  const { data: vehiclePage, isLoading } = useQuery({
    queryKey: vehicleQueryKeys.page({ sort: '-created_date', limit: vehiclePageSize }),
    queryFn: () => vehicleService.listPage({ sort: '-created_date', limit: vehiclePageSize }),
  });
  const vehicles = useMemo(() => vehiclePage?.vehicles ?? [], [vehiclePage]);
  // HPR-010/6A. Retired profiles are shown as a bounded page: the collection
  // grows with every deletion and the screen only ever shows the first names.
  // HPR-010. Deletions accumulate, so the retired list is paged and the page
  // keeps the cursor it is on. Without this the eleventh deleted profile was
  // disclosed and unreachable.
  const [retiredNav, setRetiredNav] = useState(retiredPageState);
  const { data: retiredPage } = useQuery({
    queryKey: vehicleQueryKeys.retiredPage({ limit: RETIRED_PAGE_SIZE, cursor: retiredNav.cursor }),
    queryFn: () => vehicleService.listRetiredPage({ limit: RETIRED_PAGE_SIZE, cursor: retiredNav.cursor }),
  });
  const retiredVehicles = useMemo(() => retiredPage?.vehicles ?? [], [retiredPage]);
  useEffect(() => {
    // A refused continuation means the deletions moved; going back to the first
    // page is the only honest position left.
    if (retiredPage?.restartRequired && retiredNav.cursor) setRetiredNav(retiredPageState());
  }, [retiredPage, retiredNav.cursor]);
  // The durable default, not the first row of whatever page loaded.
  const { data: durableDefaultVehicle = null } = useQuery({
    queryKey: vehicleQueryKeys.default,
    queryFn: () => vehicleService.getDefault(),
  });

  // P7 Stage 6 (Annex C O09/O10): one bounded Q1 page for the assignment and
  // service surfaces, plus Q4 per vehicle over the D1 owner's own
  // `browser:vehicle:<id>:2` buckets for the lifetime totals. The page used to
  // derive those lifetime figures from a 200-row window, which made them wrong
  // for any fleet with more history than that.
  const {
    recentTrips,
    recentUnavailable,
    lifetime: vehicleLifetime,
    isLoading: recentTripsLoading,
  } = useVehicleAnalytics(vehicles);
  const trips = recentTrips;

  // Stable so the odometer-sync effect can depend on it without re-syncing on
  // every render. The query client identity is already stable.
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: vehicleQueryKeys.all }), [qc]);
  const invalidateTrips = () => {
    qc.invalidateQueries({ queryKey: tripQueryKeys.summaries });
    qc.invalidateQueries({ queryKey: tripQueryKeys.map });
  };

  // A typed unavailable is its own state: an empty fleet list would claim the
  // garage is empty, which is a different and untrue thing to say.
  const vehicleTripsUnavailable = recentUnavailable;

  const fleetIntelligence = useMemo(
    () => buildFleetIntelligence(vehicles, trips, settings, vehicleLifetime, retiredVehicles, durableDefaultVehicle),
    [vehicles, trips, settings, vehicleLifetime, retiredVehicles, durableDefaultVehicle]
  );
  const unassignedTrips = useMemo(() => getUnassignedCompletedTrips(trips), [trips]);
  // HPR-010/6A. Classification asks the authority about exactly the references
  // these loaded rows mention, so no global retired-id set is needed and a
  // vehicle outside any page is never mistaken for a deleted one.
  const referencedVehicleIds = useMemo(
    () => [...new Set(trips.map((trip) => trip?.vehicle_id).filter(Boolean).map(String))],
    [trips],
  );
  const { data: vehicleStates = new Map() } = useQuery({
    // The lifecycle question has its own cache identity: Trip History asks for
    // the same ids and gets records back, and one identity cannot hold both.
    queryKey: vehicleQueryKeys.referenceStates(referencedVehicleIds),
    queryFn: () => vehicleService.getReferenceStates(referencedVehicleIds),
    enabled: referencedVehicleIds.length > 0,
  });
  const [retiredScan, setRetiredScan] = useState({
    running: false, cursor: null, complete: false, restartRequired: false, scanned: 0, found: [],
  });
  useEffect(() => {
    // A scan belongs to the deleted vehicles it was started for. Moving to
    // another page changes the question, so its answer does not carry over.
    setRetiredScan({ running: false, cursor: null, complete: false, restartRequired: false, scanned: 0, found: [] });
  }, [retiredNav.cursor]);
  const runRetiredReferenceScan = useCallback(async () => {
    const retiredIds = new Set(retiredVehicles.map((vehicle) => String(vehicle.id)));
    if (!retiredIds.size) return;
    setRetiredScan((state) => ({ ...state, running: true }));
    const { p7TripQueries } = await import('@/api/trips');
    const result = await discoverRetiredReferenceTrips({
      retiredVehicleIds: retiredIds,
      cursor: retiredScan.cursor,
      readPage: ({ cursor }) => p7TripQueries.historyPage({
        sort: '-start_time', status: 'completed', limit: VEHICLE_RETIRED_SCAN_PAGE, cursor,
      }),
    }).catch(() => null);
    setRetiredScan((state) => (result ? {
      running: false,
      cursor: result.continuation,
      complete: result.complete,
      restartRequired: result.restartRequired,
      scanned: state.scanned + 1,
      found: [...state.found, ...result.trips],
    } : { ...state, running: false }));
  }, [retiredVehicles, retiredScan.cursor]);

  const assignmentReviewTrips = useMemo(
    () => mergeDiscoveredReviewTrips(
      getTripsNeedingVehicleReview(trips, { vehicleStates }),
      retiredScan.found,
    ),
    [trips, vehicleStates, retiredScan.found],
  );
  const assignmentSuggestions = useMemo(
    () => buildVehicleAssignmentSuggestions(assignmentReviewTrips, vehicles, trips),
    [assignmentReviewTrips, vehicles, trips]
  );
  const highConfidenceAssignments = useMemo(() => (
    assignmentReviewTrips
      .map((trip) => {
        const suggestion = assignmentSuggestions.get(String(trip.id));
        return suggestion?.confidence >= 75
          ? {
              tripId: trip.id,
              vehicleId: suggestion.vehicle.id,
              confidence: suggestion.confidence,
              source: 'vehicle_suggestion',
            }
          : null;
      })
      .filter(Boolean)
  ), [assignmentReviewTrips, assignmentSuggestions]);
  // The durable default from the collection authority; the loaded page is a
  // display prefix and cannot decide which vehicle is canonical.
  const defaultVehicle = durableDefaultVehicle
    || vehicles.find((vehicle) => vehicle.is_default)
    || null;

  const createMut = useMutation({
    mutationFn: (/** @type {any} */ d) => vehicleService.create(d),
    onSuccess: () => { invalidate(); setShowAdd(false); },
  });

  const updateMut = useMutation({
    mutationFn: (/** @type {{id:any,d:any}} */ vars) => vehicleService.update(vars.id, vars.d),
    onSuccess: () => { invalidate(); setEditId(null); },
  });

  const deleteMut = useMutation({
    mutationFn: (/** @type {any} */ id) => vehicleService.delete(id),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Vehicle deleted', description: 'Vehicle stats were removed. Existing trips are kept.' });
    },
  });

  const assignTripsMut = useMutation({
    mutationFn: async (/** @type {{tripIds?:any[],vehicleId?:any,assignments?:Array<{tripId:any,vehicleId:any,confidence?:number,source?:string}>}} */ vars) => {
      const confirmedAt = new Date().toISOString();
      const assignments = Array.isArray(vars.assignments)
        ? vars.assignments
        : (vars.tripIds || []).map((tripId) => ({
            tripId,
            vehicleId: vars.vehicleId,
            source: 'manual_assignment',
          }));
      // Settled per trip, because the repair state must converge with what
      // actually happened: one failed write may not carry away the trips that
      // succeeded, and a trip that did not move stays repairable.
      const results = await Promise.allSettled(assignments.map(async (assignment) => {
        await tripService.update(assignment.tripId, {
          vehicle_id: assignment.vehicleId,
          vehicle_assignment_status: 'confirmed',
          vehicle_assignment_source: assignment.source || 'manual_assignment',
          vehicle_assignment_confidence: Number(assignment.confidence) || null,
          vehicle_assignment_confirmed_at: confirmedAt,
        });
        return assignment.tripId;
      }));
      return { assignments, ...summarizeAssignmentOutcome(results) };
    },
    onSuccess: ({ succeededIds, failedCount }) => {
      invalidateTrips();
      invalidate();
      // Cache invalidation refreshes durable data; it cannot reach this
      // screen's own discoveries, so those are reconciled explicitly.
      if (succeededIds.length) {
        setRetiredScan((state) => {
          const found = clearReassignedDiscoveries(state.found, succeededIds);
          return found === state.found ? state : { ...state, found };
        });
      }
      toast({
        title: failedCount ? 'Some trips confirmed' : 'Trips confirmed',
        description: failedCount
          ? `${succeededIds.length} trip${succeededIds.length === 1 ? '' : 's'} confirmed; ${failedCount} could not be saved and can be tried again.`
          : `${succeededIds.length} trip${succeededIds.length === 1 ? '' : 's'} now feed trusted vehicle cost, maintenance, and score insights.`,
        variant: failedCount ? 'destructive' : undefined,
      });
    },
  });

  const handleDeleteVehicle = async (vehicle) => {
    const confirmed = await requestAppConfirm({
      title: 'Delete vehicle?',
      message: `Delete ${vehicle.name || 'this vehicle'}? Existing trips will stay in history, but this vehicle profile will be removed.`,
      confirmLabel: 'Delete vehicle',
      destructive: true,
    });
    if (!confirmed) return;
    deleteMut.mutate(vehicle.id);
  };

  const handleSetDefault = async (id) => {
    for (const v of vehicles) {
      await vehicleService.update(v.id, { is_default: v.id === id });
    }
    invalidate();
  };


  useEffect(() => {
    if (!vehicles.length || !trips.length) return;
    let cancelled = false;
    const syncOdometers = async () => {
      let changed = false;
      for (const vehicle of vehicles) {
        const tripDistance = getVehicleTripDistanceKm(vehicle, trips);
        const anchorDistance = Number(vehicle.odometer_trip_distance_anchor_km) || 0;
        if (tripDistance <= anchorDistance + 0.1) continue;

        const odometerKm = getVehicleOdometerKm(vehicle, trips);
        await vehicleService.update(vehicle.id, {
          odometer_km: odometerKm,
          odometer_trip_distance_anchor_km: tripDistance,
          auto_odometer_last_sync_at: new Date().toISOString(),
        });
        changed = true;
      }
      if (!cancelled && changed) invalidate();
    };

    syncOdometers().catch((err) => {
      odometerSyncFailureCount += 1;
      logError('vehicle_odometer_sync', err, {
        vehicle_count: vehicles.length,
        trip_count: trips.length,
        failure_count: odometerSyncFailureCount,
      });
      if (odometerSyncFailureCount > 1 && !odometerSyncFailureToastShown) {
        odometerSyncFailureToastShown = true;
        toast({
          title: 'Odometer sync delayed',
          description: 'Vehicle odometer estimates may be stale. We will try again when vehicle data refreshes.',
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [vehicles, trips, invalidate]);

  const tripListFor = (vehicle) => getTripsForVehicle(vehicle, trips);
  const tripCountFor = (vehicle) => tripListFor(vehicle).length;
  const avgScoreFor = (vehicle) => {
    return calculateAverageVehicleScore(tripListFor(vehicle));
  };
  const fuelTotalsFor = (vehicle) => tripListFor(vehicle).reduce((totals, trip) => {
    const estimate = estimateTripEconomics(trip, vehicle, settings);
    return {
      cost: totals.cost + estimate.cost,
      co2: totals.co2 + estimate.co2_kg,
    };
  }, { cost: 0, co2: 0 });

  return (
    <div className="space-y-5 pb-6">
      <PageHeader
        title="My Vehicles"
        description="Vehicle intelligence, ownership cost, and trip assignment"
        icon={Car}
        actions={(
          <button
            type="button"
            onClick={() => setShowAdd(v => !v)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        )}
      />

      {vehicleTripsUnavailable && (
        <div role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-100">
          <div className="font-semibold">Trip data for this fleet is not available right now</div>
          {/* Rendering this as an empty trip set would report zero kilometres
              for every vehicle, which is a measurement claim rather than a
              state. */}
          <div className="mt-1">
            The stored trips could not be read ({vehicleTripsUnavailable.code}). Vehicle records and odometers were not changed.
          </div>
        </div>
      )}

      <div role="note" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs leading-relaxed text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-100">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div><span className="font-semibold">Maintenance estimates are not vehicle instructions. </span>{VEHICLE_MAINTENANCE_DISCLAIMER}</div>
        </div>
      </div>

      {settings.premium_visual_experience === true ? (
        <PremiumVehicleOverview
          summary={fleetIntelligence}
          vehicleCountLabel={fleetCountLabel({ count: fleetIntelligence.vehicleCount, hasMore: vehiclePage?.hasMore === true })}
          formattedMonthlyCost={formatCurrencyAmount(fleetIntelligence.monthlyCost, currencySymbol)}
          formattedTotalDistance={formatDistanceScope(fleetIntelligence.totalKm, units)}
          loading={isLoading || recentTripsLoading}
        />
      ) : (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid gap-3 md:grid-cols-4">
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Car className="h-4 w-4 text-primary" />
            Garage
          </div>
          {/* HPR-003. The headline figure itself is a lower bound while the fleet
              page has a continuation; a footer alone cannot un-say a total. */}
          <div className="mt-2 text-2xl font-bold">
            {fleetCountLabel({ count: fleetIntelligence.vehicleCount, hasMore: vehiclePage?.hasMore === true })}
          </div>
          <div className="text-xs text-muted-foreground">
            {fleetIntelligence.completedTripCount} completed trip{fleetIntelligence.completedTripCount === 1 ? '' : 's'}
          </div>
        </div>
        <div className={`rounded-2xl border p-4 ${
          fleetIntelligence.assignmentReviewCount
            ? 'border-orange-200 bg-orange-50 dark:border-orange-900/60 dark:bg-orange-950/20'
            : 'border-border bg-card'
        }`}>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ClipboardCheck className="h-4 w-4 text-primary" />
            Assignment health
          </div>
          <div className={`mt-2 text-2xl font-bold ${fleetIntelligence.assignmentReviewCount ? 'text-orange-600 dark:text-orange-300' : ''}`}>
            {fleetIntelligence.assignmentReviewCount}
          </div>
          <div className="text-xs text-muted-foreground">trip{fleetIntelligence.assignmentReviewCount === 1 ? '' : 's'} need vehicle review</div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Fuel className="h-4 w-4 text-primary" />
            This month
          </div>
          <div className="mt-2 text-2xl font-bold">{formatCurrencyAmount(fleetIntelligence.monthlyCost, currencySymbol)}</div>
          <div className="text-xs text-muted-foreground">{formatDistanceScope(fleetIntelligence.totalKm, units)} total history</div>
        </div>
        <div className={`rounded-2xl border p-4 ${
          fleetIntelligence.serviceDueCount
            ? 'border-yellow-200 bg-yellow-50 dark:border-yellow-900/60 dark:bg-yellow-950/20'
            : 'border-border bg-card'
        }`}>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Wrench className="h-4 w-4 text-primary" />
            Service watch
          </div>
          <div className={`mt-2 text-2xl font-bold ${fleetIntelligence.serviceDueCount ? 'text-yellow-700 dark:text-yellow-300' : ''}`}>
            {fleetIntelligence.serviceDueCount}
          </div>
          <div className="text-xs text-muted-foreground">maintenance item{fleetIntelligence.serviceDueCount === 1 ? '' : 's'} due soon</div>
        </div>
      </motion.div>
      )}

      {(fleetIntelligence.busiestVehicle || fleetIntelligence.bestScoreVehicle || fleetIntelligence.assignmentReviewCount > 0) && (
        settings.premium_visual_experience === true ? (
          <PremiumFleetIntelligenceCard
            intelligence={fleetIntelligence}
            highConfidenceAssignmentCount={highConfidenceAssignments.length}
            units={units}
          />
        ) : (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="h-4 w-4 text-primary" />
            Fleet intelligence
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl bg-secondary/50 p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Route className="h-3.5 w-3.5" />
                Busiest vehicle
              </div>
              <div className="mt-1 text-sm font-semibold">{fleetIntelligence.busiestVehicle?.vehicle?.name || 'No trip data yet'}</div>
              <div className="text-xs text-muted-foreground">
                {fleetIntelligence.busiestVehicle
                  ? `${formatDistanceScope(fleetIntelligence.busiestVehicle.distanceKm, units)} across ${fleetIntelligence.busiestVehicle.trips} trip${fleetIntelligence.busiestVehicle.trips === 1 ? '' : 's'}`
                  : 'Complete trips to build a vehicle profile'}
              </div>
            </div>
            <div className="rounded-xl bg-secondary/50 p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Activity className="h-3.5 w-3.5" />
                Best scoring vehicle
              </div>
              <div className="mt-1 text-sm font-semibold">{fleetIntelligence.bestScoreVehicle?.vehicle?.name || 'Not enough scored trips'}</div>
              <div className="text-xs text-muted-foreground">
                {fleetIntelligence.bestScoreVehicle
                  ? `${formatEstimatedScore(fleetIntelligence.bestScoreVehicle.score)} aggregate evidence`
                  : 'Assign vehicles to compare real driving behavior'}
              </div>
            </div>
            <div className="rounded-xl bg-secondary/50 p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarClock className="h-3.5 w-3.5" />
                Next action
              </div>
              <div className="mt-1 text-sm font-semibold">
                {highConfidenceAssignments.length > 0
                  ? 'Confirm suggested vehicles'
                  : fleetIntelligence.assignmentReviewCount > 0
                    ? 'Review vehicle assignments'
                  : fleetIntelligence.serviceDueCount > 0
                    ? 'Review service reminders'
                    : 'Vehicle data is current'}
              </div>
              <div className="text-xs text-muted-foreground">
                {highConfidenceAssignments.length > 0
                  ? `${highConfidenceAssignments.length} high-confidence suggestion${highConfidenceAssignments.length === 1 ? '' : 's'} ${highConfidenceAssignments.length === 1 ? 'is' : 'are'} ready.`
                  : fleetIntelligence.assignmentReviewCount > 0
                    ? 'Confirmed assignment data unlocks better costs, CO2, odometer, and maintenance.'
                  : fleetIntelligence.serviceDueCount > 0
                    ? 'Mark completed service to keep forecasts accurate.'
                    : 'New trips will keep the fleet profile fresh.'}
              </div>
            </div>
          </div>
        </div>
        )
      )}

      {vehicles.length > 0 && assignmentReviewTrips.length > 0 && (
        <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4 dark:border-orange-900/60 dark:bg-orange-950/20">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-orange-800 dark:text-orange-200">
                <ClipboardCheck className="h-4 w-4" />
                Assignment Center
              </div>
              <div className="mt-1 max-w-2xl text-xs text-orange-700 dark:text-orange-300">
                {assignmentReviewTrips.length} completed trip{assignmentReviewTrips.length === 1 ? '' : 's'} need vehicle confirmation. Suggestions use route, schedule, recent assignment, and distance evidence before the trip is trusted for cost, CO2, maintenance, and comparisons.
              </div>
            </div>
            {highConfidenceAssignments.length > 0 ? (
              <button
                onClick={() => assignTripsMut.mutate({ assignments: highConfidenceAssignments })}
                disabled={assignTripsMut.isPending}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-orange-600 px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Sparkles className="h-4 w-4" />
                Confirm {highConfidenceAssignments.length} suggested
              </button>
            ) : defaultVehicle && unassignedTrips.length > 0 ? (
              <button
                onClick={() => assignTripsMut.mutate({
                  assignments: unassignedTrips.map((trip) => ({
                    tripId: trip.id,
                    vehicleId: defaultVehicle.id,
                    source: 'default_vehicle_confirmed',
                  })),
                })}
                disabled={assignTripsMut.isPending}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-orange-600 px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Check className="h-4 w-4" />
                Confirm unassigned as {defaultVehicle.name}
              </button>
            ) : null}
          </div>
          <div className="mt-3 space-y-2">
            {assignmentReviewTrips.slice(0, 6).map((trip) => {
              const suggestion = assignmentSuggestions.get(String(trip.id));
              const suggestedVehicleId = suggestion?.vehicle?.id;
              const locationLabel = `${trip.start_location || trip.start_address || 'Recorded trip'}${trip.end_location || trip.end_address ? ` to ${trip.end_location || trip.end_address}` : ''}`;
              return (
                <div key={trip.id} className="rounded-xl bg-card p-3 text-xs">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                      <div className="font-semibold">{formatTripDate(trip)} - {formatDistance(Number(trip.distance_km) || 0, units)}</div>
                      <div className="truncate text-muted-foreground">{locationLabel}</div>
                      {trip.vehicle_assignment_status === 'needs_confirmation' && (
                        <div className="mt-1 text-[11px] text-orange-700 dark:text-orange-300">
                          Currently guessed as {vehicles.find((vehicle) => String(vehicle.id) === String(trip.vehicle_id))?.name || 'a vehicle'}.
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {suggestion?.vehicle && (
                        <button
                          onClick={() => assignTripsMut.mutate({
                            assignments: [{
                              tripId: trip.id,
                              vehicleId: suggestion.vehicle.id,
                              confidence: suggestion.confidence,
                              source: 'vehicle_suggestion',
                            }],
                          })}
                          disabled={assignTripsMut.isPending}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-semibold disabled:opacity-50 ${suggestionTone(suggestion.confidence)}`}
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          {suggestion.vehicle.name} {suggestion.confidence}%
                        </button>
                      )}
                      {vehicles
                        .filter((vehicle) => String(vehicle.id) !== String(suggestedVehicleId))
                        .slice(0, 3)
                        .map((vehicle) => (
                          <button
                            key={vehicle.id}
                            onClick={() => assignTripsMut.mutate({
                              assignments: [{
                                tripId: trip.id,
                                vehicleId: vehicle.id,
                                source: 'manual_assignment',
                              }],
                            })}
                            disabled={assignTripsMut.isPending}
                            className="rounded-lg border border-border bg-secondary px-2 py-1 font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                          >
                            {vehicle.name}
                          </button>
                        ))}
                    </div>
                  </div>
                  {suggestion?.reasons?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {suggestion.reasons.map((reason) => (
                        <span key={`${trip.id}-${reason.label}`} className="rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                          {reason.label}: {reason.detail}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {assignmentReviewTrips.length > 6 && (
              <div className="text-xs text-orange-700 dark:text-orange-300">
                {assignmentReviewTrips.length - 6} more trip{assignmentReviewTrips.length - 6 === 1 ? '' : 's'} are waiting for vehicle review.
              </div>
            )}
          </div>
        </div>
      )}

      <AnimatePresence>
        {showAdd && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <VehicleForm onSave={(d) => createMut.mutate(d)} onCancel={() => setShowAdd(false)} currencySymbol={currencySymbol} />
          </motion.div>
        )}
      </AnimatePresence>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2].map(i => <div key={i} className="h-24 bg-secondary/50 rounded-2xl animate-pulse" />)}
        </div>
      )}

      {!isLoading && vehicles.length === 0 && !showAdd && (
        <PageEmptyState
          icon={Car}
          title="No vehicles yet"
          description="Add your first vehicle to connect trips with fuel cost, maintenance, odometer, and per-car scores."
        >
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            Add vehicle
          </button>
        </PageEmptyState>
      )}

      {vehicles.length >= 2 && (
        <VehicleCompare vehicles={vehicles} trips={trips} units={units} />
      )}

      <div className="space-y-3">
        {vehicles.map((v, i) => {
          const count = tripCountFor(v);
          const score = avgScoreFor(v);
          const isEditing = editId === v.id;
          const odometerKm = getVehicleOdometerKm(v, trips);
          const vehicleTrips = tripListFor(v);
          const maintenancePlan = buildVehicleMaintenancePlan(v, { odometerKm });
          const dueMaintenance = [...maintenancePlan.due_items, ...maintenancePlan.soon_items];
          const fuelTotals = fuelTotalsFor(v);
          const costSummary = buildVehicleCostSummary(v, vehicleTrips);
          const isElectricVehicle = normalizePowertrain(v.powertrain || v.fuel_type) === 'electric';

          return (
            <motion.div key={v.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
              className="bg-card border border-border rounded-2xl overflow-hidden">
              {isEditing ? (
                <div className="p-4">
                  <VehicleForm
                    initial={v}
                    onSave={(d) => updateMut.mutate({ id: v.id, d })}
                    onCancel={() => setEditId(null)}
                    currencySymbol={currencySymbol}
                  />
                </div>
              ) : (
                <div className="p-4">
                  <div className="flex items-start gap-3">
                    {/* Color dot */}
                    <div className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: v.color || '#3b82f6' }}>
                      <Car className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{v.name}</span>
                        {v.is_default && (
                          <span className="text-xs bg-amber-50 dark:bg-amber-950/30 text-amber-600 border border-amber-200 dark:border-amber-800/50 px-1.5 py-0.5 rounded-full">
                            Default
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {[v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle details incomplete'}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {[v.market || 'CA', humanizePowertrain(v.powertrain || v.fuel_type), v.engine].filter(Boolean).join(' / ')}
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                        <span>{count} trip{count !== 1 ? 's' : ''}</span>
                        {score !== null && (
                          <span className="font-semibold text-primary">Avg score: {formatEstimatedScore(score)} <span className="font-normal capitalize text-muted-foreground">aggregate evidence</span></span>
                        )}
                        <span>{formatDistanceScope(odometerKm, units, 0)}</span>
                      </div>
                      {v.auto_odometer_last_sync_at && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Odometer auto-synced from trips {new Date(v.auto_odometer_last_sync_at).toLocaleDateString()}.
                        </div>
                      )}
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button onClick={() => handleSetDefault(v.id)} title="Set as default"
                        className={`p-1.5 rounded-lg transition-colors ${v.is_default ? 'text-amber-500' : 'text-muted-foreground hover:bg-secondary'}`}>
                        <Star className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setEditId(v.id)}
                        className="p-1.5 text-muted-foreground hover:bg-secondary rounded-lg transition-colors">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDeleteVehicle(v)}
                        className="p-1.5 text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-4">
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {isElectricVehicle ? <Zap className="w-3.5 h-3.5" /> : <Fuel className="w-3.5 h-3.5" />}
                        {isElectricVehicle ? 'Energy estimate' : 'Fuel estimate'}
                      </div>
                      <div className="font-semibold text-sm mt-1">{formatCurrencyAmount(fuelTotals.cost, currencySymbol)}</div>
                      <div className="text-xs text-muted-foreground">{fuelTotals.co2.toFixed(1)} kg CO2</div>
                    </div>
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Wrench className="w-3.5 h-3.5" />
                        Maintenance
                      </div>
                      <div className={`font-semibold text-sm mt-1 ${!maintenancePlan.configured ? 'text-muted-foreground' : dueMaintenance.length ? 'text-orange-500' : 'text-emerald-500'}`}>
                        {!maintenancePlan.configured
                          ? 'Schedule needed'
                          : dueMaintenance.length
                            ? `${dueMaintenance.length} due or coming up`
                            : 'Schedule current'}
                      </div>
                    </div>
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ClipboardCheck className="w-3.5 h-3.5" />
                        Schedule confidence
                      </div>
                      <div className="font-semibold text-sm mt-1">{maintenancePlan.confidence.score}% profile</div>
                      <div className="text-xs text-muted-foreground">{maintenancePlan.configured ? 'Verified schedule enabled' : 'Manufacturer schedule needed'}</div>
                    </div>
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Activity className="w-3.5 h-3.5" />
                        Powertrain
                      </div>
                      <div className="font-semibold text-sm mt-1 capitalize">{humanizePowertrain(v.powertrain || v.fuel_type)}</div>
                      <div className="text-xs text-muted-foreground">Maintenance items are filtered by applicability.</div>
                    </div>
                  </div>

                  <div className="mt-3 rounded-2xl border border-border bg-card p-3">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-sm font-semibold">
                        <Fuel className="h-4 w-4 text-primary" />
                        Cost dashboard
                      </div>
                      <span className="text-xs text-muted-foreground">{formatDistance(costSummary.monthly_distance_km, units)} this month</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                      <div className="rounded-xl bg-secondary/50 p-3">
                        <div className="text-xs text-muted-foreground">Monthly cost</div>
                        <div className="mt-1 text-sm font-semibold">{formatCurrencyAmount(costSummary.monthly_cost, currencySymbol)}</div>
                      </div>
                      <div className="rounded-xl bg-secondary/50 p-3">
                        <div className="text-xs text-muted-foreground">Cost per {distanceUnitLabel(units)}</div>
                        <div className="mt-1 text-sm font-semibold">{formatCurrencyAmount(convertPerDistanceRate(costSummary.cost_per_km, units), currencySymbol)}</div>
                      </div>
                      <div className="rounded-xl bg-secondary/50 p-3">
                        <div className="text-xs text-muted-foreground">Fuel estimate</div>
                        <div className="mt-1 text-sm font-semibold">{formatCurrencyAmount(costSummary.fuel_cost, currencySymbol)}</div>
                      </div>
                      <div className="rounded-xl bg-secondary/50 p-3">
                        <div className="text-xs text-muted-foreground">Maintenance reserve</div>
                        <div className="mt-1 text-sm font-semibold">{formatCurrencyAmount(costSummary.maintenance_reserve, currencySymbol)}</div>
                      </div>
                    </div>
                  </div>

                  <VehicleMaintenancePanel
                    units={units}
                    vehicle={v}
                    trips={vehicleTrips}
                    odometerKm={odometerKm}
                    onUpdate={async (patch) => {
                      await vehicleService.update(v.id, patch);
                      invalidate();
                    }}
                  />
                </div>
              )}
            </motion.div>
          );
        })}
      </div>

      {vehiclePage?.hasMore && (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card/60 p-4 text-center">
          {/* HPR-003. The page is a floor, and it says so rather than ending silently. */}
          <div className="text-sm text-muted-foreground">
            Showing at least {vehicles.length} vehicles - more of your fleet has not been read yet.
          </div>
          <button
            type="button"
            onClick={() => setVehiclePageSize((size) => size + VEHICLE_PAGE_SIZE)}
            className="rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
          >
            Show more vehicles
          </button>
        </div>
      )}

      {retiredVehicles.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4">
          {/* HPR-010. A deleted profile keeps an explicit identity so the trips
              that reference it can still be found and reassigned. */}
          <div className="text-sm font-semibold">Deleted vehicles</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {retiredVehicles.length} deleted vehicle{retiredVehicles.length === 1 ? '' : 's'} still
            {' '}{retiredVehicles.length === 1 ? 'holds' : 'hold'} historical trips. Those trips stay in your
            history and appear in the assignment review above, where you can move them to a current vehicle.
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {retiredVehicles.map((vehicle) => (
              <li key={vehicle.id}>{vehicle.name || 'Deleted vehicle'} - deleted {new Date(vehicle.retired_at).toLocaleDateString()}</li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {retiredNav.pageIndex > 0 && (
              <button
                type="button"
                onClick={() => setRetiredNav((nav) => rewindRetiredPage(nav))}
                className="rounded-xl bg-secondary px-3 py-2 text-xs font-semibold text-foreground"
              >
                Previous deleted vehicles
              </button>
            )}
            {canAdvanceRetiredPage(retiredNav, retiredPage) && (
              <button
                type="button"
                onClick={() => setRetiredNav((nav) => advanceRetiredPage(nav, retiredPage))}
                className="rounded-xl bg-secondary px-3 py-2 text-xs font-semibold text-foreground"
              >
                More deleted vehicles
              </button>
            )}
            {(retiredPage?.hasMore || retiredNav.pageIndex > 0) && (
              <span className="text-xs text-muted-foreground">
                Page {retiredNav.pageIndex + 1}
                {retiredPage?.hasMore ? ' - more deleted vehicles remain.' : ' - this is the last page.'}
              </span>
            )}
          </div>
          {/* HPR-010. Older affected trips live beyond the recent page, so the
              workflow offers bounded turns instead of implying it has them all. */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runRetiredReferenceScan}
              disabled={retiredScan.running}
              className="rounded-xl bg-secondary px-3 py-2 text-xs font-semibold text-foreground disabled:opacity-50"
            >
              {retiredScan.running ? 'Looking…' : retiredScan.cursor ? 'Look further back' : 'Find affected trips'}
            </button>
            <span className="text-xs text-muted-foreground">
              {retiredScan.complete
                ? `All read history has been checked. ${retiredScan.found.length} affected trip${retiredScan.found.length === 1 ? '' : 's'} found.`
                : retiredScan.restartRequired
                  ? 'History moved while looking; start again to check it.'
                  : retiredScan.scanned
                    ? `${retiredScan.found.length} affected trip${retiredScan.found.length === 1 ? '' : 's'} found so far - more history has not been checked yet.`
                    : 'History beyond the recent list has not been checked yet.'}
            </span>
            {retiredScanScopeNote({
              represented: retiredVehicles.length,
              hasMoreProfiles: retiredPage?.hasMore === true,
              pageIndex: retiredNav.pageIndex,
            }) && (
              <span className="text-xs text-muted-foreground">
                {retiredScanScopeNote({
                  represented: retiredVehicles.length,
                  hasMoreProfiles: retiredPage?.hasMore === true,
                  pageIndex: retiredNav.pageIndex,
                })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
