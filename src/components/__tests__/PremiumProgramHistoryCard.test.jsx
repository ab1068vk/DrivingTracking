import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import PremiumProgramHistoryCard, {
  buildPremiumProgramHistoryItem,
} from '@/components/PremiumProgramHistoryCard';
import { ProgramHistory } from '@/pages/DrivingCoach';

const focusCases = [
  ['harsh_brakes', 'braking', 'premium-program-history-braking.webp'],
  ['rapid_accel', 'acceleration', 'premium-program-history-acceleration.webp'],
  ['sharp_turns', 'turns', 'premium-program-history-turns.webp'],
  ['speeding', 'speed', 'premium-program-history-speed.webp'],
  ['phone_use', 'attention', 'premium-program-history-phone.webp'],
  ['fatigue', 'fatigue', 'premium-program-history-fatigue.webp'],
  ['consistency', 'consistency', 'premium-program-history-consistency.webp'],
];

const programFor = (focusId, overrides = {}) => ({
  id: `program-${focusId}`,
  focusId,
  status: 'completed',
  targetTripCount: 5,
  result: {
    completedCount: 4,
    graduated: false,
    improvement: 12.5,
    improvementUnit: focusId === 'consistency' ? 'points' : '%',
  },
  ...overrides,
});

describe('buildPremiumProgramHistoryItem', () => {
  it.each(focusCases)('maps %s to a distinct semantic treatment', (focusId, accent, assetName) => {
    expect(buildPremiumProgramHistoryItem(programFor(focusId))).toMatchObject({
      accent,
      artwork: expect.stringContaining(assetName),
      completedCount: 4,
      focusId,
      progressPercent: 80,
      targetTripCount: 5,
    });
  });

  it('preserves missing, zero, positive, and negative measured outcomes', () => {
    expect(buildPremiumProgramHistoryItem(programFor('consistency', {
      result: { completedCount: 0, improvement: null, improvementUnit: 'points' },
    }))).toMatchObject({
      completedCount: 0,
      improvementLabel: 'No measured change',
      improvementTone: 'steady',
      progressPercent: 0,
    });
    expect(buildPremiumProgramHistoryItem(programFor('consistency', {
      result: { completedCount: 5, improvement: 0, improvementUnit: 'points' },
    }))).toMatchObject({
      improvementLabel: '0 pts',
      improvementTone: 'steady',
      progressPercent: 100,
    });
    expect(buildPremiumProgramHistoryItem(programFor('harsh_brakes', {
      result: { completedCount: 5, improvement: -7.2, improvementUnit: '%' },
    }))).toMatchObject({
      improvementLabel: '-7.2%',
      improvementTone: 'declining',
    });
  });
});

describe('PremiumProgramHistoryCard', () => {
  it('renders real program values, status, progress, generated artwork, and accessible labels', () => {
    const programs = [
      programFor('harsh_brakes', {
        id: 'graduated-braking',
        status: 'graduated',
        result: {
          completedCount: 5,
          graduated: true,
          improvement: 24,
          improvementUnit: '%',
        },
      }),
      programFor('consistency', {
        id: 'replaced-consistency',
        status: 'replaced',
        targetTripCount: 10,
        result: {
          completedCount: 3,
          graduated: false,
          improvement: null,
          improvementUnit: 'points',
        },
      }),
    ];
    const html = renderToStaticMarkup(<PremiumProgramHistoryCard programs={programs} />);

    expect(html).toContain('class="premium-program-history"');
    expect(html).toContain('premium-program-history-hero.webp');
    expect(html).toContain('premium-program-history-braking.webp');
    expect(html).toContain('premium-program-history-consistency.webp');
    expect(html).toContain('5/5');
    expect(html).toContain('drives · graduated');
    expect(html).toContain('+24%');
    expect(html).toContain('3/10');
    expect(html).toContain('drives · replaced');
    expect(html).toContain('No measured change');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain('Progressive Braking: 5 of 5 drives, Graduated, +24%');
  });

  it('renders a data-safe empty state without inventing history values', () => {
    const html = renderToStaticMarkup(<PremiumProgramHistoryCard programs={[]} />);

    expect(html).toContain('Your first result will appear here');
    expect(html).toContain('Finish your first program');
    expect(html).not.toContain('premium-program-history-item');
    expect(html).not.toContain('0/5');
  });

  it('gates the premium card while preserving the standard branch exactly', () => {
    const programs = [programFor('rapid_accel')];
    const standardHtml = renderToStaticMarkup(<ProgramHistory programs={programs} premium={false} />);
    const premiumHtml = renderToStaticMarkup(<ProgramHistory programs={programs} premium />);

    expect(standardHtml).toContain('rounded-3xl border border-border bg-card p-5 shadow-sm');
    expect(standardHtml).not.toContain('class="premium-program-history"');
    expect(standardHtml).toContain('4/5 drives · completed');
    expect(standardHtml).toContain('+12.5%');
    expect(premiumHtml).toContain('class="premium-program-history"');
    expect(premiumHtml).not.toContain('rounded-3xl border border-border bg-card p-5 shadow-sm');
    expect(premiumHtml).toContain('4/5');
    expect(premiumHtml).toContain('+12.5%');
  });

  it('stores every generated asset as a transparent WebP', () => {
    const assetNames = [
      'premium-program-history-hero.webp',
      ...focusCases.map(([, , assetName]) => assetName),
    ];

    assetNames.forEach((assetName) => {
      const asset = readFileSync(new URL(`../../assets/${assetName}`, import.meta.url));
      expect(asset.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(asset.subarray(8, 12).toString('ascii')).toBe('WEBP');
      expect(asset.includes(Buffer.from('ALPH'))).toBe(true);
    });
  });
});
