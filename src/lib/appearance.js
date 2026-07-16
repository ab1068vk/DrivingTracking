// @ts-check

export const PREMIUM_VISUAL_EXPERIENCE_KEY = 'road_sage_premium_visual_experience';
export const SETTINGS_STORAGE_KEY = 'drivesense_settings';

export const APPEARANCE_MODES = Object.freeze({
  STANDARD: 'standard',
  PREMIUM: 'premium',
});

export function isPremiumVisualExperience(settingsOrValue = false) {
  if (typeof settingsOrValue === 'boolean') return settingsOrValue;
  return settingsOrValue?.[PREMIUM_VISUAL_EXPERIENCE_KEY] === true;
}

export function getAppearanceMode(settingsOrValue = false) {
  return isPremiumVisualExperience(settingsOrValue)
    ? APPEARANCE_MODES.PREMIUM
    : APPEARANCE_MODES.STANDARD;
}

export function applyAppearanceMode(settingsOrValue = false, root = globalThis.document?.documentElement) {
  const mode = getAppearanceMode(settingsOrValue);
  if (!root) return mode;

  const premium = mode === APPEARANCE_MODES.PREMIUM;
  root.classList?.toggle('premium-visual', premium);
  if (root.dataset) {
    root.dataset.appearanceMode = mode;
    root.dataset.premiumVisualExperience = String(premium);
  }
  if (premium && root.style) root.style.colorScheme = 'dark';
  return mode;
}

export function readStoredAppearance(storage = globalThis.localStorage) {
  try {
    if (!storage) return APPEARANCE_MODES.STANDARD;
    const directValue = storage.getItem(PREMIUM_VISUAL_EXPERIENCE_KEY);
    if (directValue === 'true') return APPEARANCE_MODES.PREMIUM;
    if (directValue === 'false') return APPEARANCE_MODES.STANDARD;

    const rawSettings = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!rawSettings) return APPEARANCE_MODES.STANDARD;
    return getAppearanceMode(JSON.parse(rawSettings));
  } catch {
    return APPEARANCE_MODES.STANDARD;
  }
}

