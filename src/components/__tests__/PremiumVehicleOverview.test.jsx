import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumVehicleOverview from '@/components/PremiumVehicleOverview';

const summary = {
  vehicleCount: 2,
  completedTripCount: 68,
  assignmentReviewCount: 46,
  monthlyCost: 86.9,
  serviceDueCount: 0,
  totalKm: 671,
};

describe('PremiumVehicleOverview', () => {
  it('renders the four generated scenes with accessible live values and semantic states', () => {
    const html = renderToStaticMarkup(
      <PremiumVehicleOverview
        summary={summary}
        formattedMonthlyCost="$86.90"
        formattedTotalDistance="671.0 km"
      />,
    );

    expect(html).toContain('class="premium-vehicle-overview"');
    expect(html.match(/class="premium-vehicle-card"/g)).toHaveLength(4);
    expect(html).toContain('premium-vehicle-garage.webp');
    expect(html).toContain('premium-vehicle-assignment.webp');
    expect(html).toContain('premium-vehicle-cost.webp');
    expect(html).toContain('premium-vehicle-service.webp');
    expect(html).toContain('aria-label="Garage: 2. 68 completed trips"');
    expect(html).toContain('aria-label="Assignment health: 46. trips need vehicle review"');
    expect(html).toContain('aria-label="This month: $86.90. 671.0 km total history"');
    expect(html).toContain('aria-label="Service watch: 0. maintenance items due soon"');
    expect(html).toContain('data-tone="assignment" data-state="attention"');
    expect(html).toContain('data-tone="service" data-state="clear"');
  });

  it('uses the same live pluralization for single-value states', () => {
    const html = renderToStaticMarkup(
      <PremiumVehicleOverview
        summary={{
          ...summary,
          completedTripCount: 1,
          assignmentReviewCount: 1,
          serviceDueCount: 1,
        }}
        formattedMonthlyCost="€1,234.56"
        formattedTotalDistance="12,345.7 mi"
      />,
    );

    expect(html).toContain('1 completed trip');
    expect(html).toContain('trip needs vehicle review');
    expect(html).toContain('maintenance item due soon');
    expect(html).toContain('€1,234.56');
    expect(html).toContain('12,345.7 mi total history');
    expect(html).toContain('data-tone="service" data-state="attention"');
  });

  it('exposes loading state without inventing temporary metric values', () => {
    const html = renderToStaticMarkup(
      <PremiumVehicleOverview
        summary={{
          vehicleCount: 0,
          completedTripCount: 0,
          assignmentReviewCount: 0,
          monthlyCost: 0,
          serviceDueCount: 0,
          totalKm: 0,
        }}
        formattedMonthlyCost="$0.00"
        formattedTotalDistance="0.0 km"
        loading
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Garage is loading"');
    expect(html).toContain('aria-label="This month is loading"');
    expect(html.match(/premium-vehicle-loading-value/g)).toHaveLength(4);
    expect(html).not.toContain('$0.00');
    expect(html).not.toContain('0.0 km');
  });
});
