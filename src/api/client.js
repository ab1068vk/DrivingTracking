export const API_BASE_URL = (import.meta.env.VITE_API_URL || "").trim();

export const REQUEST_TIMEOUT_MS = 20_000;

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

export const getAuthToken = () => {
  try {
    // Auth tokens are intentionally session-scoped so an XSS cannot extract a
    // long-lived credential from localStorage.
    return sessionStorage.getItem("token") || sessionStorage.getItem("access_token");
  } catch {
    return null;
  }
};

const buildUrl = (path, query) => {
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
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * @param {string} path
 * @param {{method?:string,body?:any,headers?:Record<string,string>,query?:Record<string,any>} & RequestInit} options
 */
async function request(path, { method = "GET", body, headers, query, signal, ...options } = {}) {
  const token = getAuthToken();
  const hasBody = body !== undefined && body !== null;

  // Without a timeout a stalled backend never settles, and callers that gate UI on the result
  // (AuthContext gates the whole app shell) leave the user on a loading screen forever.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  timeoutId?.unref?.();
  const abortCallerRequest = () => timeoutController.abort();
  signal?.addEventListener?.("abort", abortCallerRequest);

  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      ...options,
      signal: timeoutController.signal,
      headers: {
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error?.name === "AbortError" && !signal?.aborted) {
      throw new ApiError(`The server did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`, {
        status: 0,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener?.("abort", abortCallerRequest);
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
