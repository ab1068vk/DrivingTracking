import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const files = {
  capacitor: read('capacitor.config.ts'),
  gradle: read('android/app/build.gradle'),
  mainActivity: read('android/app/src/main/java/com/drivesense/app/MainActivity.java'),
  tile: read('android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingTileService.java'),
  trackingStore: read('src/lib/trackingStore.js'),
  backup: read('src/lib/dataBackup.js'),
};

const failures = [];
const requireMatch = (name, content, pattern, message) => {
  if (!pattern.test(content)) failures.push(`${name}: ${message}`);
};

requireMatch(
  'Capacitor',
  files.capacitor,
  /appId:\s*['"]com\.drivesense\.app['"]/,
  'appId must remain com.drivesense.app so Android upgrades preserve app data and permissions.'
);
requireMatch(
  'Gradle',
  files.gradle,
  /namespace\s*=\s*["']com\.drivesense\.app["']/,
  'namespace must remain com.drivesense.app.'
);
requireMatch(
  'Gradle',
  files.gradle,
  /applicationId\s+["']com\.drivesense\.app["']/,
  'applicationId must remain com.drivesense.app.'
);
const versionCodeMatch = files.gradle.match(/versionCode\s*=\s*(\d+)\b/);
if (!versionCodeMatch || Number(versionCodeMatch[1]) < 2) {
  failures.push('Gradle: versionCode must remain at least the verified recovery release value of 2.');
}
requireMatch(
  'MainActivity',
  files.mainActivity,
  /^package com\.drivesense\.app;/m,
  'native package must remain com.drivesense.app.'
);
requireMatch(
  'Web settings',
  files.trackingStore,
  /const SETTINGS_KEY\s*=\s*['"]drivesense_settings['"]/,
  'web settings must continue using drivesense_settings.'
);
requireMatch(
  'Quick Settings tile',
  files.tile,
  /private static final String SETTINGS_KEY\s*=\s*["']drivesense_settings["']/,
  'the tile must read and write the same drivesense_settings record as the web app.'
);
requireMatch(
  'Backup import',
  files.backup,
  /export const BACKUP_VERSION\s*=\s*7\s*;/,
  'backup version changed; add explicit forward/backward migration tests before updating this contract.'
);
requireMatch(
  'Backup import',
  files.backup,
  /sourceVersion\s*>\s*BACKUP_VERSION/,
  'newer backup versions must be rejected explicitly instead of partially importing.'
);

for (const [name, content] of Object.entries({
  Capacitor: files.capacitor,
  Gradle: files.gradle,
  MainActivity: files.mainActivity,
  'Quick Settings tile': files.tile,
})) {
  if (/com\.roadsage\.app/.test(content)) {
    failures.push(`${name}: com.roadsage.app must not be used as the Android package identity.`);
  }
}

if (/road_sage_settings/.test(files.trackingStore) || /road_sage_settings/.test(files.tile)) {
  failures.push('Settings: do not rename drivesense_settings without a tested in-place migration.');
}

if (failures.length > 0) {
  console.error('Recovery compatibility contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Recovery compatibility contract passed.');
