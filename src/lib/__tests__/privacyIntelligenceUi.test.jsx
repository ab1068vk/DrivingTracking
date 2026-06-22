import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ProtectionGuidance, {
  shouldShowProtectionGuidance,
} from '@/components/privacy/ProtectionGuidance';

const renderGuidance = (status, overrides = {}) => renderToStaticMarkup(createElement(
  ProtectionGuidance,
  {
    item: {
      id: `control-${status}`,
      status,
      riskIfMissing: `${status} risk`,
      userAction: `${status} user action`,
      developerAction: `${status} developer action`,
    },
    expanded: true,
    onToggle: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  }
));

describe('Privacy Intelligence protection guidance', () => {
  it.each(['error', 'warn', 'unknown'])(
    'renders the userAction expansion for %s controls',
    (status) => {
      const html = renderGuidance(status);

      expect(shouldShowProtectionGuidance(status)).toBe(true);
      expect(html).toContain('What should I do?');
      expect(html).toContain(`${status} risk`);
      expect(html).toContain(`${status} user action`);
      expect(html).not.toContain(`${status} developer action`);
    }
  );

  it.each(['ok', 'configured', 'not_applicable'])(
    'does not render review guidance for %s controls',
    (status) => {
      expect(renderGuidance(status)).toBe('');
    }
  );

  it('shows developerAction only when the debug flag is enabled', () => {
    expect(renderGuidance('warn', { showDeveloperActions: true }))
      .toContain('warn developer action');
  });
});
