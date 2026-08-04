// @ts-check
// Speed-rule draft shaping: qualifiers, recurring time rules, validity
// windows, and the compare keys that decide whether a draft is dirty.
// Extracted verbatim from src/pages/SpeedLimits.jsx.
import { timeString } from '@/components/speedLimits/speedRuleFormatting';

export const mapDraftLimitForSection = (section = {}) => {
  const limit = section.saved
    ? Number(section.limitKmh)
    : Number(section.observedLimitKmh ?? section.effectiveLimitKmh);
  return Number.isFinite(limit) && limit > 0 ? String(Math.round(limit)) : '';
};

export const mapDraftSourceForSection = (section = {}) => {
  if (section.saved) return section.source || 'user_entered_estimate';
  return (section.observedSources || []).includes('user_confirmed_posted_sign')
    ? 'user_confirmed_posted_sign'
    : 'user_entered_estimate';
};

export const SPEED_RULE_QUALIFIER_OPTIONS = [
  ['regulatory_text_no_qualifiers', 'Standard / unconditional'],
  ['conditional_school_when_flashing', 'School zone - flashing schedule'],
  ['conditional_school', 'School-zone schedule'],
  ['conditional_temporary_work_zone', 'Temporary work zone'],
  ['conditional_daytime', 'Daytime-only rule'],
  ['conditional_night', 'Night-only rule'],
];

export const qualifierStatusForDraft = (draft = {}) => (
  SPEED_RULE_QUALIFIER_OPTIONS.some(([value]) => value === draft.qualifierStatus)
    ? draft.qualifierStatus
    : 'regulatory_text_no_qualifiers'
);

export const qualifierStatusLabel = (value) => (
  SPEED_RULE_QUALIFIER_OPTIONS.find(([option]) => option === value)?.[1] ||
  'Standard / unconditional'
);

export const qualifierDraftPatch = (value, draft = {}) => {
  const qualifierStatus = SPEED_RULE_QUALIFIER_OPTIONS.some(([option]) => option === value)
    ? value
    : 'regulatory_text_no_qualifiers';
  if (
    qualifierStatus !== 'regulatory_text_no_qualifiers' &&
    qualifierStatus !== 'conditional_temporary_work_zone' &&
    (draft.timeRuleMode || 'always') === 'always'
  ) {
    return {
      qualifierStatus,
      timeRuleMode: qualifierStatus.startsWith('conditional_school') ? 'weekdays' : 'daily',
    };
  }
  return { qualifierStatus };
};

export const timeRuleModeForRow = (row = {}) => {
  const rule = row.timeRule;
  if (rule?.enabled !== true) return 'always';
  const days = [...(rule.days || [])].sort((a, b) => a - b).join(',');
  if (days === '1,2,3,4,5') return 'weekdays';
  if (days === '0,6') return 'weekends';
  if (days === '0,1,2,3,4,5,6') return 'daily';
  return 'custom';
};

/** @type {Array<[number, string]>} */
export const TIME_RULE_DAY_OPTIONS = [
  [0, 'Sun'],
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
];

export const normalizedDraftDays = (draft = {}) => [...new Set(
  (Array.isArray(draft.customDays) ? draft.customDays : [])
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
)].sort((a, b) => a - b);

export const invalidCustomDayRule = (draft = {}) => (
  draft.timeRuleMode === 'custom' && normalizedDraftDays(draft).length === 0
);

export const timeRuleLabel = (rule = null) => {
  if (rule?.enabled !== true) return 'Always active';
  const mode = timeRuleModeForRow({ timeRule: rule });
  const dayLabel = mode === 'weekdays'
    ? 'Weekdays'
    : mode === 'weekends'
      ? 'Weekends'
      : mode === 'custom'
        ? TIME_RULE_DAY_OPTIONS
          .filter(([day]) => (rule.days || []).includes(day))
          .map(([, label]) => label)
          .join(', ')
        : 'Every day';
  return `${dayLabel} ${timeString(rule.startMinutes)}-${timeString(rule.endMinutes)}`;
};

export const dateInputValue = (value, storedDate = '') => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(storedDate || ''))) return String(storedDate);
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-')
    : '';
};

export const expiresAtFromDate = (value) => (
  value ? new Date(`${value}T23:59:59.999`).toISOString() : null
);

export const validFromFromDate = (value) => (
  value ? new Date(`${value}T00:00:00`).toISOString() : null
);

export const boundaryFromDraft = (draft = {}, kind = 'validFrom') => {
  const dateKey = kind === 'expiresAt' ? 'expiresAtDate' : 'validFromDate';
  const originalKey = kind === 'expiresAt' ? 'originalExpiresAt' : 'originalValidFrom';
  const originalDateKey = kind === 'expiresAt'
    ? 'originalExpiresAtDate'
    : 'originalValidFromDate';
  const selectedDate = String(draft?.[dateKey] || '');
  if (
    Object.prototype.hasOwnProperty.call(draft, originalKey) &&
    selectedDate === String(draft?.[originalDateKey] || '')
  ) {
    return draft?.[originalKey] || null;
  }
  return kind === 'expiresAt'
    ? expiresAtFromDate(selectedDate)
    : validFromFromDate(selectedDate);
};

export const validityFromDraft = (draft = {}) => ({
  validFrom: boundaryFromDraft(draft, 'validFrom'),
  validFromDate: String(draft.validFromDate || '') || null,
  expiresAt: boundaryFromDraft(draft, 'expiresAt'),
  expiresAtDate: String(draft.expiresAtDate || '') || null,
});

