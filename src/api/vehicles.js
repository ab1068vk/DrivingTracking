import { API_BASE_URL, apiClient } from "@/api/client";
import { localVehicleRepository } from "@/lib/localVehicleRepository";
import { isNativePlatform } from "@/lib/nativePlatform";

export const shouldUseLocalStore = () => isNativePlatform() || !API_BASE_URL;

const repository = () => (shouldUseLocalStore() ? localVehicleRepository : null);

export const vehicleService = {
  list: ({ sort = "-created_date", limit = 50 } = {}) => {
    const local = repository();
    return local ? local.list({ sort, limit }) : apiClient.get("/vehicles", { query: { sort, limit } });
  },

  create: (vehicle) => {
    const local = repository();
    return local ? local.create(vehicle) : apiClient.post("/vehicles", vehicle);
  },

  update: (id, patch) => {
    const local = repository();
    return local ? local.update(id, patch) : apiClient.patch(`/vehicles/${encodeURIComponent(id)}`, patch);
  },

  delete: (id) => {
    const local = repository();
    return local ? local.delete(id) : apiClient.delete(`/vehicles/${encodeURIComponent(id)}`);
  },

  upsertMany: (vehicles) => {
    const local = repository();
    if (local) return local.upsertMany(vehicles);
    return Promise.all(vehicles.map((vehicle) => (
      vehicle.id
        ? apiClient.patch(`/vehicles/${encodeURIComponent(vehicle.id)}`, vehicle).catch(() => apiClient.post("/vehicles", vehicle))
        : apiClient.post("/vehicles", vehicle)
    )));
  },
};
