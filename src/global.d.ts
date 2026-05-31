interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_API_URL?: string;
  readonly VITE_DB_NAME?: string;
  readonly VITE_DEFAULT_MAP_LAT?: string;
  readonly VITE_DEFAULT_MAP_LNG?: string;
  readonly VITE_DEFAULT_OSRM_URL?: string;
  readonly VITE_OSRM_TIMEOUT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  L?: any;
  __roadSageErrorReportingInitialized?: boolean;
}

declare module '@capacitor/app' {
  export const App: any;
}
