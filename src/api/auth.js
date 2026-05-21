import { apiClient } from "@/api/client";

// TODO: Implement /auth/me and a matching login flow if you want cloud auth.
export const authService = {
  me: () => apiClient.get("/auth/me"),

  logout: () => {
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("access_token");
    localStorage.removeItem("token");
    localStorage.removeItem("access_token");
  },

  redirectToLogin: (returnTo = window.location.href) => {
    // TODO: Replace with your backend login route when authentication is implemented.
    const loginUrl = new URL("/login", window.location.origin);
    loginUrl.searchParams.set("returnTo", returnTo);
    window.location.assign(loginUrl.toString());
  },
};
