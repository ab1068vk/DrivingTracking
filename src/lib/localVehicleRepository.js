import { getJson, setJson } from '@/lib/mobileStorage';
import { DEFAULT_EV_KWH_PER_100KM, DEFAULT_MAINTENANCE_ITEMS } from '@/lib/tripInsights';

const VEHICLES_KEY = 'road_sage_vehicles';

const mergeMaintenanceItems = (items = []) => {
  const byId = new Map((Array.isArray(items) ? items : []).map((item) => [item.id, item]));
  return DEFAULT_MAINTENANCE_ITEMS.map((item) => ({
    ...item,
    ...(byId.get(item.id) || {}),
  }));
};

const normalizeVehicle = (vehicle) => ({
  id: vehicle.id || `vehicle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  name: String(vehicle.name || '').trim(),
  make: String(vehicle.make || '').trim(),
  model: String(vehicle.model || '').trim(),
  year: vehicle.year ? Number(vehicle.year) : '',
  color: vehicle.color || '#3b82f6',
  plate: String(vehicle.plate || '').trim().toUpperCase(),
  odometer_km: Number(vehicle.odometer_km) || 0,
  odometer_trip_distance_anchor_km: Number(vehicle.odometer_trip_distance_anchor_km) || 0,
  auto_odometer_last_sync_at: vehicle.auto_odometer_last_sync_at || null,
  fuel_type: String(vehicle.fuel_type || 'gasoline').trim().toLowerCase(),
  fuel_efficiency_l_per_100km: Number(vehicle.fuel_efficiency_l_per_100km) || 8.5,
  ev_efficiency_kwh_per_100km: Number(vehicle.ev_efficiency_kwh_per_100km) || DEFAULT_EV_KWH_PER_100KM,
  fuel_price_per_liter: Number(vehicle.fuel_price_per_liter) || 1.65,
  maintenance_reserve_per_km: Number(vehicle.maintenance_reserve_per_km) || 0.08,
  registration_renewal_date: vehicle.registration_renewal_date || '',
  insurance_renewal_date: vehicle.insurance_renewal_date || '',
  maintenance_items: mergeMaintenanceItems(vehicle.maintenance_items),
  is_default: Boolean(vehicle.is_default),
  created_date: vehicle.created_date || vehicle.created_at || new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

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

const readVehicles = async () => ensureOneDefault(await getJson(VEHICLES_KEY, []));

const writeVehicles = async (vehicles) => {
  const normalized = ensureOneDefault(vehicles);
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

    const updated = normalizeVehicle({ ...existing, ...patch, id: existing.id, created_date: existing.created_date });
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
