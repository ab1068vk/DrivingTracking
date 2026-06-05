import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, localSettings } from '@/lib/trackingStore';

const SETTINGS_KEY = 'drivesense_settings';
const ANDROID_APP_ID = 'com.drivesense.app';

function makeMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
  };
}

const readProjectFile = (relativePath) => (
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
);

describe('recovery compatibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('persists settings under the established key and restores them on the next read', () => {
    const storage = makeMemoryStorage();
    vi.stubGlobal('localStorage', storage);

    const saved = {
      ...DEFAULT_SETTINGS,
      dark_mode: 'dark',
      units: 'imperial',
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    };

    localSettings.set(saved);
    saved.dark_mode = 'light';

    const restored = localSettings.get();
    expect(storage.setItem).toHaveBeenCalledWith(SETTINGS_KEY, expect.any(String));
    expect(restored).toMatchObject({
      dark_mode: 'dark',
      units: 'imperial',
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    });
  });

  it('keeps updates after a fresh storage-backed read', () => {
    const storage = makeMemoryStorage({
      [SETTINGS_KEY]: JSON.stringify(DEFAULT_SETTINGS),
    });
    vi.stubGlobal('localStorage', storage);

    localSettings.update({
      dark_mode: 'dark',
      safe_driving_reminder: true,
    });

    expect(localSettings.get()).toMatchObject({
      dark_mode: 'dark',
      safe_driving_reminder: true,
    });
  });

  it('keeps Android identity and the native tile on the same settings record', () => {
    const capacitor = readProjectFile('capacitor.config.ts');
    const gradle = readProjectFile('android/app/build.gradle');
    const manifest = readProjectFile('android/app/src/main/AndroidManifest.xml');
    const backupRules = readProjectFile('android/app/src/main/res/xml/backup_rules.xml');
    const dataExtractionRules = readProjectFile('android/app/src/main/res/xml/data_extraction_rules.xml');
    const mainActivity = readProjectFile(
      'android/app/src/main/java/com/drivesense/app/MainActivity.java'
    );
    const tile = readProjectFile(
      'android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingTileService.java'
    );
    const trackingStore = readProjectFile('src/lib/trackingStore.js');

    expect(capacitor).toContain(`appId: '${ANDROID_APP_ID}'`);
    expect(gradle).toContain(`namespace = "${ANDROID_APP_ID}"`);
    expect(gradle).toContain(`applicationId "${ANDROID_APP_ID}"`);
    const versionCode = Number(gradle.match(/versionCode\s*=\s*(\d+)\b/)?.[1]);
    expect(versionCode).toBeGreaterThanOrEqual(2);
    expect(mainActivity).toContain(`package ${ANDROID_APP_ID};`);
    expect(tile).toContain(`private static final String SETTINGS_KEY = "${SETTINGS_KEY}"`);
    expect(trackingStore).toContain(`const SETTINGS_KEY = '${SETTINGS_KEY}'`);
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"');
    expect(backupRules).toContain('<exclude domain="sharedpref" path="drivesense_native_tracking.xml"/>');
    expect(backupRules).toContain('<exclude domain="sharedpref" path="CapacitorStorage.xml"/>');
    expect(dataExtractionRules).toContain('<cloud-backup>');
    expect(dataExtractionRules).toContain('<device-transfer>');
  });
});
