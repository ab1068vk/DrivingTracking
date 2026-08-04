import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY,
  correctionKey,
  ignoredUnsetSectionKey,
  isUnsetMapSection,
  readIgnoredUnsetSectionKeys,
  speedRuleLifecycleAt,
} from '../speedRuleSections';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

describe('speedRuleLifecycleAt', () => {
  it('reports the window a rule is currently in', () => {
    expect(speedRuleLifecycleAt({}, NOW)).toBe('active');
    expect(speedRuleLifecycleAt({ historicalVersion: true }, NOW)).toBe('historical');
    expect(speedRuleLifecycleAt({ validFrom: '2026-07-01T00:00:00.000Z' }, NOW)).toBe('future');
    expect(speedRuleLifecycleAt({ expiresAt: '2026-05-01T00:00:00.000Z' }, NOW)).toBe('expired');
    expect(speedRuleLifecycleAt({
      validFrom: '2026-05-01T00:00:00.000Z',
      expiresAt: '2026-07-01T00:00:00.000Z',
    }, NOW)).toBe('active');
  });

  it('expires exactly at the boundary and activates exactly at the start', () => {
    expect(speedRuleLifecycleAt({ expiresAt: '2026-06-01T12:00:00.000Z' }, NOW)).toBe('expired');
    expect(speedRuleLifecycleAt({ validFrom: '2026-06-01T12:00:00.000Z' }, NOW)).toBe('active');
  });

  it('flags an unparseable boundary instead of treating it as absent', () => {
    expect(speedRuleLifecycleAt({ validFrom: 'whenever' }, NOW)).toBe('invalid');
    expect(speedRuleLifecycleAt({ expiresAt: 'whenever' }, NOW)).toBe('invalid');
  });
});

describe('section identity', () => {
  it('prefers the most specific identifier available', () => {
    expect(correctionKey({ id: 'a', ruleId: 'b', sectionKey: 'c', geohash: 'd' })).toBe('a');
    expect(correctionKey({ ruleId: 'b', geohash: 'd' })).toBe('b');
    expect(correctionKey({ geohash: 'd' })).toBe('d');
    expect(correctionKey({})).toBeUndefined();
    expect(correctionKey()).toBeUndefined();
  });

  it('trims the ignore-list key and tolerates a section with no identity', () => {
    expect(ignoredUnsetSectionKey({ id: '  abc  ' })).toBe('abc');
    expect(ignoredUnsetSectionKey({})).toBe('');
  });
});

describe('isUnsetMapSection', () => {
  it('is true only for an unsaved section with no usable limit', () => {
    expect(isUnsetMapSection({})).toBe(true);
    expect(isUnsetMapSection({ observedLimitKmh: 0 })).toBe(true);
    expect(isUnsetMapSection({ saved: true })).toBe(false);
    expect(isUnsetMapSection({ effectiveLimitKmh: 50 })).toBe(false);
    expect(isUnsetMapSection({ observedLimitKmh: 50 })).toBe(false);
    expect(isUnsetMapSection({ limitKmh: 50 })).toBe(false);
  });
});

describe('readIgnoredUnsetSectionKeys', () => {
  afterEach(() => {
    delete globalThis.window;
  });

  const withStoredValue = (value) => {
    globalThis.window = { localStorage: { getItem: vi.fn(() => value) } };
  };

  it('returns stored keys as strings', () => {
    withStoredValue(JSON.stringify(['a', 'b', 7]));
    expect(readIgnoredUnsetSectionKeys()).toEqual(['a', 'b', '7']);
    expect(globalThis.window.localStorage.getItem)
      .toHaveBeenCalledWith(IGNORED_UNSET_SPEED_SECTIONS_STORAGE_KEY);
  });

  it('degrades to an empty list rather than throwing on corrupt storage', () => {
    withStoredValue('{not json');
    expect(readIgnoredUnsetSectionKeys()).toEqual([]);
    withStoredValue(JSON.stringify({ a: 1 }));
    expect(readIgnoredUnsetSectionKeys()).toEqual([]);
    withStoredValue(null);
    expect(readIgnoredUnsetSectionKeys()).toEqual([]);
  });

  it('returns an empty list when there is no window at all', () => {
    expect(readIgnoredUnsetSectionKeys()).toEqual([]);
  });
});
