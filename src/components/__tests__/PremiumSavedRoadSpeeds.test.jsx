import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPremiumSpeedWorkspaceItems,
  premiumSavedRuleArtwork,
  PremiumRoadSpeedMapHero,
  PremiumSavedRulesHeader,
  PremiumSpeedWorkspaceTabs,
  shouldRenderPremiumSavedRoadSpeeds,
} from '@/components/PremiumSavedRoadSpeeds';

const callbacks = () => ({
  onMapQueryChange: vi.fn(),
  onReviewConflict: vi.fn(),
  onRestoreExcluded: vi.fn(),
  onRestoreHidden: vi.fn(),
  onToggleAdd: vi.fn(),
  onToggleAutoSnap: vi.fn(),
});

function findElements(node, type, results = []) {
  if (node == null || typeof node === 'string' || typeof node === 'number') return results;
  if (Array.isArray(node)) {
    node.forEach((child) => findElements(child, type, results));
    return results;
  }
  if (node.type === type) results.push(node);
  findElements(node.props?.children, type, results);
  return results;
}

describe('PremiumSavedRoadSpeeds', () => {
  it('uses the persisted premium appearance setting as the only rendering gate', () => {
    expect(shouldRenderPremiumSavedRoadSpeeds({ premium_visual_experience: true })).toBe(true);
    expect(shouldRenderPremiumSavedRoadSpeeds({ premium_visual_experience: false })).toBe(false);
    expect(shouldRenderPremiumSavedRoadSpeeds({})).toBe(false);
    expect(shouldRenderPremiumSavedRoadSpeeds()).toBe(false);
  });

  it('derives all workspace counts from live values without inventing demo data', () => {
    const model = buildPremiumSpeedWorkspaceItems({
      mapCount: 451.9,
      reviewCount: '4',
      savedCount: 19,
    });

    expect(model.map(({ value, count }) => [value, count])).toEqual([
      ['map', 451],
      ['review', 4],
      ['saved', 19],
    ]);
    expect(buildPremiumSpeedWorkspaceItems({
      mapCount: -5,
      reviewCount: Number.NaN,
      savedCount: null,
    }).map(({ count }) => count)).toEqual([0, 0, 0]);
  });

  it('selects state-matched generated artwork for every saved-rule card', () => {
    expect(premiumSavedRuleArtwork('user_confirmed_posted_sign', false)).toContain('premium-saved-roads-saved.webp');
    expect(premiumSavedRuleArtwork('user_entered_estimate', false)).toContain('premium-saved-roads-map.webp');
    expect(premiumSavedRuleArtwork('user_confirmed_posted_sign', true)).toContain('premium-saved-roads-review.webp');
  });

  it('renders three separate illustrated controls with accessible live counts', () => {
    const html = renderToStaticMarkup(
      <PremiumSpeedWorkspaceTabs
        activeWorkspace="review"
        mapCount={28}
        onChange={vi.fn()}
        reviewCount={3}
        savedCount={11}
      />,
    );

    expect(html).toContain('aria-label="Saved road speed workspace"');
    expect(html.match(/class="premium-speed-workspace"/g)).toHaveLength(3);
    expect(html).toContain('premium-saved-roads-map.webp');
    expect(html).toContain('premium-saved-roads-review.webp');
    expect(html).toContain('premium-saved-roads-saved.webp');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="3 needs review"');
    expect(html).toContain('aria-label="11 saved roads"');
  });

  it('preserves the existing workspace navigation callback', () => {
    const onChange = vi.fn();
    const tree = PremiumSpeedWorkspaceTabs({
      activeWorkspace: 'map',
      mapCount: 28,
      onChange,
      reviewCount: 3,
      savedCount: 11,
    });
    const buttons = findElements(tree, 'button');

    buttons[2].props.onClick();

    expect(onChange).toHaveBeenCalledWith('saved');
  });

  it('preserves map actions, search state, restore counts, legend, and add-mode state', () => {
    const html = renderToStaticMarkup(
      <PremiumRoadSpeedMapHero
        addMode
        autoSnapTrace
        excludedSpeedSectionCount={2}
        firstConflictSection={{ geohash: 'f2m' }}
        hiddenUnsetSectionCount={7}
        mapQuery="county road 80"
        {...callbacks()}
      />,
    );

    expect(html).toContain('premium-saved-roads-map-hero.webp');
    expect(html).toContain('Cancel adding');
    expect(html).toContain('Review conflict');
    expect(html).toContain('Restore hidden unset 7');
    expect(html).toContain('Allow learning again 2');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('value="county road 80"');
    expect(html).toContain('aria-label="Road speed map legend"');
    expect(html).toContain('Observed');
    expect(html).toContain('100');
    expect(html).toContain('km/h');
  });

  it('keeps optional controls out of a real empty state', () => {
    const html = renderToStaticMarkup(
      <PremiumRoadSpeedMapHero
        addMode={false}
        autoSnapTrace={false}
        excludedSpeedSectionCount={0}
        firstConflictSection={null}
        hiddenUnsetSectionCount={0}
        mapQuery=""
        {...callbacks()}
      />,
    );

    expect(html).toContain('Add road speed');
    expect(html).not.toContain('Review conflict');
    expect(html).not.toContain('Restore hidden unset');
    expect(html).not.toContain('Allow learning again');
    expect(html).not.toContain('Auto snap');
  });

  it('renders the saved-rules artwork and the existing live search and sort controls', () => {
    const html = renderToStaticMarkup(
      <PremiumSavedRulesHeader
        count={1234}
        onQueryChange={vi.fn()}
        onSortChange={vi.fn()}
        query="Highway 7"
        sort="impact"
        sortOptions={[
          ['updated', 'Recently updated'],
          ['impact', 'Conflict impact'],
        ]}
      />,
    );

    expect(html).toContain('premium-saved-roads-city-hero.webp');
    expect(html).toContain('aria-label="1234 rules shown"');
    expect(html).toContain('value="Highway 7"');
    expect(html).toContain('aria-label="Sort saved speeds"');
    expect(html).toContain('value="impact" selected=""');
  });

  it('forwards live search and sort changes to the existing page state', () => {
    const onQueryChange = vi.fn();
    const onSortChange = vi.fn();
    const tree = PremiumSavedRulesHeader({
      count: 19,
      onQueryChange,
      onSortChange,
      query: '',
      sort: 'updated',
      sortOptions: [
        ['updated', 'Recently updated'],
        ['impact', 'Conflict impact'],
      ],
    });
    const [input] = findElements(tree, 'input');
    const [select] = findElements(tree, 'select');

    input.props.onChange({ target: { value: 'King Street' } });
    select.props.onChange({ target: { value: 'impact' } });

    expect(onQueryChange).toHaveBeenCalledWith('King Street');
    expect(onSortChange).toHaveBeenCalledWith('impact');
  });
});
