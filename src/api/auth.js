import { apiClient } from "@/api/client";

const AUTH_STORAGE_KEYS = ["token", "access_token"];
let legacyAuthTokensCleared = false;

export const migrateLegacyAuthTokens = () => {
  AUTH_STORAGE_KEYS.forEach((key) => {
    try {
      const legacyToken = localStorage.getItem(key);
      if (!legacyToken) return;

      localStorage.removeItem(key);
      legacyAuthTokensCleared = true;
    } catch {
      // Storage can be unavailable in hardened browser modes.
    }
  });
};

export const consumeLegacyAuthTokenMigration = () => {
  const cleared = legacyAuthTokensCleared;
  legacyAuthTokensCleared = false;
  return cleared;
};

// The optional backend should set an httpOnly, Secure, SameSite=Strict cookie
// from POST /auth/token. The frontend intentionally never stores bearer tokens.
export const authService = {
  exchangeTokenForCookie: (token) => apiClient.post("/auth/token", { token }),

  me: (options) => apiClient.get("/auth/me", options),

  logout: () => {
    AUTH_STORAGE_KEYS.forEach((key) => {
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
