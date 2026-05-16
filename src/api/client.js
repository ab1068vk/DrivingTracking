export const API_BASE_URL =
  import.meta.env.VITE_API_URL || "http://localhost:5000/api";

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

const getAuthToken = () => {
  try {
    return localStorage.getItem("token") || localStorage.getItem("access_token");
  } catch {
    return null;
  }
};

const buildUrl = (path, query) => {
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
async function request(path, { method = "GET", body, headers, query, ...options } = {}) {
  const token = getAuthToken();
  const hasBody = body !== undefined && body !== null;

  const response = await fetch(buildUrl(path, query), {
    method,
    ...options,
    headers: {
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });

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
