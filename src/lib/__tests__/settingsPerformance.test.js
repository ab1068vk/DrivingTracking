import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('../../pages/Settings.jsx', import.meta.url), 'utf8');
const hookSource = readFileSync(new URL('../../hooks/useLocalSettings.jsx', import.meta.url), 'utf8');

describe('Settings interaction performance contracts', () => {
  it('uses one external-store subscription with selector equality', () => {
    expect(hookSource).toContain('useSyncExternalStore');
    expect(hookSource).toContain('useLocalSettingSelector');
    expect(hookSource).toContain('equalityRef.current(selectedRef.current, selected)');
    expect(hookSource).not.toContain('JSON.stringify(current) === JSON.stringify(next)');
  });

  it('paints toggles and checkboxes before invoking persistence handlers', () => {
    expect(settingsSource).toContain('runAfterVisiblePaint');
    expect(settingsSource).toContain('setOptimisticValue(next)');
    expect(settingsSource).toContain('setOptimisticChecked(value)');
    expect(settingsSource).toContain('settingsPersistenceQueueRef');
    expect(settingsSource).toContain('localSettings.update(patch)');
  });

  it('lazy-renders inactive settings sections and gates heavy work', () => {
    expect(settingsSource).toContain("{typeof children === 'function' ? children() : children}");
    expect(settingsSource).toContain("enabled: activeSettingsSection === 'settings-detection-thresholds'");
    expect(settingsSource).toContain("if (activeSettingsSection !== 'settings-privacy-data') return;");
    expect(settingsSource).not.toContain('setInterval(refreshAndRestartIfReady');
    expect(settingsSource).not.toContain('tripSummaryQueryOptions');
    expect(settingsSource).not.toContain('listAllSummaries');
  });
});
