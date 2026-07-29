import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumOperationalDriverModel, {
  buildPremiumOperationalDriverModel,
  shouldRenderPremiumOperationalDriverModel,
} from '@/components/PremiumOperationalDriverModel';

const driverSignature = {
  archetype: 'precision_driver',
  dimensions: {
    aggression: 0.1,
    smoothness: 0.78,
    ecoMindedness: 0.64,
    speedTolerance: 0.42,
    consistencyIdx: 0.91,
  },
  trip_count_used: 20,
};

const recommendation = {
  focusId: 'harsh_brakes',
  focus: {
    id: 'harsh_brakes',
    label: 'Progressive Braking',
  },
  reason: 'Speed control is 66% of recent risk events. Two recent trips need smoother braking pressure.',
};

describe('PremiumOperationalDriverModel', () => {
  it('strictly gates premium rendering behind the persisted boolean setting', () => {
    expect(shouldRenderPremiumOperationalDriverModel(true)).toBe(true);
    expect(shouldRenderPremiumOperationalDriverModel(false)).toBe(false);
    expect(shouldRenderPremiumOperationalDriverModel('true')).toBe(false);
    expect(shouldRenderPremiumOperationalDriverModel(1)).toBe(false);
    expect(shouldRenderPremiumOperationalDriverModel(undefined)).toBe(false);
  });

  it('derives the radar and every insight from live model inputs', () => {
    const model = buildPremiumOperationalDriverModel({
      driverSignature,
      bestTime: { id: 'evening', label: 'Evening', trips: 21, avgScore: 65 },
      recommendation,
      currentFocus: recommendation.focus,
      habitProfile: { fatigueOnsetMinutes: 90 },
    });

    expect(model).toMatchObject({
      archetype: 'Precision Driver',
      description: 'Built locally from 20 recent trips. Each signal below explains how it changes coaching.',
      isReady: true,
      tripCount: 20,
      strength: {
        detail: '21 trips average ~65. The coach uses this as a personal reference set.',
        title: 'Evening driving',
        window: 'evening',
      },
      recommendation: {
        detail: recommendation.reason,
        focusId: 'harsh_brakes',
        title: 'Progressive Braking',
      },
      fatigue: {
        title: 'Performance change estimated near 90 minutes',
      },
    });
    expect(model.signals.map(({ label, percent }) => [label, percent])).toEqual([
      ['Aggression', 10],
      ['Smoothness', 78],
      ['Eco', 64],
      ['Speed tolerance', 42],
      ['Consistency', 91],
    ]);
    expect(model.radarPoints.split(' ')).toHaveLength(5);
  });

  it('renders the cinematic hero, five accessible signals, and three distinct illustrated cards', () => {
    const html = renderToStaticMarkup(
      <PremiumOperationalDriverModel
        bestTime={{ id: 'evening', label: 'Evening', trips: 21, avgScore: 65 }}
        currentFocus={recommendation.focus}
        driverSignature={driverSignature}
        habitProfile={{ fatigueOnsetMinutes: 90 }}
        recommendation={recommendation}
      />,
    );

    expect(html).toContain('class="premium-operational-model"');
    expect(html).toContain('data-ready="true"');
    expect(html).toContain('>Precision Driver</h2>');
    expect(html).toContain('premium-operational-model-hero-v1.png');
    expect(html).toContain('premium-operational-model-strength-v1.png');
    expect(html).toContain('premium-operational-model-braking-v1.png');
    expect(html).toContain('premium-operational-model-fatigue-v1.png');
    expect(html).toContain('premium-operational-icon-brain-v1.png');
    expect(html).toContain('premium-operational-icon-aggression-v1.png');
    expect(html).toContain('premium-operational-icon-smoothness-v1.png');
    expect(html).toContain('premium-operational-icon-eco-v1.png');
    expect(html).toContain('premium-operational-icon-speed-v1.png');
    expect(html).toContain('premium-operational-icon-consistency-v1.png');
    expect(html).toContain('premium-operational-icon-braking-v1.png');
    expect(html).toContain('premium-operational-icon-fatigue-v1.png');
    expect(html.match(/class="premium-operational-signal /g)).toHaveLength(5);
    expect(html.match(/class="premium-operational-insight"/g)).toHaveLength(3);
    expect(html).toContain('Driver signal radar. Aggression: 10 percent');
    expect(html).toContain('<title>Aggression: 10%</title>');
    expect(html).toContain('Stable strength. Evening driving.');
    expect(html).toContain('Developing weakness. Progressive Braking.');
    expect(html).toContain('Fatigue response. Performance change estimated near 90 minutes.');
  });

  it.each([
    ['rapid_accel', 'premium-operational-weakness-acceleration-v1.jpg', 'premium-operational-icon-acceleration-v1.png'],
    ['sharp_turns', 'premium-operational-weakness-turns-v1.jpg', 'premium-operational-icon-turns-v1.png'],
    ['speeding', 'premium-operational-weakness-speeding-v1.jpg', 'premium-operational-icon-speeding-v1.png'],
    ['phone_use', 'premium-operational-weakness-phone-v1.jpg', 'premium-operational-icon-phone-v1.png'],
    ['fatigue', 'premium-operational-model-fatigue-v1.png', 'premium-operational-icon-fatigue-v1.png'],
    ['consistency', 'premium-operational-weakness-consistency-v1.jpg', 'premium-operational-icon-consistency-v1.png'],
  ])('selects content-matched generated artwork for %s', (focusId, expectedAsset, expectedIcon) => {
    const html = renderToStaticMarkup(
      <PremiumOperationalDriverModel
        driverSignature={driverSignature}
        habitProfile={{ fatigueOnsetMinutes: 100 }}
        recommendation={{
          focusId,
          focus: { id: focusId, label: `A deliberately long ${focusId} coaching title that must wrap safely` },
          reason: 'A deliberately long dynamic explanation that must be allowed to wrap without clipping or horizontal overflow.',
        }}
      />,
    );

    expect(html).toContain(expectedAsset);
    expect(html).toContain(expectedIcon);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });

  it.each([
    ['morning', 'premium-operational-strength-morning-v1.jpg'],
    ['afternoon', 'premium-operational-strength-afternoon-v1.jpg'],
    ['evening', 'premium-operational-model-strength-v1.png'],
    ['night', 'premium-operational-strength-night-v1.jpg'],
  ])('selects newly generated stable-strength artwork for %s data', (id, expectedAsset) => {
    const label = id[0].toUpperCase() + id.slice(1);
    const html = renderToStaticMarkup(
      <PremiumOperationalDriverModel
        bestTime={{ id, label, trips: 4, avgScore: 84 }}
        driverSignature={driverSignature}
        habitProfile={{ fatigueOnsetMinutes: 90 }}
        recommendation={recommendation}
      />,
    );

    expect(html).toContain(expectedAsset);
    expect(html).toContain(`${label} driving`);
  });

  it('uses explicit loading and calibration states without inventing measurements', () => {
    const learningModel = buildPremiumOperationalDriverModel({
      driverSignature: null,
      bestTime: null,
      recommendation: null,
      habitProfile: { fatigueOnsetMinutes: null },
    });
    const loadingHtml = renderToStaticMarkup(
      <PremiumOperationalDriverModel loading driverSignature={null} />,
    );
    const emptyHtml = renderToStaticMarkup(
      <PremiumOperationalDriverModel driverSignature={null} />,
    );

    expect(learningModel).toMatchObject({
      archetype: 'Building Your Personal Model',
      isReady: false,
      tripCount: 0,
    });
    expect(learningModel.signals.every((signal) => signal.percent == null)).toBe(true);
    expect(learningModel.fatigue.title).toBe('Still learning your endurance pattern');
    expect(loadingHtml).toContain('Refreshing your local driver model');
    expect(emptyHtml).toContain('Your driver signature is calibrating');
    expect(emptyHtml).toContain('after five eligible scored trips');
    expect(emptyHtml).not.toContain('premium-operational-insights');
  });

  it('clamps malformed and oversized values to safe display ranges', () => {
    const model = buildPremiumOperationalDriverModel({
      driverSignature: {
        archetype: 'balanced',
        trip_count_used: 999999.8,
        dimensions: {
          aggression: -4,
          smoothness: 4,
          ecoMindedness: 'not-a-number',
          speedTolerance: 0.555,
          consistencyIdx: null,
        },
      },
      habitProfile: { fatigueOnsetMinutes: -25 },
    });

    expect(model.tripCount).toBe(999999);
    expect(model.signals.map((signal) => signal.percent)).toEqual([0, 100, null, 56, null]);
    expect(model.fatigue.title).toBe('Performance change estimated near 0 minutes');
    expect(model.radarPoints).not.toContain('NaN');
  });
});
