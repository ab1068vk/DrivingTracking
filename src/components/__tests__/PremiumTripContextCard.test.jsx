import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tag } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import PremiumTripContextCard, {
  selectPremiumSensorArtwork,
  selectPremiumSpeedArtwork,
  selectPremiumTripTagArtwork,
  selectPremiumWeatherArtwork,
} from '@/components/PremiumTripContextCard';

describe('PremiumTripContextCard', () => {
  it('renders semantic live content with card-specific decorative artwork', () => {
    const html = renderToStaticMarkup(
      <PremiumTripContextCard
        accent="blue"
        artwork="tag"
        ariaLabel="Suggested tag: Commute, high confidence"
        eyebrow="Trip identity"
        icon={Tag}
        status="high confidence"
        title="Commute"
      >
        <button type="button">Accept</button>
        <button type="button">Change</button>
        <button type="button">Dismiss</button>
      </PremiumTripContextCard>
    );

    expect(html).toContain('data-context-card="tag"');
    expect(html).toContain('premium-trip-tag-route.jpg');
    expect(html).toContain('aria-label="Suggested tag: Commute, high confidence"');
    expect(html).toContain('alt=""');
    expect(html).toContain('>Accept<');
    expect(html).toContain('>Change<');
    expect(html).toContain('>Dismiss<');
  });

  it.each([
    [{ condition: 'clear', displayValue: 'Clear', source: 'open_meteo' }, 'weather-dry'],
    [{ condition: 'rain', displayValue: 'Wet conditions likely', source: 'open_meteo' }, 'weather-rain'],
    [{ condition: 'freezing_precipitation', source: 'open_meteo' }, 'weather-snow'],
    [{ condition: 'fog', source: 'open_meteo' }, 'weather-fog'],
    [{ condition: 'thunderstorm', source: 'open_meteo' }, 'weather-storm'],
    [{ condition: '', source: 'unavailable' }, 'weather-unavailable'],
  ])('selects weather artwork from the recorded condition', (input, expected) => {
    expect(selectPremiumWeatherArtwork(input)).toBe(expected);
  });

  it.each([
    [{ hasPostedEvidence: true, status: 'fetched', coverage: 72 }, 'speed-verified'],
    [{ status: 'fetched', coverage: 72 }, 'speed-estimated'],
    [{ reviewNeeded: true, status: 'fetched', coverage: 72 }, 'speed-review'],
    [{ lookupEnabled: false, status: 'disabled' }, 'speed-unavailable'],
  ])('selects speed artwork from evidence quality', (input, expected) => {
    expect(selectPremiumSpeedArtwork(input)).toBe(expected);
  });

  it.each([
    [{ quality: 'good', sample_count: 42 }, 'sensor-good'],
    [{ quality: 'partial', sample_count: 8 }, 'sensor-partial'],
    [{ quality: 'unavailable', sample_count: 0 }, 'sensor-unavailable'],
  ])('selects sensor artwork from sample availability', (input, expected) => {
    expect(selectPremiumSensorArtwork(input)).toBe(expected);
  });

  it.each([
    ['night', 'tag-night'],
    ['highway', 'tag-highway'],
    ['rain', 'weather-rain'],
    ['commute', 'tag'],
  ])('selects tag artwork for %s trips', (tag, expected) => {
    expect(selectPremiumTripTagArtwork(tag)).toBe(expected);
  });
});
