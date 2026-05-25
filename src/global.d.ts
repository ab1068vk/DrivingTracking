interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_API_URL?: string;
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
