import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyThemeMode } from '@/lib/trackingStore';

function createDocumentElement() {
  const classes = new Set();
  return {
    classList: {
      toggle: vi.fn((name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return classes.has(name);
      }),
      contains: (name) => classes.has(name),
    },
    dataset: {},
    style: {},
  };
}

describe('theme mode', () => {
  let documentElement;
  let mediaQueryList;
  let systemThemeListener;

  beforeEach(() => {
    systemThemeListener = null;
    documentElement = createDocumentElement();
    mediaQueryList = {
      matches: false,
      addEventListener: vi.fn((_event, listener) => {
        systemThemeListener = listener;
      }),
      removeEventListener: vi.fn(),
    };

    vi.stubGlobal('document', { documentElement });
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => mediaQueryList),
    });
  });

  afterEach(() => {
    applyThemeMode('light');
    vi.unstubAllGlobals();
  });

  it('updates system theme when prefers-color-scheme changes', () => {
    applyThemeMode('system');

    expect(documentElement.classList.contains('dark')).toBe(false);
    expect(documentElement.dataset.themeMode).toBe('system');
    expect(documentElement.dataset.resolvedTheme).toBe('light');
    expect(documentElement.style.colorScheme).toBe('light');
    expect(mediaQueryList.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    mediaQueryList.matches = true;
    systemThemeListener();

    expect(documentElement.classList.contains('dark')).toBe(true);
    expect(documentElement.dataset.resolvedTheme).toBe('dark');
    expect(documentElement.style.colorScheme).toBe('dark');

    applyThemeMode('light');

    expect(documentElement.classList.contains('dark')).toBe(false);
    expect(documentElement.dataset.themeMode).toBe('light');
    expect(mediaQueryList.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('lets Android and touch CSS follow the resolved theme without mobile selection blanks', () => {
    const mainActivity = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/MainActivity.java', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../../../android/app/src/main/res/values/styles.xml', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

    expect(mainActivity).toContain('MODE_NIGHT_FOLLOW_SYSTEM');
    expect(mainActivity).not.toContain('MODE_NIGHT_NO');
    expect(styles).toContain('Theme.AppCompat.DayNight.NoActionBar');
    expect(css).toContain('@media (hover: none) and (pointer: coarse)');
    expect(css).toContain('-webkit-user-select: none;');
    expect(css).toContain('@media (hover: hover) and (pointer: fine)');
  });
});
