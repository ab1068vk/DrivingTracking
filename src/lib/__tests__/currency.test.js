import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { formatCurrencyAmount, normalizeCurrencySymbol } from '@/lib/currency';

describe('currency formatting', () => {
  it('formats amounts with the configured currency symbol', () => {
    expect(formatCurrencyAmount(12.3, { currencySymbol: '€' })).toBe('€12.30');
    expect(formatCurrencyAmount(12.3, { currencySymbol: '£' })).toBe('£12.30');
    expect(formatCurrencyAmount(12.3, { currencySymbol: 'kr' })).toBe('kr12.30');
  });

  it('falls back to dollars for unsupported symbols', () => {
    expect(normalizeCurrencySymbol('BTC')).toBe('$');
    expect(formatCurrencyAmount(4, { currencySymbol: 'BTC' })).toBe('$4.00');
  });

  it('routes visible fuel and vehicle cost displays through configured currency formatting', () => {
    const reportSource = readFileSync(new URL('../../pages/Report.jsx', import.meta.url), 'utf8');
    const tripDetailSource = readFileSync(new URL('../../pages/TripDetail.jsx', import.meta.url), 'utf8');
    const vehiclesSource = readFileSync(new URL('../../pages/Vehicles.jsx', import.meta.url), 'utf8');
    const pdfSource = readFileSync(new URL('../pdfExport.js', import.meta.url), 'utf8');

    expect(reportSource).toContain('formatCurrencyAmount(economics.cost, settings)');
    expect(tripDetailSource).toContain('formatCurrencyAmount(economics.cost, settings)');
    expect(vehiclesSource).toContain('formatCurrencyAmount(fuelTotals.cost, currencySymbol)');
    expect(vehiclesSource).toContain('formatCurrencyAmount(costSummary.monthly_cost, currencySymbol)');
    expect(vehiclesSource).toContain('formatCurrencyAmount(convertPerDistanceRate(costSummary.cost_per_km, units), currencySymbol)');
    expect(vehiclesSource).toContain('formatCurrencyAmount(costSummary.fuel_cost, currencySymbol)');
    expect(vehiclesSource).toContain('formatCurrencyAmount(costSummary.maintenance_reserve, currencySymbol)');
    expect(pdfSource).toContain('formatCurrencyAmount(economics.cost, settings)');

    const combined = [reportSource, tripDetailSource, vehiclesSource, pdfSource].join('\n');
    expect(combined).not.toContain('$${economics.cost.toFixed(2)}');
    expect(combined).not.toContain('${fuelTotals.cost.toFixed(2)}');
    expect(combined).not.toContain('${costSummary.monthly_cost.toFixed(2)}');
  });
});
