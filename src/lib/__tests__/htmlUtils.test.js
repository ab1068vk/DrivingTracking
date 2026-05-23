import { describe, expect, it } from 'vitest';
import { escapeHtml } from '@/lib/htmlUtils';
import { buildDangerZonePopupHtml, buildRouteRiskSegmentPopupHtml, buildSpeedSegmentPopupHtml } from '@/lib/mapPopupHtml';

describe('HTML escaping', () => {
  it('escapes special characters before values are inserted into popup HTML', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('Tom & "Jerry"')).toBe('Tom &amp; &quot;Jerry&quot;');
    expect(escapeHtml("driver's route")).toBe('driver&#039;s route');
  });

  it('renders route risk popup values as text instead of HTML', () => {
    const html = buildRouteRiskSegmentPopupHtml({
      riskLevel: '<b>high</b>',
      tripCount: 2,
      totalEvents: 3,
      dominantEventType: '<b>speeding</b>',
    });

    expect(html).toContain('&lt;B&gt;High&lt;/B&gt; risk segment');
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

  it('renders danger zone popup values as text instead of HTML', () => {
    const html = buildDangerZonePopupHtml({
      riskLevel: '<b>critical</b>',
      dominantType: '<img src=x onerror=alert(1)>',
      eventCount: 4,
      radiusM: 120,
      lastSeen: 'not-a-date',
    });

    expect(html).toContain('&lt;B&gt;Critical&lt;/B&gt; danger zone');
    expect(html).toContain('Dominant event: &lt;Img Src=X Onerror=Alert(1)&gt;');
    expect(html).toContain('Last seen: Unknown');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
