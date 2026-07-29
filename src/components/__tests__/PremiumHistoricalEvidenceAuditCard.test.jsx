import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PremiumHistoricalEvidenceAuditCard, {
  buildPremiumHistoricalEvidenceAuditViewModel,
  shouldRenderPremiumHistoricalEvidenceAudit,
} from '@/components/PremiumHistoricalEvidenceAuditCard';

describe('PremiumHistoricalEvidenceAuditCard', () => {
  it('renders only for the explicitly enabled premium appearance setting', () => {
    expect(shouldRenderPremiumHistoricalEvidenceAudit(true)).toBe(true);
    expect(shouldRenderPremiumHistoricalEvidenceAudit(false)).toBe(false);
    expect(shouldRenderPremiumHistoricalEvidenceAudit(undefined)).toBe(false);
    expect(shouldRenderPremiumHistoricalEvidenceAudit('true')).toBe(false);
  });

  it('maps the live audit calculation to every premium metric without demo values', () => {
    const model = buildPremiumHistoricalEvidenceAuditViewModel({
      totalCompleted: 77,
      driverEligible: 71,
      scoreReady: 68,
      eventReady: 66,
      routeReady: 64,
    });

    expect(model.metrics.map(({ id, value, label, measured }) => ({
      id,
      value,
      label,
      measured,
    }))).toEqual([
      { id: 'completed', value: '77', label: 'completed trips found', measured: true },
      { id: 'driver', value: '71', label: 'driver trips eligible', measured: true },
      { id: 'score', value: '68 trips', label: 'score evidence', measured: true },
      { id: 'events', value: '66 trips', label: 'event evidence', measured: true },
      { id: 'route', value: '64 trips', label: 'route evidence', measured: true },
    ]);
  });

  it('preserves the standard audit empty-state wording', () => {
    const model = buildPremiumHistoricalEvidenceAuditViewModel();

    expect(model.metrics.map(({ value, measured }) => ({ value, measured }))).toEqual([
      { value: 'None', measured: false },
      { value: 'None eligible', measured: false },
      { value: 'Not measured', measured: false },
      { value: 'Not measured', measured: false },
      { value: 'No route key', measured: false },
    ]);
    expect(model.notices).toEqual([]);
  });

  it('keeps historical, driver-exclusion, and privacy notices distinct', () => {
    const model = buildPremiumHistoricalEvidenceAuditViewModel({
      missingCoachMeasurements: 4,
      excludedDriver: 2,
      privacyProtected: 16,
    });

    expect(model.notices).toEqual([
      {
        id: 'missing',
        count: 4,
        lead: '4 historical trips:',
        detail: 'no reliable score or Coach event measurement; excluded, never counted as 0.',
      },
      {
        id: 'excluded',
        count: 2,
        lead: '2 trips:',
        detail: 'passenger or manually excluded from driver metrics.',
      },
      {
        id: 'privacy',
        count: 16,
        lead: '16 privacy-protected trips:',
        detail: 'included using stored scores, events, and route points outside your configured privacy-zone radius. Protected coordinates remain excluded.',
      },
    ]);
  });

  it('renders generated artwork, accessible live values, notices, and loading state', () => {
    const html = renderToStaticMarkup(
      <PremiumHistoricalEvidenceAuditCard
        loading
        audit={{
          totalCompleted: 8,
          driverEligible: 7,
          scoreReady: 6,
          eventReady: 5,
          routeReady: 4,
          privacyProtected: 3,
        }}
      />,
    );

    expect(html).toContain('class="premium-historical-audit"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Refreshing trip evidence');
    expect(html).toContain('premium-historical-audit-hero.webp');
    expect(html).toContain('premium-historical-audit-completed.webp');
    expect(html).toContain('premium-historical-audit-driver.webp');
    expect(html).toContain('premium-historical-audit-score.webp');
    expect(html).toContain('premium-historical-audit-events.webp');
    expect(html).toContain('premium-historical-audit-route.webp');
    expect(html).toContain('premium-historical-audit-privacy.webp');
    expect(html).toContain('premium-historical-audit-icon-completed-v3.webp');
    expect(html).toContain('premium-historical-audit-icon-driver-v3.webp');
    expect(html).toContain('premium-historical-audit-icon-score-v3.webp');
    expect(html).toContain('premium-historical-audit-icon-events-v3.webp');
    expect(html).toContain('premium-historical-audit-icon-route-v3.webp');
    expect(html).toContain('premium-historical-audit-icon-privacy-v3.webp');
    expect(html).toContain('class="premium-historical-audit-notices-art"');
    expect(html).not.toContain('lucide-flag');
    expect(html).not.toContain('lucide-user-round');
    expect(html).toContain('aria-label="score evidence: 6 trips"');
    expect(html).toContain('data-notice="privacy"');
    expect(html).toContain('3 privacy-protected trips:');
  });
});
