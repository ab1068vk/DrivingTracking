import { describe, expect, it } from 'vitest';
import { searchSettingsSections } from '@/lib/settingsSearch';

const sections = [
  {
    id: 'tracking',
    title: 'Tracking',
    detail: 'Automatic and manual trip tracking.',
    keywords: 'drive gps background',
    searchItems: [
      { label: 'Pause all tracking', keywords: 'stop disable' },
      { label: 'Auto-detect drives', keywords: 'automatic start movement' },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy & Data',
    detail: 'Privacy zones, backups, and retention.',
    keywords: 'security export delete',
    searchItems: [
      { label: 'Raw GPS retention', keywords: 'route coordinates history' },
      { label: 'Export full backup', keywords: 'download restore' },
    ],
  },
];

describe('searchSettingsSections', () => {
  it('returns no results for an empty query', () => {
    expect(searchSettingsSections(sections, '   ')).toEqual([]);
  });

  it('ranks an exact setting label ahead of its section', () => {
    const results = searchSettingsSections(sections, 'pause all tracking');

    expect(results[0]).toMatchObject({
      kind: 'setting',
      label: 'Pause all tracking',
      sectionId: 'tracking',
      targetLabel: 'Pause all tracking',
    });
  });

  it('finds settings through aliases and keywords', () => {
    const results = searchSettingsSections(sections, 'stop gps');

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Pause all tracking',
        sectionId: 'tracking',
      }),
    ]));
  });

  it('matches multi-term searches within the correct section', () => {
    const results = searchSettingsSections(sections, 'backup restore');

    expect(results[0]).toMatchObject({
      label: 'Export full backup',
      sectionId: 'privacy',
    });
  });

  it('tolerates a missing letter in a setting name', () => {
    const results = searchSettingsSections(sections, 'bakup restore');

    expect(results[0]).toMatchObject({
      label: 'Export full backup',
      sectionId: 'privacy',
    });
  });

  it('tolerates transposed letters in an alias', () => {
    const results = searchSettingsSections(sections, 'bakcup restore');

    expect(results[0]).toMatchObject({
      label: 'Export full backup',
      sectionId: 'privacy',
    });
  });

  it('ranks a fuzzy label match above sibling keyword matches', () => {
    const results = searchSettingsSections(sections, 'bakcup');

    expect(results[0]).toMatchObject({
      label: 'Export full backup',
      sectionId: 'privacy',
    });
  });

  it('does not apply fuzzy matching to short terms', () => {
    expect(searchSettingsSections(sections, 'gsp')).toEqual([]);
  });
});
