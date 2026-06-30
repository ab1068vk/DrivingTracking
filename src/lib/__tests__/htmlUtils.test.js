import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { escapeCssIdentifier, escapeHtml, sanitizeCssColor } from '@/lib/htmlUtils';
import { buildDangerZonePopupHtml, buildRouteRiskSegmentPopupHtml, buildSpeedSegmentPopupHtml } from '@/lib/mapPopupHtml';
import { ChartStyle } from '@/components/ui/chart';

describe('HTML escaping', () => {
  it('escapes special characters before values are inserted into popup HTML', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('Tom & "Jerry"')).toBe('Tom &amp; &quot;Jerry&quot;');
    expect(escapeHtml("driver's route")).toBe('driver&#039;s route');
  });

  it('sanitizes CSS identifiers and color values before style injection', () => {
    expect(escapeCssIdentifier('speed"]{body{color:red}}')).toBe('speed___body_color_red__');
    expect(sanitizeCssColor('#0f766e')).toBe('#0f766e');
    expect(sanitizeCssColor('hsl(var(--chart-1))')).toBe('hsl(var(--chart-1))');
    expect(sanitizeCssColor('red; background:url(javascript:alert(1))', null)).toBeNull();
  });

  it('renders chart style config without preserving selector or CSS payload injection', () => {
    const html = renderToStaticMarkup(createElement(ChartStyle, {
      id: 'road"]{body{background:red}}',
      config: {
        'speed;body': { color: '#0f766e' },
        attack: { color: 'red; background:url(javascript:alert(1))' },
      },
    }));

    expect(html).toContain('data-chart="road___body_background_red__"');
    expect(html).toContain('--color-speed_body: #0f766e;');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('background:url');
    expect(html).not.toContain('speed;body');
  });

  it('renders route risk popup values as text instead of HTML', () => {
    const html = buildRouteRiskSegmentPopupHtml({
      riskLevel: '<b>high</b>',
      tripCount: 2,
      totalEvents: 3,
      dominantEventType: '<b>speeding</b>',
    });

    expect(html).toContain('&lt;B&gt;High&lt;/B&gt; repeated-event segment');
    expect(html).toContain('Most common: &lt;B&gt;Speeding&lt;/B&gt;');
    expect(html).not.toContain('<b>high</b>');
    expect(html).not.toContain('<b>speeding</b>');
  });

  it('renders route labels and segment labels as text in speed popups', () => {
    const html = buildSpeedSegmentPopupHtml({
      routeLabel: '<b>commute</b>',
      label: '<i>fast</i>',
      speedKmh: 42,
    });

    expect(html).toContain('<b>&lt;b&gt;commute&lt;/b&gt;</b>');
    expect(html).toContain('&lt;i&gt;fast&lt;/i&gt;: 42 km/h');
    expect(html).not.toContain('<i>fast</i>');
    expect(html).not.toContain('Limit: 0 km/h');
  });

  it('omits invalid speed limits from speed popups', () => {
    const html = buildSpeedSegmentPopupHtml({
      label: 'Fast',
      speedKmh: 88,
      speedLimitKmh: undefined,
    });

    expect(html).toContain('Fast: 88 km/h');
    expect(html).not.toContain('NaN km/h');
    expect(html).not.toContain('Limit:');
  });

  it('renders repeated event area popup values as text instead of HTML', () => {
    const html = buildDangerZonePopupHtml({
      riskLevel: '<b>critical</b>',
      dominantType: '<img src=x onerror=alert(1)>',
      eventCount: 4,
      radiusM: 120,
      lastSeen: 'not-a-date',
    });

    expect(html).toContain('&lt;B&gt;Critical&lt;/B&gt; repeated driving-event area');
    expect(html).toContain('Dominant event: &lt;Img Src=X Onerror=Alert(1)&gt;');
    expect(html).toContain('Last seen: Unknown');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
