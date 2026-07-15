// @ts-check
import { clamp } from '@/lib/mathUtils';
import {
  getVehicleReferenceSource,
  MANUFACTURER_REFERENCE_TEMPLATES,
  VEHICLE_REFERENCE_CATALOG_VERSION,
  VEHICLE_REFERENCE_REVIEWED_AT,
} from '@/lib/vehicleReferenceCatalog';

export const VEHICLE_MAINTENANCE_SCHEMA_VERSION = 2;
export const VERIFIED_SCHEDULE_SOURCE_TYPES = new Set([
  'manufacturer_manual',
  'manufacturer_monitor',
  'manufacturer_reference',
  'owner_entered_manufacturer',
]);

export const POWERTRAIN_OPTIONS = Object.freeze([
  { value: 'gasoline', label: 'Gasoline' },
  { value: 'diesel', label: 'Diesel' },
  { value: 'hybrid', label: 'Hybrid (non-plug-in)' },
  { value: 'phev', label: 'Plug-in hybrid' },
  { value: 'electric', label: 'Battery electric' },
]);

export const DRIVETRAIN_OPTIONS = Object.freeze(['FWD', 'RWD', 'AWD', '4WD', 'Other']);
export const TRANSMISSION_OPTIONS = Object.freeze(['Automatic', 'Manual', 'CVT', 'Single-speed', 'Other']);


const normalizeText = (value) => String(value || '').trim().toLowerCase();
const isoDateOnly = (value) => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
};

export function normalizePowertrain(value) {
  const normalized = normalizeText(value);
  if (normalized === 'ev' || normalized === 'bev' || normalized === 'battery electric') return 'electric';
  if (normalized === 'plug-in hybrid' || normalized === 'plugin hybrid') return 'phev';
  if (['gasoline', 'diesel', 'hybrid', 'phev', 'electric'].includes(normalized)) return normalized;
  return 'gasoline';
}

export function getVehicleConfigurationConfidence(vehicle = {}) {
  const fields = {
    market: Boolean(String(vehicle.market || '').trim()),
    year: Number.isInteger(Number(vehicle.year)) && Number(vehicle.year) >= 1900,
    make: Boolean(String(vehicle.make || '').trim()),
    model: Boolean(String(vehicle.model || '').trim()),
    trim: Boolean(String(vehicle.trim || '').trim()),
    powertrain: Boolean(String(vehicle.powertrain || vehicle.fuel_type || '').trim()),
    engine: normalizePowertrain(vehicle.powertrain || vehicle.fuel_type) === 'electric'
      ? true
      : Boolean(String(vehicle.engine || '').trim()),
    drivetrain: Boolean(String(vehicle.drivetrain || '').trim()),
  };
  const score = Math.round(Object.values(fields).filter(Boolean).length / Object.keys(fields).length * 100);
  const level = score >= 88 ? 'exact-profile' : score >= 63 ? 'partial-profile' : 'basic-profile';
  return {
    score,
    level,
    fields,
    missing: Object.entries(fields).filter(([, present]) => !present).map(([field]) => field),
  };
}

export function getManufacturerReferenceTemplate(vehicle = {}) {
  const make = normalizeText(vehicle.make);
  const model = normalizeText(vehicle.model).replace(/\s+/g, ' ');
  const powertrain = normalizePowertrain(vehicle.powertrain || vehicle.fuel_type);
  return MANUFACTURER_REFERENCE_TEMPLATES.find((template) => (
    template.make === make && template.model === model && template.powertrains.includes(powertrain)
  )) || null;
}


