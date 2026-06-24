interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_API_URL?: string;
  readonly VITE_DB_NAME?: string;
  readonly VITE_DEFAULT_MAP_LAT?: string;
  readonly VITE_DEFAULT_MAP_LNG?: string;
  readonly VITE_DEFAULT_OSRM_URL?: string;
  readonly VITE_OSRM_TIMEOUT_MS?: string;
  readonly VITE_SHOW_DEBUG_ROUTES?: string;
  readonly VITE_TRIAGE_DISABLE_MAPS?: string;
  readonly VITE_TRIAGE_DASHBOARD_LIMITED_SUMMARIES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  L?: any;
  __roadSageErrorReportingInitialized?: boolean;
  __PERF_TRIAGE__?: any[];
}

declare module '@capacitor/app' {
  export const App: any;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}
