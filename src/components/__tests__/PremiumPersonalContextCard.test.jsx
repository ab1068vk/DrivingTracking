import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumPersonalContextCard, {
  buildPremiumPersonalContextViewModel,
} from '@/components/PremiumPersonalContextCard';

const profile = (confidence, fatigueOnsetMinutes = 105) => ({ confidence, fatigueOnsetMinutes });

describe('PremiumPersonalContextCard', () => {
  it.each([
    [0, 0, 'learning'],
    [0.24, 24, 'low'],
    [0.57, 57, 'medium'],
    [0.91, 91, 'high'],
    [1.4, 100, 'high'],
  ])('maps live confidence %s to a responsive %s%% gauge', (confidence, expectedPercent, tone) => {
    const model = buildPremiumPersonalContextViewModel(profile(confidence), null, null, 0, 0);
    const html = renderToStaticMarkup(
      <PremiumPersonalContextCard habitProfile={profile(confidence)} />,
    );

    expect(model.confidencePercent).toBe(expectedPercent);
    expect(model.confidenceTone).toBe(tone);
    expect(html).toContain(`aria-valuenow="${expectedPercent}"`);
    expect(html).toContain(`--context-progress:${expectedPercent}%`);
    expect(html).toContain(`>${expectedPercent}%</div>`);
  });

  it.each(['morning', 'afternoon', 'evening', 'night'])('supports the %s strongest-window possibility', (id) => {
    const label = id[0].toUpperCase() + id.slice(1);
    const model = buildPremiumPersonalContextViewModel(
      profile(0.6),
      { id, label, avgScore: 88, trips: 4 },
      null,
      2,
      9,
    );

    expect(model.bestWindowId).toBe(id);
    expect(model.bestWindowValue).toBe(label);
    expect(model.bestWindowDetail).toBe('4 measured trips in this window');
  });

  it('renders real fatigue, streak, comparison values, and all distinct generated artwork', () => {
    const html = renderToStaticMarkup(
      <PremiumPersonalContextCard
        habitProfile={profile(0.43, 75)}
        bestTime={{ id: 'evening', label: 'Evening', avgScore: 86, trips: 7 }}
        weakestTime={{ id: 'night', label: 'Night', avgScore: 64, trips: 3 }}
        streak={12}
        tripCount={17}
      />,
    );

    expect(html).toContain('>43%</div>');
    expect(html).toContain('75<small> min</small>');
    expect(html).toContain('>12</div>');
    expect(html).toContain('Night trips average <strong>~64</strong>');
    expect(html).toContain('<strong>~86</strong> in your evening window');
    expect(html).toContain('premium-personal-context-hero.webp');
    expect(html).toContain('premium-personal-context-confidence.webp');
    expect(html).toContain('premium-personal-context-fatigue.webp');
    expect(html).toContain('premium-personal-context-window.webp');
    expect(html).toContain('premium-personal-context-streak.webp');
  });

  it('uses explicit learning states without inventing personalized measurements', () => {
    const model = buildPremiumPersonalContextViewModel(profile(0, 90), null, null, 0, 0);
    const html = renderToStaticMarkup(
      <PremiumPersonalContextCard habitProfile={profile(0, 90)} />,
    );

    expect(model).toMatchObject({
      bestWindowId: 'learning',
      bestWindowValue: 'Learning',
      confidencePercent: 0,
      streak: 0,
    });
    expect(html).toContain('Complete scored trips to begin calibration');
    expect(html).toContain('Baseline estimate while your profile begins learning');
    expect(html).toContain('Your time-window comparison will appear after Road Sage learns from scored trips.');
  });
});
