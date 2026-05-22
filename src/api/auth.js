import { apiClient } from "@/api/client";

const AUTH_STORAGE_KEYS = ["token", "access_token"];

export const migrateLegacyAuthTokens = () => {
  try {
    AUTH_STORAGE_KEYS.forEach((key) => {
      const legacyToken = localStorage.getItem(key);
      if (legacyToken && !sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, legacyToken);
      }
      localStorage.removeItem(key);
    });
  } catch {
    // Storage can be unavailable in hardened browser modes.
  }
};

// TODO: Implement /auth/me and a matching login flow if you want cloud auth.
export const authService = {
  me: () => apiClient.get("/auth/me"),

  logout: () => {
    AUTH_STORAGE_KEYS.forEach((key) => {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    });
  },

  redirectToLogin: (returnTo = window.location.href) => {
    // TODO: Replace with your backend login route when authentication is implemented.
    const loginUrl = new URL("/login", window.location.origin);
    loginUrl.searchParams.set("returnTo", returnTo);
    window.location.assign(loginUrl.toString());
  },
};
