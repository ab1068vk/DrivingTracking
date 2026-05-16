interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  L?: any;
}

declare module '@capacitor/app' {
  export const App: any;
}
