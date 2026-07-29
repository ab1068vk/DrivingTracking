import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import PremiumCoachProgramSettingsCard, {
  buildPremiumCoachProgramSettingsViewModel,
} from '@/components/PremiumCoachProgramSettingsCard';

const routes = [
  { routeKey: 'home-office', label: 'Home to office', tripCount: 8 },
  { routeKey: 'school-loop', label: 'Morning school loop', tripCount: 3 },
];

function props(overrides = {}) {
  return {
    activeProgram: null,
    adaptiveRecommendation: {
      difficulty: 'standard',
      reason: 'Measured programs show that a balanced target is the most reliable next step.',
    },
    driverTripCount: 12,
    onDifficultyChange: vi.fn(),
    onStart: vi.fn(),
    onContextChange: vi.fn(),
    onRouteKeyChange: vi.fn(),
    onTripCountChange: vi.fn(),
    programBusy: false,
    programRoutes: routes,
    selectedDefinition: { label: 'Smoother braking' },
    selectedDifficulty: 'adaptive',
    selectedContext: 'comparable',
    selectedRecommendation: { focusId: 'harsh_brakes' },
    selectedRouteKey: '',
    selectedTripCount: '5',
    ...overrides,
  };
}

describe('buildPremiumCoachProgramSettingsViewModel', () => {
  it('derives summary labels from live control values', () => {
    expect(buildPremiumCoachProgramSettingsViewModel({
      selectedDifficulty: 'intensive',
      selectedTripCount: '10',
      selectedContext: 'highway',
      programRoutes: routes,
    })).toMatchObject({
      adaptive: false,
      contextLabel: 'Highway drives',
      difficultyLabel: 'Intensive',
      strength: 'Stronger evidence',
      tripCount: 10,
      tripLabel: '10 drives',
    });
  });

  it('uses the selected repeated route and preserves its evidence count', () => {
    expect(buildPremiumCoachProgramSettingsViewModel({
      selectedContext: 'route',
      selectedRouteKey: 'school-loop',
      selectedTripCount: '3',
      programRoutes: routes,
    })).toMatchObject({
      routeKey: 'school-loop',
      routeLabel: 'Morning school loop · 3 drives',
      strength: 'Exploratory check',
    });
  });
});

describe('PremiumCoachProgramSettingsCard', () => {
  it('renders the premium control cards with generated semantic artwork and accessible selects', () => {
    const html = renderToStaticMarkup(<PremiumCoachProgramSettingsCard {...props()} />);

    expect(html).toContain('class="premium-program-settings"');
    expect(html).toContain('premium-coach-program-difficulty.jpg');
    expect(html).toContain('premium-coach-program-length.jpg');
    expect(html).toContain('premium-coach-program-context.jpg');
    expect(html).not.toContain('premium-coach-program-route.jpg');
    expect(html).toContain('aria-label="Program difficulty"');
    expect(html).toContain('aria-label="Program length"');
    expect(html).toContain('aria-label="Program comparison group"');
    expect(html).toContain('Suggested standard:');
    expect(html).toContain('Start Smoother braking');
  });

  it('adds the live repeated-route card only when that comparison mode is selected', () => {
    const html = renderToStaticMarkup(
      <PremiumCoachProgramSettingsCard
        {...props({
          selectedContext: 'route',
          selectedRouteKey: 'school-loop',
        })}
      />,
    );

    expect(html).toContain('premium-coach-program-route.jpg');
    expect(html).toContain('Morning school loop');
    expect(html).toContain('aria-label="Repeated route"');
    expect(html.match(/class="premium-program-setting-tile/g)).toHaveLength(4);
  });

  it('preserves the disabled and replace-program states', () => {
    const disabledHtml = renderToStaticMarkup(
      <PremiumCoachProgramSettingsCard
        {...props({
          driverTripCount: 0,
          selectedRecommendation: null,
        })}
      />,
    );
    const replaceHtml = renderToStaticMarkup(
      <PremiumCoachProgramSettingsCard
        {...props({ activeProgram: { id: 'active-program' } })}
      />,
    );

    expect(disabledHtml).toContain('<button type="button" disabled=""');
    expect(disabledHtml).toContain('Start is disabled until this focus has at least two measured historical trips.');
    expect(replaceHtml).toContain('Replace with Smoother braking');
  });

  it('uses one border and vertically balanced Mission controls', () => {
    const cssSource = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

    expect(cssSource).not.toContain('.premium-program-settings::before');
    expect(cssSource).not.toContain('.premium-practice-plan::after');
    expect(cssSource).not.toContain('.premium-program-setting-tile::after');
    expect(cssSource).toMatch(
      /\.premium-program-setting-content\s*\{[\s\S]*?justify-content:\s*center;/,
    );
  });
});
