import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WhyThisSpeed from '@/components/WhyThisSpeed';

describe('WhyThisSpeed', () => {
  it('renders point-time applicability and resolver provenance beside score and alert consequences', () => {
    const html = renderToStaticMarkup(
      <WhyThisSpeed
        compact={false}
        context={{
          timestampMs: Date.parse('2026-08-08T02:00:00.000Z'),
          utcOffsetMinutes: 0,
        }}
        record={{
          source: 'user_confirmed_posted_sign',
          provenance: 'user_map_edit',
          resolverReason: 'confirmed_posted_beats_local_estimate',
          matchReason: 'matched_traced_section',
          matchDistanceM: 7,
          knowledgeRevision: 12,
          timeRule: {
            enabled: true,
            days: [5],
            startTime: '22:00',
            endTime: '06:00',
          },
        }}
      />,
    );

    expect(html).toContain('Applicability: Schedule active at this time');
    expect(html).toContain('recorded UTC offset +0 min');
    expect(html).toContain('Resolver provenance');
    expect(html).toContain('Confirmed posted beats local estimate');
    expect(html).toContain('Knowledge revision 12');
    expect(html).toContain('Score: active');
    expect(html).toContain('Alerts: active');
  });

  it('makes future rules visibly blocked for an earlier historical point', () => {
    const html = renderToStaticMarkup(
      <WhyThisSpeed
        context={{ timestampMs: Date.parse('2026-05-01T00:00:00.000Z') }}
        record={{
          source: 'user_confirmed_posted_sign',
          validFrom: '2026-06-01T00:00:00.000Z',
        }}
      />,
    );

    expect(html).toContain('Not effective yet');
    expect(html).toContain('Score: blocked');
    expect(html).toContain('Alerts: blocked');
  });

  it('labels an incomplete qualifier condition instead of presenting it as confirmed', () => {
    const html = renderToStaticMarkup(
      <WhyThisSpeed
        record={{
          source: 'user_confirmed_posted_sign',
          qualifierStatus: 'conditional_temporary_work_zone',
          timeRule: { enabled: false },
        }}
      />,
    );

    expect(html).toContain('Condition incomplete');
    expect(html).toContain('expiry is missing or invalid');
    expect(html).toContain('Score: blocked');
    expect(html).toContain('Alerts: blocked');
    expect(html).not.toContain('>confirmed<');
  });
});
