import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('../../pages/Settings.jsx', import.meta.url), 'utf8');
const reportsSource = readFileSync(new URL('../../pages/TrackingReportsLab.jsx', import.meta.url), 'utf8');

describe('HPR-B2 visible authority-aware routes', () => {
  it('routes Settings export and import through one capability decision', () => {
    expect(settingsSource).toContain('resolveBackupCapabilities');
    expect(settingsSource).toContain('backupCapabilities.browserJsonExportAvailable');
    expect(settingsSource).toContain('backupCapabilities.nativeUriRestoreAvailable');
    expect(settingsSource).toContain('restoreNativeBackupFromDocumentFromSettings');
  });

  it('does not expose readable JSON when the active authority lacks it', () => {
    expect(settingsSource).toContain('backupCapabilities.readableExportAvailable &&');
    expect(settingsSource).toContain("requireSensitiveAuthentication('Verify to export a readable backup')");
  });

  it('does not leave Tracking Reports Lab as an authority bypass', () => {
    expect(reportsSource).toContain('resolveBackupCapabilities');
    expect(reportsSource).toContain('backupCapabilities.browserJsonExportAvailable');
    expect(reportsSource).not.toContain("import('@/lib/dataBackup')");
    expect(reportsSource).not.toContain('Signed backup export');
    expect(reportsSource).toContain('Use Settings for encrypted');
  });
});
