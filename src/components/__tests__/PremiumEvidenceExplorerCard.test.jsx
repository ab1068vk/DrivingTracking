import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PremiumEvidenceExplorerCard, {
  buildEvidencePulsePath,
  buildPremiumEvidenceExplorerModel,
} from '@/components/PremiumEvidenceExplorerCard';

const patterns = [
  { key: 'speeding', label: 'Speed control', count: 13, events_per_100km: 2, share_percent: 65 },
  { key: 'stop_start_patterns', label: 'Stop-start patterns', count: 5, events_per_100km: 1.4, share_percent: 24 },
  { key: 'heading_deviations', label: 'Heading events (Beta)', count: 1, events_per_100km: 0.2, share_percent: 5 },
  { key: 'erratic_speed', label: 'Erratic speed', count: 1, events_per_100km: 0.1, share_percent: 5 },
];

describe('PremiumEvidenceExplorerCard', () => {
  it('renders live values, contribution rings, and generated artwork', () => {
    const html = renderToStaticMarkup(
      <PremiumEvidenceExplorerCard patterns={patterns} units="metric" />,
    );

    expect(html).toContain('premium-evidence-explorer');
    expect(html).toContain('What is driving the recommendation');
    expect(html).toContain('2.0 / 100 km');
    expect(html).toContain('65% of recorded risk events');
    expect(html).toContain('65% contribution');
    expect(html).toContain('13 recorded events');
    expect(html).toContain('premium-evidence-speeding.webp');
    expect(html).toContain('premium-evidence-stop-start.webp');
    expect(html).toContain('premium-evidence-heading-deviations.webp');
    expect(html).toContain('premium-evidence-erratic-speed.webp');
  });

  it('uses the selected unit system without changing the source evidence', () => {
    const metric = buildPremiumEvidenceExplorerModel(patterns, 'metric')[0];
    const imperial = buildPremiumEvidenceExplorerModel(patterns, 'imperial')[0];

    expect(metric).toMatchObject({ count: 13, rate: '2.0 / 100 km', share: 65, tone: 'blue' });
    expect(imperial).toMatchObject({ count: 13, rate: '3.2 / 100 mi', share: 65, tone: 'blue' });
  });

  it('clamps malformed contribution inputs and limits the live ranked list to four rows', () => {
    const model = buildPremiumEvidenceExplorerModel([
      { key: 'harsh_brakes', label: 'Late braking', count: -2, share_percent: -10, events_per_100km: null },
      { key: 'rapid_accel', label: 'Hard acceleration', count: 2, share_percent: 175, events_per_100km: 2 },
      ...patterns,
    ], 'metric');

    expect(model).toHaveLength(4);
    expect(model[0]).toMatchObject({ count: 0, rate: 'Unavailable', share: 0, tone: 'danger' });
    expect(model[1]).toMatchObject({ count: 2, rate: '2.0 / 100 km', share: 100, tone: 'amber' });
    expect(model[0].pulsePath).toMatch(/^M0 \d+/);
  });

  it('renders an honest empty state without invented metric values', () => {
    const html = renderToStaticMarkup(<PremiumEvidenceExplorerCard patterns={[]} units="metric" />);

    expect(html).toContain('Evidence is still building');
    expect(html).toContain('No dominant risk event is currently strong enough to display.');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('/ 100 km');
  });

  it('changes the evidence pulse when real share or count changes', () => {
    expect(buildEvidencePulsePath(65, 13)).not.toBe(buildEvidencePulsePath(5, 1));
  });
});
