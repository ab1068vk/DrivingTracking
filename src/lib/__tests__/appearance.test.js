import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_MODES,
  PREMIUM_VISUAL_EXPERIENCE_KEY,
  SETTINGS_STORAGE_KEY,
  applyAppearanceMode,
  getAppearanceMode,
  isPremiumVisualExperience,
  readStoredAppearance,
} from '@/lib/appearance';

const fakeRoot = () => {
  const classes = new Set();
  return {
    dataset: {},
    style: {},
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      has: (name) => classes.has(name),
    },
  };
};

const fakeStorage = (entries = {}) => ({
  getItem: (key) => (key in entries ? entries[key] : null),
});

describe('isPremiumVisualExperience', () => {
  it('accepts a bare boolean as the answer', () => {
    expect(isPremiumVisualExperience(true)).toBe(true);
    expect(isPremiumVisualExperience(false)).toBe(false);
  });

  it('reads the flag out of a settings object', () => {
    expect(isPremiumVisualExperience({ [PREMIUM_VISUAL_EXPERIENCE_KEY]: true })).toBe(true);
    expect(isPremiumVisualExperience({ [PREMIUM_VISUAL_EXPERIENCE_KEY]: false })).toBe(false);
  });

  it('requires strict true, so truthy junk does not enable premium', () => {
    for (const value of ['true', 1, {}, [], 'yes']) {
      expect(isPremiumVisualExperience({ [PREMIUM_VISUAL_EXPERIENCE_KEY]: value })).toBe(false);
    }
  });

  it('defaults to standard for missing or malformed input', () => {
    expect(isPremiumVisualExperience()).toBe(false);
    expect(isPremiumVisualExperience(null)).toBe(false);
    expect(isPremiumVisualExperience({})).toBe(false);
  });
});

describe('getAppearanceMode', () => {
  it('maps the flag onto the named modes', () => {
    expect(getAppearanceMode({ [PREMIUM_VISUAL_EXPERIENCE_KEY]: true })).toBe(APPEARANCE_MODES.PREMIUM);
    expect(getAppearanceMode({})).toBe(APPEARANCE_MODES.STANDARD);
  });
});

describe('applyAppearanceMode', () => {
  it('marks the root element for premium and forces the dark colour scheme', () => {
    const root = fakeRoot();

    expect(applyAppearanceMode(true, root)).toBe(APPEARANCE_MODES.PREMIUM);
    expect(root.classList.has('premium-visual')).toBe(true);
    expect(root.dataset.appearanceMode).toBe(APPEARANCE_MODES.PREMIUM);
    expect(root.dataset.premiumVisualExperience).toBe('true');
    expect(root.style.colorScheme).toBe('dark');
  });

  it('removes the premium marker when switching back to standard', () => {
    const root = fakeRoot();
    applyAppearanceMode(true, root);
    applyAppearanceMode(false, root);

    expect(root.classList.has('premium-visual')).toBe(false);
    expect(root.dataset.appearanceMode).toBe(APPEARANCE_MODES.STANDARD);
    expect(root.dataset.premiumVisualExperience).toBe('false');
  });

  it('does not force a colour scheme for standard mode', () => {
    const root = fakeRoot();
    applyAppearanceMode(false, root);

    expect(root.style.colorScheme).toBeUndefined();
  });

  it('still reports the mode when there is no root element to style', () => {
    expect(applyAppearanceMode(true, null)).toBe(APPEARANCE_MODES.PREMIUM);
    expect(applyAppearanceMode(false, undefined)).toBe(APPEARANCE_MODES.STANDARD);
  });
});

describe('readStoredAppearance', () => {
  it('prefers the dedicated key over the settings blob', () => {
    const storage = fakeStorage({
      [PREMIUM_VISUAL_EXPERIENCE_KEY]: 'true',
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ [PREMIUM_VISUAL_EXPERIENCE_KEY]: false }),
    });

    expect(readStoredAppearance(storage)).toBe(APPEARANCE_MODES.PREMIUM);
  });

  it('honours an explicit false on the dedicated key', () => {
    const storage = fakeStorage({
      [PREMIUM_VISUAL_EXPERIENCE_KEY]: 'false',
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ [PREMIUM_VISUAL_EXPERIENCE_KEY]: true }),
    });

    expect(readStoredAppearance(storage)).toBe(APPEARANCE_MODES.STANDARD);
  });

  it('falls back to the settings blob when the dedicated key is absent', () => {
    const storage = fakeStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({ [PREMIUM_VISUAL_EXPERIENCE_KEY]: true }),
    });

    expect(readStoredAppearance(storage)).toBe(APPEARANCE_MODES.PREMIUM);
  });

  it('returns standard for corrupt stored settings instead of throwing', () => {
    expect(readStoredAppearance(fakeStorage({ [SETTINGS_STORAGE_KEY]: '{not json' })))
      .toBe(APPEARANCE_MODES.STANDARD);
  });

  it('returns standard when storage is missing or throws', () => {
    expect(readStoredAppearance(null)).toBe(APPEARANCE_MODES.STANDARD);
    expect(readStoredAppearance({
      getItem: () => { throw new Error('storage disabled'); },
    })).toBe(APPEARANCE_MODES.STANDARD);
  });

  it('returns standard for an empty storage', () => {
    expect(readStoredAppearance(fakeStorage())).toBe(APPEARANCE_MODES.STANDARD);
  });
});
