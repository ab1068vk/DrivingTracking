import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumDrivingExposureCard, {
  buildPremiumDrivingExposureViewModel,
} from '@/components/PremiumDrivingExposureCard';

describe('buildPremiumDrivingExposureViewModel', () => {
  it('derives the premium gauge and labels from the live daily calculation', () => {
    expect(buildPremiumDrivingExposureViewModel({
      cumulativeFatigueScore: 4.2,
      fatigueLevel: 'moderate',
      minutesSinceLastTrip: 223,
      recommendedBreakMinutes: 10,
      totalDrivingMinutes: 43,
      tripCount: 4,
    })).toEqual({
      gaugeProgress: 31.5,
      level: 'moderate',
      levelLabel: 'Moderate',
      recommendedBreakMinutes: 10,
      restingMinutes: 223,
      score: 4.2,
      scoreLabel: '4.2',
      totalDrivingMinutes: 43,
      tripCount: 4,
      tripLabel: '4 trips',
    });
  });

  it('clamps malformed and oversized values without inventing evidence', () => {
    expect(buildPremiumDrivingExposureViewModel({
      cumulativeFatigueScore: 99,
      fatigueLevel: 'critical',
      minutesSinceLastTrip: null,
      recommendedBreakMinutes: -5,
      totalDrivingMinutes: Number.NaN,
      tripCount: 1.9,
    })).toMatchObject({
      gaugeProgress: 75,
      level: 'critical',
      recommendedBreakMinutes: 0,
      restingMinutes: null,
      score: 10,
      totalDrivingMinutes: 0,
      tripCount: 1,
      tripLabel: '1 trip',
    });
  });
});

describe('PremiumDrivingExposureCard', () => {
  it.each([
    ['low', 1.5, 11.25],
    ['moderate', 3.8, 28.5],
    ['high', 5.7, 42.75],
    ['critical', 8.6, 64.5],
  ])('renders the live %s state and a value-driven gauge', (level, score, gaugeProgress) => {
    const html = renderToStaticMarkup(
      <PremiumDrivingExposureCard dailyFatigue={{
        cumulativeFatigueScore: score,
        fatigueLevel: level,
        minutesSinceLastTrip: 75,
        recommendedBreakMinutes: level === 'low' ? 0 : 20,
        totalDrivingMinutes: 123456,
        tripCount: 9876,
      }} />,
    );

    expect(html).toContain('class="premium-driving-exposure"');
    expect(html).toContain(`data-level="${level}"`);
    expect(html).toContain(`stroke-dasharray:${gaugeProgress} ${100 - gaugeProgress}`);
    expect(html).toContain(`aria-valuenow="${score}"`);
    expect(html).toContain(`width:${score * 10}%`);
    expect(html).toContain('123456');
    expect(html).toContain('9876 trips');
    expect(html).toContain('premium-driving-exposure-wheel.png');
    expect(html).toContain('premium-driving-exposure-clock.png');
    expect(html).toContain('premium-driving-exposure-rest.png');
  });

  it('keeps the unavailable rest state explicit and accessible', () => {
    const html = renderToStaticMarkup(
      <PremiumDrivingExposureCard dailyFatigue={{
        cumulativeFatigueScore: 0,
        fatigueLevel: 'low',
        minutesSinceLastTrip: null,
        totalDrivingMinutes: 1,
        tripCount: 1,
      }} />,
    );

    expect(html).toContain('aria-label="Rest time is not available yet"');
    expect(html).toContain('Rest unavailable');
    expect(html).toContain('Recovery clock pending');
    expect(html).not.toContain('premium-exposure-break');
  });
});
