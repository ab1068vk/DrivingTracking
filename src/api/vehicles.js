import { apiClient } from "@/api/client";

// TODO: Implement these routes in your backend: /vehicles and /vehicles/:id.
export const vehicleService = {
  list: ({ sort = "-created_date", limit = 50 } = {}) =>
    apiClient.get("/vehicles", { query: { sort, limit } }),

  create: (vehicle) => apiClient.post("/vehicles", vehicle),

  update: (id, patch) => apiClient.patch(`/vehicles/${encodeURIComponent(id)}`, patch),

  delete: (id) => apiClient.delete(`/vehicles/${encodeURIComponent(id)}`),
};
