import { normalizeTrustedHttpsEndpoint, parseTrustedOrigins } from "@/lib/externalEndpointTrust";
import { localSettings } from "@/lib/trackingStore";
import { externalServiceAllowed, recordOutboundDataEvent } from "@/lib/privacyControls";

const RAW_API_BASE_URL = (import.meta.env.VITE_API_URL || "").trim();
const TRUSTED_BACKEND_ORIGINS = parseTrustedOrigins(import.meta.env.VITE_TRUSTED_BACKEND_ORIGINS);
export const API_ENDPOINT_CONFIGURED = Boolean(RAW_API_BASE_URL);
export const API_ENDPOINT_TRUST = normalizeTrustedHttpsEndpoint(RAW_API_BASE_URL, {
  label: "Backend API URL",
  allowedOrigins: TRUSTED_BACKEND_ORIGINS,
});
export const API_BASE_URL = API_ENDPOINT_TRUST.ok ? API_ENDPOINT_TRUST.url : "";

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?:number,data?:any,response?:Response}} details
   */
  constructor(message, { status, data, response } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.response = response;
  }
}

export const getAuthToken = () => null;

const buildUrl = (path, query) => {
  if (API_ENDPOINT_CONFIGURED && !API_ENDPOINT_TRUST.ok) {
    throw new ApiError(API_ENDPOINT_TRUST.error || "Backend API URL is not trusted.");
  }
  if (!API_BASE_URL) {
    throw new ApiError("No backend API configured.");
  }
  const normalizedBase = API_BASE_URL.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${normalizedBase}${normalizedPath}`);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      url.searchParams.set(key, String(value));
    });
  }

  return url.toString();
};

const parseJsonSafely = async (response) => {
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    throw new ApiError("Could not read the server response.", {
      status: response.status,
      response,
      data: { parse_error: error?.message || "response_read_failed" },
    });
  }
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    if (response.ok) {
      throw new ApiError("The server returned data Road Sage could not read.", {
        status: response.status,
        response,
        data: { parse_error: error?.message || "invalid_json", preview: text.slice(0, 120) },
      });
    }
    return text.slice(0, 500);
  }
};

/**
 * @param {string} path
 * @param {{method?:string,body?:any,headers?:Record<string,string>,query?:Record<string,any>} & RequestInit} options
 */
async function request(path, { method = "GET", body, headers, query, privacyService = "backend_sync", ...options } = {}) {
  const settings = localSettings.get();
  if (API_ENDPOINT_CONFIGURED && !externalServiceAllowed(settings, privacyService)) {
    throw new ApiError(settings.external_requests_local_only === true
      ? "Local-only mode is on. External requests are disabled."
      : `${privacyService === "calibration_upload" ? "Calibration sharing" : "Backend sync"} is disabled in Privacy settings.`);
  }
  const hasBody = body !== undefined && body !== null;
  let url;
  try {
    url = buildUrl(path, query);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.message || "Could not prepare the request.");
  }

  let response;
  try {
    recordOutboundDataEvent({
      service: privacyService,
      status: "used",
      destination: new URL(url).origin,
      detail: `${method} ${path}`,
    }).catch(() => {});
    response = await fetch(url, {
      method,
      credentials: "include",
      ...options,
      headers: {
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError("Network request failed. Check your connection and try again.", {
      data: { original_error: error?.message || "fetch_failed" },
    });
  }

  const data = await parseJsonSafely(response);

  if (!response.ok) {
    const message =
      (data && typeof data === "object" && (data.message || data.error)) ||
      response.statusText ||
      "Request failed";

    throw new ApiError(message, {
      status: response.status,
      data,
      response,
    });
  }

  return data;
}

export const apiClient = {
  get: (path, options) => request(path, { ...options, method: "GET" }),
  post: (path, body, options) => request(path, { ...options, method: "POST", body }),
  put: (path, body, options) => request(path, { ...options, method: "PUT", body }),
  patch: (path, body, options) => request(path, { ...options, method: "PATCH", body }),
  delete: (path, options) => request(path, { ...options, method: "DELETE" }),
};
