import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestAppAlert, requestAppConfirm } from '@/lib/appDialog';

// AppDialogHost itself needs a DOM, but the imperative request API is what the
// rest of the app calls, and its fallback path is a security-relevant default:
// with no host mounted it must never silently answer "yes" to a confirm.
describe('requestAppConfirm without a mounted host', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to window.confirm and reports the user answer', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('window', { confirm });

    await expect(requestAppConfirm('Delete this trip?')).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('returns false when the user cancels', async () => {
    vi.stubGlobal('window', { confirm: () => false });

    await expect(requestAppConfirm('Delete this trip?')).resolves.toBe(false);
  });

  it('denies the action when no confirm mechanism exists at all', async () => {
    vi.stubGlobal('window', {});

    await expect(requestAppConfirm('Delete everything?')).resolves.toBe(false);
  });

  it('includes the title and message in the fallback prompt text', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('window', { confirm });

    await requestAppConfirm({ title: 'Erase data', message: 'This cannot be undone.' });

    const shown = confirm.mock.calls[0][0];
    expect(shown).toContain('Erase data');
    expect(shown).toContain('This cannot be undone.');
  });

  it('requires an exact typed phrase when requiredText is set', async () => {
    const prompt = vi.fn(() => 'DELETE');
    vi.stubGlobal('window', { prompt, confirm: () => true });

    await expect(requestAppConfirm({ message: 'Erase all trips', requiredText: 'DELETE' }))
      .resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('rejects a near-miss typed phrase instead of accepting it', async () => {
    vi.stubGlobal('window', { prompt: () => 'delete', confirm: () => true });

    await expect(requestAppConfirm({ message: 'Erase all trips', requiredText: 'DELETE' }))
      .resolves.toBe(false);
  });

  it('rejects a cancelled prompt', async () => {
    vi.stubGlobal('window', { prompt: () => null, confirm: () => true });

    await expect(requestAppConfirm({ message: 'Erase all trips', requiredText: 'DELETE' }))
      .resolves.toBe(false);
  });

  it('does not fall back to plain confirm when a typed phrase is required', async () => {
    // Without window.prompt the guarded action must fail closed rather than
    // downgrading to a single OK click.
    const confirm = vi.fn(() => true);
    vi.stubGlobal('window', { confirm });

    await expect(requestAppConfirm({ message: 'Erase all trips', requiredText: 'DELETE' }))
      .resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('requestAppAlert without a mounted host', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the message through window.alert and resolves', async () => {
    const alert = vi.fn();
    vi.stubGlobal('window', { alert });

    await expect(requestAppAlert('Export finished')).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toContain('Export finished');
  });

  it('still resolves when no alert mechanism exists, so callers never hang', async () => {
    vi.stubGlobal('window', {});

    await expect(requestAppAlert('Export finished')).resolves.toBeUndefined();
  });

  it('accepts a string shorthand and an options object alike', async () => {
    const alert = vi.fn();
    vi.stubGlobal('window', { alert });

    await requestAppAlert('plain string');
    await requestAppAlert({ title: 'Heads up', message: 'Configured message' });

    expect(alert.mock.calls[0][0]).toContain('plain string');
    expect(alert.mock.calls[1][0]).toContain('Heads up');
    expect(alert.mock.calls[1][0]).toContain('Configured message');
  });
});