export function normalizeMaintenanceItem(item = {}, vehicle = {}) {
  const powertrain = normalizePowertrain(vehicle.powertrain || vehicle.fuel_type);
  const sourceType = String(item.source_type || '').trim() || 'legacy_unverified';
  const applicablePowertrains = Array.isArray(item.applicable_powertrains)
    ? item.applicable_powertrains.map(normalizePowertrain)
    : [];
  const applicable = applicablePowertrains.length === 0 || applicablePowertrains.includes(powertrain);
  return {
    id: String(item.id || `service_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    label: String(item.label || 'Maintenance item').trim(),
    interval_km: Math.max(0, Number(item.interval_km) || 0),
    interval_months: Math.max(0, Number(item.interval_months) || 0),
    last_service_km: Math.max(0, Number(item.last_service_km) || 0),
    last_service_date: isoDateOnly(item.last_service_date),
    source_type: sourceType,
    source_id: String(item.source_id || '').trim(),
    source_title: String(item.source_title || vehicle.schedule_source?.title || '').trim(),
    source_url: String(item.source_url || vehicle.schedule_source?.url || '').trim(),
    source_page: String(item.source_page || vehicle.schedule_source?.page || '').trim(),
    source_reviewed_at: isoDateOnly(item.source_reviewed_at || vehicle.schedule_source?.reviewed_at),
    condition_note: String(item.condition_note || '').trim(),
    applicable_powertrains: applicablePowertrains,
    applicable,
    enabled: item.enabled !== false && applicable && sourceType !== 'legacy_unverified',
    confirmed_by_user: item.confirmed_by_user === true || sourceType === 'owner_entered_manufacturer',
    created_from_catalog_version: String(item.created_from_catalog_version || ''),
  };
}

export function buildManufacturerReferenceItems(vehicle = {}) {
  const template = getManufacturerReferenceTemplate(vehicle);
  if (!template) return [];
  const source = getVehicleReferenceSource(template.source_id);
  return template.items.map((item) => normalizeMaintenanceItem({
    ...item,
    source_type: 'manufacturer_reference',
    source_id: template.source_id,
    source_title: source?.title || '',
    source_url: source?.url || '',
    source_reviewed_at: template.reviewed_at,
    condition_note: [item.condition_note, template.applicability_note].filter(Boolean).join(' '),
    confirmed_by_user: false,
    enabled: false,
    created_from_catalog_version: VEHICLE_REFERENCE_CATALOG_VERSION,
  }, vehicle));
}

export function normalizeMaintenanceItems(vehicle = {}) {
  const stored = Array.isArray(vehicle.maintenance_items) ? vehicle.maintenance_items : [];
  if (stored.length) return stored.map((item) => normalizeMaintenanceItem(item, vehicle));
  return buildManufacturerReferenceItems(vehicle);
}

const addMonths = (date, months) => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
};
const daysBetween = (later, earlier) => Math.ceil((later.getTime() - earlier.getTime()) / 86400000);

export function calculateMaintenanceStatus(item, { odometerKm = 0, now = new Date(), vehicle = {} } = {}) {
  const normalized = normalizeMaintenanceItem(item, vehicle);
  const vehicleProfile = /** @type {any} */ (vehicle);
  const hasDistance = normalized.interval_km > 0;
  const hasTime = normalized.interval_months > 0;
  const sourceVerified = VERIFIED_SCHEDULE_SOURCE_TYPES.has(normalized.source_type);
  const sourceConfirmed = normalized.confirmed_by_user ||
    ['manufacturer_manual', 'manufacturer_monitor'].includes(normalized.source_type);
  const remainingKm = hasDistance
    ? Math.round(normalized.last_service_km + normalized.interval_km - Math.max(0, Number(odometerKm) || 0))
    : null;
  const baselineDate = normalized.last_service_date || isoDateOnly(vehicleProfile.in_service_date);
  const baseDate = baselineDate ? new Date(`${baselineDate}T12:00:00`) : null;
  const missingTimeBaseline = hasTime && !baseDate;
  const dueDate = hasTime && baseDate ? addMonths(baseDate, normalized.interval_months) : null;
  const remainingDays = dueDate ? daysBetween(dueDate, now) : null;
  const usable = normalized.enabled && normalized.applicable && sourceVerified &&
    sourceConfirmed && (hasDistance || hasTime) && !missingTimeBaseline;
  const common = {
    ...normalized,
    usable: false,
    baseline_date: baselineDate,
    remaining_km: remainingKm,
    remaining_days: remainingDays,
    due_date: dueDate?.toISOString().slice(0, 10) || '',
  };

  if (!normalized.applicable) return { ...common, status: 'not_applicable' };
  if (normalized.source_type === 'legacy_unverified') return { ...common, status: 'needs_source' };
  if (!sourceConfirmed) return { ...common, status: 'needs_confirmation' };
  if (missingTimeBaseline) return { ...common, status: 'needs_baseline' };
  if (!usable) return { ...common, status: 'needs_source' };

  const distanceDue = remainingKm != null && remainingKm <= 0;
  const timeDue = remainingDays != null && remainingDays <= 0;
  const distanceSoon = remainingKm != null && remainingKm <= Math.max(500, normalized.interval_km * 0.1);
  const timeSoon = remainingDays != null && remainingDays <= 30;
  return {
    ...common,
    usable: true,
    status: distanceDue || timeDue ? 'due' : distanceSoon || timeSoon ? 'soon' : 'ok',
  };
}

export function buildVehicleMaintenancePlan(vehicle = {}, { odometerKm = 0, now = new Date() } = {}) {
  const items = normalizeMaintenanceItems(vehicle)
    .map((item) => calculateMaintenanceStatus(item, { odometerKm, now, vehicle }))
    .filter((item) => item.status !== 'not_applicable');
  const configuredItems = items.filter((item) => item.usable);
  const dueItems = configuredItems.filter((item) => item.status === 'due');
  const soonItems = configuredItems.filter((item) => item.status === 'soon');
  const nextItem = [...configuredItems]
    .filter((item) => item.status !== 'due')
    .sort((a, b) => {
      const aKm = a.remaining_km == null ? Number.POSITIVE_INFINITY : a.remaining_km;
      const bKm = b.remaining_km == null ? Number.POSITIVE_INFINITY : b.remaining_km;
      const aDays = a.remaining_days == null ? Number.POSITIVE_INFINITY : a.remaining_days;
      const bDays = b.remaining_days == null ? Number.POSITIVE_INFINITY : b.remaining_days;
      return Math.min(aKm / 50, aDays) - Math.min(bKm / 50, bDays);
    })[0] || dueItems[0] || null;
  return {
    schema_version: VEHICLE_MAINTENANCE_SCHEMA_VERSION,
    catalog_version: VEHICLE_REFERENCE_CATALOG_VERSION,
    catalog_reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    configured: configuredItems.length > 0,
    confidence: getVehicleConfigurationConfidence(vehicle),
    items,
    configured_items: configuredItems,
    due_items: dueItems,
    soon_items: soonItems,
    next_item: nextItem,
    needs_source_count: items.filter((item) => ['needs_source', 'needs_confirmation', 'needs_baseline'].includes(item.status)).length,
  };
}

export function buildDrivingLoadAdvisory(trips = []) {
  const completed = trips.filter((trip) => trip.status === 'completed');
  const distanceKm = completed.reduce((sum, trip) => sum + (Number(trip.distance_km) || 0), 0);
  const aggressionScores = completed.map((trip) => Number(trip.aggressive_driving_score)).filter(Number.isFinite);
  const engineScores = completed.map((trip) => Number(trip.engine_stress_score)).filter(Number.isFinite);
  const obdSamples = completed.reduce((sum, trip) => sum + (Number(trip.obd_powertrain_sample_count) || 0), 0);
  const harshEvents = completed.reduce((sum, trip) => sum +
    (Number(trip.harsh_brakes_count) || 0) +
    (Number(trip.rapid_accel_count) || 0) +
    (Number(trip.sharp_turns_count) || 0), 0);
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const aggressionScore = mean(aggressionScores);
  const accelerationLoadScore = mean(engineScores);
  const eventRate = distanceKm >= 1 ? harshEvents / distanceKm * 100 : null;
  const evidenceLevel = completed.length >= 10 && distanceKm >= 100
    ? 'established'
    : completed.length >= 3 && distanceKm >= 25 ? 'developing' : 'limited';
  const loadIndex = aggressionScore == null ? null : clamp(100 - aggressionScore, 0, 100);
  return {
    trip_count: completed.length,
    distance_km: Math.round(distanceKm * 10) / 10,
    harsh_event_count: harshEvents,
    events_per_100km: eventRate == null ? null : Math.round(eventRate * 10) / 10,
    acceleration_load_score: accelerationLoadScore == null ? null : Math.round(accelerationLoadScore),
    obd_sample_count: obdSamples,
    source_label: obdSamples > 0 ? 'GPS events with optional OBD refinement' : 'GPS driving-event proxy only',
    evidence_level: evidenceLevel,
    level: loadIndex == null ? 'unavailable' : loadIndex >= 55 ? 'elevated' : loadIndex >= 25 ? 'moderate' : 'lower',
    disclaimer: 'This describes recorded acceleration, braking, and cornering patterns. It does not measure oil condition, tread depth, brake thickness, engine damage, battery health, or remaining component life, and it never changes a manufacturer due date.',
  };
}

export function recordVehicleService(vehicle = {}, itemId, {
  odometerKm = 0,
  servicedAt = new Date(),
  notes = '',
} = {}) {
  const date = isoDateOnly(servicedAt) || new Date().toISOString().slice(0, 10);
  const items = normalizeMaintenanceItems(vehicle).map((item) => (
    String(item.id) === String(itemId)
      ? { ...item, last_service_km: Math.max(0, Math.round(Number(odometerKm) || 0)), last_service_date: date }
      : item
  ));
  const item = items.find((entry) => String(entry.id) === String(itemId));
  const history = Array.isArray(vehicle.service_history) ? vehicle.service_history : [];
  const event = {
    id: `service_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    item_ids: [String(itemId)],
    label: item?.label || 'Maintenance service',
    serviced_at: date,
    odometer_km: Math.max(0, Math.round(Number(odometerKm) || 0)),
    notes: String(notes || '').trim(),
    recorded_at: new Date().toISOString(),
    source: 'owner_recorded',
  };
  return { maintenance_items: items, service_history: [event, ...history].slice(0, 250) };
}
