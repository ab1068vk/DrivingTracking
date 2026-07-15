import { getJson, setJson } from '@/lib/mobileStorage';
import { DEFAULT_EV_KWH_PER_100KM } from '@/lib/tripEconomyDefaults';
import {
  normalizeMaintenanceItems,
  normalizePowertrain,
  VEHICLE_MAINTENANCE_SCHEMA_VERSION,
} from '@/lib/vehicleMaintenance';

export const VEHICLES_KEY = 'drivesense_vehicles';
const LEGACY_VEHICLE_ADMIN_FIELDS = ['plate', 'registration_renewal_date', 'insurance_renewal_date'];

const scrubLegacyVehicleAdminFields = (vehicle = {}) => {
  const next = { ...vehicle };
  let changed = false;
  LEGACY_VEHICLE_ADMIN_FIELDS.forEach((field) => {
    if (field in next) {
      delete next[field];
      changed = true;
    }
  });
  return { vehicle: next, changed };
};

const normalizeScheduleSource = (source = {}) => ({
  title: String(source.title || '').trim(),
  url: String(source.url || '').trim(),
  page: String(source.page || '').trim(),
  reviewed_at: String(source.reviewed_at || '').trim(),
});

const normalizeServiceHistory = (history = []) => (Array.isArray(history) ? history : [])
  .filter((event) => event && typeof event === 'object')
  .slice(0, 250)
  .map((event) => ({
    id: String(event.id || 'service_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    item_ids: Array.isArray(event.item_ids) ? event.item_ids.map(String) : [],
    label: String(event.label || 'Maintenance service').trim(),
    serviced_at: String(event.serviced_at || '').slice(0, 10),
    odometer_km: Math.max(0, Number(event.odometer_km) || 0),
    notes: String(event.notes || '').trim(),
    recorded_at: event.recorded_at || new Date().toISOString(),
    source: String(event.source || 'owner_recorded'),
  }));


const normalizeVehicle = (vehicle, { touch = true } = {}) => {
  const powertrain = normalizePowertrain(vehicle.powertrain || vehicle.fuel_type);
  const profile = {
    ...vehicle,
    market: String(vehicle.market || 'CA').trim().toUpperCase(),
    trim: String(vehicle.trim || '').trim(),
    engine: String(vehicle.engine || '').trim(),
    drivetrain: String(vehicle.drivetrain || '').trim(),
    transmission: String(vehicle.transmission || '').trim(),
    powertrain,
  };
  return {
    id: vehicle.id || `vehicle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: String(vehicle.name || '').trim(),
    make: String(vehicle.make || '').trim(),
    model: String(vehicle.model || '').trim(),
    trim: profile.trim,
    year: vehicle.year ? Number(vehicle.year) : '',
    market: profile.market,
    engine: profile.engine,
    drivetrain: profile.drivetrain,
    transmission: profile.transmission,
    powertrain,
    fuel_type: powertrain,
    use_profile: String(vehicle.use_profile || 'normal').trim(),
    in_service_date: String(vehicle.in_service_date || '').slice(0, 10),
    maintenance_monitor: String(vehicle.maintenance_monitor || 'none').trim(),
    color: vehicle.color || '#3b82f6',
    odometer_km: Number(vehicle.odometer_km) || 0,
    odometer_trip_distance_anchor_km: Number(vehicle.odometer_trip_distance_anchor_km) || 0,
    auto_odometer_last_sync_at: vehicle.auto_odometer_last_sync_at || null,
    fuel_efficiency_l_per_100km: Number(vehicle.fuel_efficiency_l_per_100km) || 8.5,
    ev_efficiency_kwh_per_100km: Number(vehicle.ev_efficiency_kwh_per_100km) || DEFAULT_EV_KWH_PER_100KM,
    fuel_price_per_liter: Number(vehicle.fuel_price_per_liter) || 1.65,
    maintenance_reserve_per_km: Number(vehicle.maintenance_reserve_per_km) || 0.08,
    schedule_source: normalizeScheduleSource(vehicle.schedule_source),
    maintenance_items: normalizeMaintenanceItems(profile),
    service_history: normalizeServiceHistory(vehicle.service_history),
    maintenance_schema_version: VEHICLE_MAINTENANCE_SCHEMA_VERSION,
    is_default: Boolean(vehicle.is_default),
    created_date: vehicle.created_date || vehicle.created_at || new Date().toISOString(),
    updated_at: touch ? new Date().toISOString() : (vehicle.updated_at || new Date().toISOString()),
  };
};

const sortVehicles = (vehicles, sort) => {
  const field = sort?.replace('-', '') || 'created_date';
  const dir = sort?.startsWith('-') ? -1 : 1;
  return [...vehicles].sort((a, b) => {
    const av = a[field] || '';
    const bv = b[field] || '';
    return av > bv ? dir : av < bv ? -dir : 0;
  });
};

const ensureOneDefault = (vehicles) => {
  if (!vehicles.length) return [];
  if (vehicles.some((vehicle) => vehicle.is_default)) return vehicles;
  return vehicles.map((vehicle, index) => ({ ...vehicle, is_default: index === 0 }));
};

const readVehicles = async () => {
  const stored = await getJson(VEHICLES_KEY, []);
  let changed = false;
  const scrubbed = (Array.isArray(stored) ? stored : []).map((vehicle) => {
    const result = scrubLegacyVehicleAdminFields(vehicle);
    changed = changed || result.changed;
    const normalized = normalizeVehicle(result.vehicle, { touch: false });
    if (JSON.stringify(normalized) !== JSON.stringify(result.vehicle)) changed = true;
    return normalized;
  });
  const vehicles = ensureOneDefault(scrubbed);
  if (changed) await setJson(VEHICLES_KEY, vehicles);
  return vehicles;
};

const writeVehicles = async (vehicles) => {
  const normalized = ensureOneDefault(vehicles.map((vehicle) => scrubLegacyVehicleAdminFields(vehicle).vehicle));
  await setJson(VEHICLES_KEY, normalized);
  return normalized;
};

export const localVehicleRepository = {
  async list({ sort = '-created_date', limit = 50 } = {}) {
    const vehicles = await readVehicles();
    return sortVehicles(vehicles, sort).slice(0, limit);
  },

  async create(vehicle) {
    const current = await readVehicles();
    const saved = normalizeVehicle({
      ...vehicle,
      is_default: current.length === 0 || vehicle.is_default === true,
    });
    const next = saved.is_default
      ? current.map((item) => ({ ...item, is_default: false }))
      : current;
    await writeVehicles([saved, ...next]);
    return saved;
  },

  async update(id, patch) {
    const current = await readVehicles();
    const existing = current.find((vehicle) => String(vehicle.id) === String(id));
    if (!existing) throw new Error('Vehicle not found');

    const updated = normalizeVehicle({
      ...existing,
      ...patch,
      id: existing.id,
      created_date: existing.created_date,
      updated_at: new Date().toISOString(),
    });
    const next = current.map((vehicle) => {
      if (String(vehicle.id) === String(id)) return updated;
      if (updated.is_default) return { ...vehicle, is_default: false };
      return vehicle;
    });

    await writeVehicles(next);
    return updated;
  },

  async delete(id) {
    const current = await readVehicles();
    await writeVehicles(current.filter((vehicle) => String(vehicle.id) !== String(id)));
    return { success: true };
  },

  async upsertMany(vehicles = []) {
    const current = await readVehicles();
    const incoming = vehicles.filter((vehicle) => vehicle?.name).map(normalizeVehicle);
    const incomingIds = new Set(incoming.map((vehicle) => String(vehicle.id)));
    const merged = [
      ...incoming,
      ...current.filter((vehicle) => !incomingIds.has(String(vehicle.id))),
    ];
    await writeVehicles(merged);
    return incoming;
  },
};
