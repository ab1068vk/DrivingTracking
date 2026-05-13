import { apiClient } from "@/api/client";

// TODO: Implement these routes in your backend: /trips and /trips/:id.
export const tripService = {
  list: ({ sort = "-start_time", limit = 100 } = {}) =>
    apiClient.get("/trips", { query: { sort, limit } }),

  getById: (id) => apiClient.get(`/trips/${encodeURIComponent(id)}`),

  create: (trip) => apiClient.post("/trips", trip),

  update: (id, patch) => apiClient.patch(`/trips/${encodeURIComponent(id)}`, patch),

  delete: (id) => apiClient.delete(`/trips/${encodeURIComponent(id)}`),
};
