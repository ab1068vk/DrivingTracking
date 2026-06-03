import { describe, expect, it } from 'vitest';
import { getSettingsSearchResults } from '../useSettingsSections';

describe('settings section search', () => {
  it('returns no results for blank queries', () => {
    expect(getSettingsSearchResults('   ')).toEqual([]);
  });

  it('ranks direct label matches ahead of keyword-only matches', () => {
    const results = getSettingsSearchResults('alpha', [
      {
        label: 'Keyword hit',
        section: 'General',
        sectionId: 'settings-keyword',
        detail: 'Contains the term only as supporting text.',
        keywords: 'alpha',
      },
      {
        label: 'Alpha direct hit',
        section: 'General',
        sectionId: 'settings-alpha',
        detail: 'Contains the term in the label.',
        keywords: '',
      },
    ]);

    expect(results[0]).toMatchObject({
      label: 'Alpha direct hit',
      sectionId: 'settings-alpha',
    });
  });

  it('limits results to the strongest six matches', () => {
    expect(getSettingsSearchResults('settings score map data permission auto').length).toBeLessThanOrEqual(6);
  });

  it('finds important nested settings rows', () => {
    expect(getSettingsSearchResults('stealth')[0]).toMatchObject({
      label: 'Stealth Trip Mode',
      sectionId: 'settings-privacy-data',
    });
    expect(getSettingsSearchResults('app lock')[0]).toMatchObject({
      label: 'App lock',
      sectionId: 'settings-privacy-data',
    });
    expect(getSettingsSearchResults('location')[0].sectionId).toBe('settings-android-permissions');
    expect(getSettingsSearchResults('calibration')[0].sectionId).toBe('settings-calibration');
    expect(getSettingsSearchResults('threshold')[0]).toMatchObject({
      label: 'Detection thresholds',
      sectionId: 'settings-detection-thresholds',
    });
  });
});
