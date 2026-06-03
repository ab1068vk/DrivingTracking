interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_API_URL?: string;
  readonly VITE_DB_NAME?: string;
  readonly VITE_DEFAULT_MAP_LAT?: string;
  readonly VITE_DEFAULT_MAP_LNG?: string;
  readonly VITE_DEFAULT_OSRM_URL?: string;
  readonly VITE_OSRM_TIMEOUT_MS?: string;
  readonly VITE_TRUSTED_BACKEND_ORIGINS?: string;
  readonly VITE_TRUSTED_OSRM_ORIGINS?: string;
  readonly VITE_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;

interface Window {
  L?: any;
  __roadSageErrorReportingInitialized?: boolean;
}

declare module '@capacitor/app' {
  export const App: any;
}