export const qualifierDraftError = (draft = {}) => {
  const qualifierStatus = qualifierStatusForDraft(draft);
  if (
    qualifierStatus === 'conditional_temporary_work_zone' &&
    !validityFromDraft(draft).expiresAt
  ) return 'Temporary work-zone rules need an Active until date.';
  if (
    qualifierStatus !== 'regulatory_text_no_qualifiers' &&
    qualifierStatus !== 'conditional_temporary_work_zone' &&
    (draft.timeRuleMode || 'always') === 'always'
  ) return 'This conditional rule needs active days and times.';
  return '';
};

export const invalidValidityWindow = (draft = {}) => {
  const { validFrom, expiresAt } = validityFromDraft(draft);
  return Boolean(validFrom && expiresAt && new Date(validFrom).getTime() >= new Date(expiresAt).getTime());
};

export const DEFAULT_MAP_DRAFT = {
  limitKmh: '',
  source: 'user_confirmed_posted_sign',
  qualifierStatus: 'regulatory_text_no_qualifiers',
  note: '',
  roadName: '',
  directionMode: 'both',
  timeRuleMode: 'always',
  startTime: '07:00',
  endTime: '17:00',
  customDays: [1, 2, 3, 4, 5],
  validFromDate: '',
  expiresAtDate: '',
  originalValidFrom: null,
  originalValidFromDate: '',
  originalExpiresAt: null,
  originalExpiresAtDate: '',
};

export const mapDraftForSection = (section = {}) => ({
  ...DEFAULT_MAP_DRAFT,
  limitKmh: mapDraftLimitForSection(section),
  source: mapDraftSourceForSection(section),
  qualifierStatus: qualifierStatusForDraft(section),
  note: section.note || '',
  roadName: section.roadName || '',
  directionMode: section.directionMode || 'both',
  timeRuleMode: timeRuleModeForRow(section),
  startTime: timeString(section.timeRule?.startMinutes),
  endTime: timeString(section.timeRule?.endMinutes, '17:00'),
  customDays: Array.isArray(section.timeRule?.days)
    ? [...section.timeRule.days]
    : DEFAULT_MAP_DRAFT.customDays,
  validFromDate: dateInputValue(section.validFrom, section.validFromDate),
  expiresAtDate: dateInputValue(section.expiresAt, section.expiresAtDate),
  originalValidFrom: section.validFrom || null,
  originalValidFromDate: dateInputValue(section.validFrom, section.validFromDate),
  originalExpiresAt: section.expiresAt || null,
  originalExpiresAtDate: dateInputValue(section.expiresAt, section.expiresAtDate),
});

export const draftForCorrection = (row = {}) => ({
  limitKmh: String(row.limitKmh || ''),
  source: row.source || 'user_entered_estimate',
  qualifierStatus: qualifierStatusForDraft(row),
  note: row.note || '',
  roadName: row.roadName || '',
  directionMode: row.directionMode || 'both',
  timeRuleMode: timeRuleModeForRow(row),
  startTime: timeString(row.timeRule?.startMinutes),
  endTime: timeString(row.timeRule?.endMinutes, '17:00'),
  customDays: Array.isArray(row.timeRule?.days)
    ? [...row.timeRule.days]
    : [...DEFAULT_MAP_DRAFT.customDays],
  validFromDate: dateInputValue(row.validFrom, row.validFromDate),
  expiresAtDate: dateInputValue(row.expiresAt, row.expiresAtDate),
  originalValidFrom: row.validFrom || null,
  originalValidFromDate: dateInputValue(row.validFrom, row.validFromDate),
  originalExpiresAt: row.expiresAt || null,
  originalExpiresAtDate: dateInputValue(row.expiresAt, row.expiresAtDate),
});

export const normalizeMapDraftForCompare = (draft = {}) => JSON.stringify({
  limitKmh: String(draft.limitKmh ?? '').trim(),
  source: String(draft.source || DEFAULT_MAP_DRAFT.source),
  qualifierStatus: qualifierStatusForDraft(draft),
  note: String(draft.note ?? ''),
  roadName: String(draft.roadName ?? ''),
  directionMode: String(draft.directionMode || DEFAULT_MAP_DRAFT.directionMode),
  timeRuleMode: String(draft.timeRuleMode || DEFAULT_MAP_DRAFT.timeRuleMode),
  startTime: String(draft.startTime || DEFAULT_MAP_DRAFT.startTime),
  endTime: String(draft.endTime || DEFAULT_MAP_DRAFT.endTime),
  customDays: normalizedDraftDays(draft).join(','),
  validFromDate: String(draft.validFromDate || ''),
  expiresAtDate: String(draft.expiresAtDate || ''),
});

export const speedConflictCompareKey = (conflict = null) => JSON.stringify(conflict ? {
  savedLimitKmh: Number(conflict.savedLimitKmh) || null,
  observedLimitKmh: Number(conflict.observedLimitKmh) || null,
  deltaKmh: Number(conflict.deltaKmh) || null,
  geohash: String(conflict.geohash || ''),
} : null);

export const timeRuleFromDraft = (draft = {}) => {
  const mode = draft.timeRuleMode || 'always';
  if (mode === 'always') return { enabled: false };
  const days = mode === 'weekdays'
    ? [1, 2, 3, 4, 5]
    : mode === 'weekends'
      ? [0, 6]
      : mode === 'custom'
        ? normalizedDraftDays(draft)
        : [0, 1, 2, 3, 4, 5, 6];
  return {
    enabled: true,
    days,
    startTime: draft.startTime || '07:00',
    endTime: draft.endTime || '17:00',
  };
};
