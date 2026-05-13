import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.drivesense.app',
  appName: 'DriveSense',
  webDir: 'dist',
  android: {
    useLegacyBridge: true,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_drivesense',
      iconColor: '#2563EB',
    },
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#2563EB',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
  },
};

export default config;
