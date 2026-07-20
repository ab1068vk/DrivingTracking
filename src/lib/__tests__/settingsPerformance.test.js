import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('../../pages/Settings.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const hookSource = readFileSync(new URL('../../hooks/useLocalSettings.jsx', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('../../components/ui/dialog.jsx', import.meta.url), 'utf8');
const alertDialogSource = readFileSync(new URL('../../components/ui/alert-dialog.jsx', import.meta.url), 'utf8');
const appDialogSource = readFileSync(new URL('../appDialog.jsx', import.meta.url), 'utf8');

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

  it('locks expensive dialog actions before yielding to authentication or storage work', () => {
    expect(settingsSource).toContain('dialogActionLocksRef');
    expect(settingsSource).toContain("lockDialogAction('rescore')");
    expect(settingsSource).toContain("lockDialogAction('privacy-delete')");
    expect(settingsSource).toContain("lockDialogAction('privacy-save')");
    expect(settingsSource).toContain("lockDialogAction('backup-export')");
    expect(settingsSource).toContain("lockDialogAction('backup-import')");
    expect(settingsSource).toContain("lockDialogAction('delete-all-trips')");
    expect(settingsSource).toContain("lockDialogAction('erase-all-local-data')");
    expect(settingsSource).toContain("lockDialogAction('trip-retention')");
    expect(settingsSource).toContain("lockDialogAction('raw-gps-retention')");
    expect(settingsSource).toContain('setPrivacyDeleteBusy(true);\n    await yieldToPaint();');
    expect(settingsSource).toContain('window.requestAnimationFrame(() => {\n      window.requestAnimationFrame(() => resolve());');
  });

  it('makes actionable setting rows keyboard-safe and truly disableable', () => {
    expect(settingsSource).toContain("role={actionable ? 'button' : undefined}");
    expect(settingsSource).toContain('tabIndex={actionable && !disabled ? 0 : undefined}');
    expect(settingsSource).toContain('aria-disabled={actionable && disabled ? true : undefined}');
    expect(settingsSource).toContain("event.key !== 'Enter' && event.key !== ' '");
    expect(settingsSource).toContain('disabled={tripDeleteBusy}');
    expect(settingsSource).toContain('disabled={erasureBusy}');
    expect(settingsSource).toContain('tripDeleteProgress.percent');
    expect(settingsSource).toContain('erasureProgress.percent');
    expect(settingsSource).toContain('Erasure cannot be cancelled safely after it starts.');
  });

  it('keeps shared dialogs inexpensive and touch-friendly', () => {
    expect(dialogSource).not.toContain('backdrop-blur');
    expect(alertDialogSource).not.toContain('backdrop-blur');
    expect(dialogSource).toContain('max-h-[calc(100dvh-1rem)]');
    expect(alertDialogSource).toContain('max-h-[calc(100dvh-1rem)]');
    expect(dialogSource).toContain('[&>button]:min-h-11');
    expect(alertDialogSource).toContain('[&>button]:min-h-11');
    expect(dialogSource).toContain('data-app-dialog-content="true"');
    expect(dialogSource).toContain('data-app-dialog-close="true"');
    expect(alertDialogSource).toContain('data-app-dialog-content="true"');
    expect(readFileSync(new URL('../../index.css', import.meta.url), 'utf8')).toContain('position: fixed !important;');
  });

  it('settles app confirmations only once during rapid taps', () => {
    expect(appDialogSource).toContain('settlingRef.current');
    expect(appDialogSource).toContain('if (!current || settlingRef.current) return;');
  });
});
