// @ts-check
// Identity and lifecycle of a saved road section, extracted verbatim from
// src/pages/SpeedLimits.jsx.

export const correctionKey = (correction = {}) => correction?.id || correction?.ruleId || correction?.sectionKey || correction?.geohash;
export const IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY = 'roadsage_ignored_unset_speed_sections_v1';

export const speedRuleLifecycleAt = (row = {}, nowMs = Date.now()) => {
  if (row.historicalVersion === true) return 'historical';
  const validFrom = row.validFrom ? new Date(row.validFrom).getTime() : null;
  const expiresAt = row.expiresAt ? new Date(row.expiresAt).getTime() : null;
  if (row.validFrom && !Number.isFinite(validFrom)) return 'invalid';
  if (row.expiresAt && !Number.isFinite(expiresAt)) return 'invalid';
  if (Number.isFinite(validFrom) && nowMs < validFrom) return 'future';
  if (Number.isFinite(expiresAt) && nowMs >= expiresAt) return 'expired';
  return 'active';
};

export const isUnsetMapSection = (section = {}) => (
  !section.saved &&
  !Number(section.effectiveLimitKmh ?? section.observedLimitKmh ?? section.limitKmh)
);

export const ignoredUnsetSectionKey = (section = {}) => String(correctionKey(section) || '').trim();

export const readIgnoredUnsetSectionKeys = () => {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
};
