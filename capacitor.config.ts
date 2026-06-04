import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.roadsage.app',
  appName: 'Road Sage',
  webDir: 'dist',
  loggingBehavior: 'none',
  includePlugins: [
    '@capacitor/app',
    '@capacitor/filesystem',
    '@capacitor/geolocation',
    '@capacitor/local-notifications',
    '@capacitor/splash-screen',
    '@capacitor-community/background-geolocation',
  ],
  android: {
    webContentsDebuggingEnabled: false,
    useLegacyBridge: false,
    includePlugins: [
      '@capacitor/app',
      '@capacitor/filesystem',
      '@capacitor/geolocation',
      '@capacitor/local-notifications',
      '@capacitor/splash-screen',
      '@capacitor-community/background-geolocation',
    ],
  },
  server: {
    allowNavigation: [],
  },
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
    BiometricGate: {},
    SecureKey: {},
    SecureClipboard: {},
    PlayIntegrity: {},
    EncryptedCapacitorPlugin: {},
    DriveSenseActivityRecognition: {},
    LocalNotifications: {
      smallIcon: 'ic_stat_drivesense',
      iconColor: '#0F766E',
    },
    SplashScreen: {
      launchShowDuration: 350,
      backgroundColor: '#0F172A',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
  },
};

export default config;
