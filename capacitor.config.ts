import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.drivesense.app',
  appName: 'Road Sage',
  webDir: 'dist',
  android: {
    useLegacyBridge: true,
    loggingBehavior: 'none',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_drivesense',
      iconColor: '#0F766E',
    },
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#0F172A',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
  },
};

export default config;
