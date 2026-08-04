import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_CENTER_ARRAY, configuredMapCenter } from '@/lib/mapDefaults';
import { ECO_DEFAULTS } from '@/lib/ecoDefaults';
import {
  BACKUP_DECOMPRESSED_TOO_LARGE_MESSAGE,
  BACKUP_SIGNATURE_INVALID_CODE,
  BACKUP_TOO_LARGE_MESSAGE,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_DECOMPRESSED_BYTES,
} from '@/lib/dataBackupConstants';
import {
  CO2_KG_PER_LITER,
  DEFAULT_CO2_BASELINE_KG_PER_100KM,
  DEFAULT_EV_KWH_PER_100KM,
  DEFAULT_FUEL_PRICE_PER_LITER,
  DEFAULT_GRID_CO2_KG_PER_KWH,
  DEFAULT_L_PER_100KM,
  DEFAULT_MAINTENANCE_ITEMS,
  DEFAULT_TREE_CO2_KG_PER_YEAR,
  ECO_DRIVING_MAX_ECONOMY_ADJUSTMENT,
  GASOLINE_CO2_KG_PER_LITER,
  MAINTENANCE_CALIBRATION_REGISTRY,
  WEAR_KM_PER_STRESS_UNIT,
} from '@/lib/tripEconomyDefaults';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import { queryClientInstance } from '@/lib/query-client';
import { cn, isIframe } from '@/lib/utils';

// These modules are mostly constants, so the value here is guarding the ranges
// and invariants other code silently depends on.

describe('map defaults', () => {
  it('exposes a coordinate inside real-world bounds', () => {
    expect(DEFAULT_MAP_CENTER.lat).toBeGreaterThanOrEqual(-90);
    expect(DEFAULT_MAP_CENTER.lat).toBeLessThanOrEqual(90);
    expect(DEFAULT_MAP_CENTER.lng).toBeGreaterThanOrEqual(-180);
    expect(DEFAULT_MAP_CENTER.lng).toBeLessThanOrEqual(180);
  });

  it('keeps the array form in [lat, lng] order that Leaflet expects', () => {
    expect(DEFAULT_MAP_CENTER_ARRAY).toEqual([DEFAULT_MAP_CENTER.lat, DEFAULT_MAP_CENTER.lng]);
  });

  it('freezes both forms so a map interaction cannot mutate the fallback', () => {
    expect(Object.isFrozen(DEFAULT_MAP_CENTER)).toBe(true);
    expect(Object.isFrozen(DEFAULT_MAP_CENTER_ARRAY)).toBe(true);
  });

  it('returns either a valid configured coordinate or null, never a partial one', () => {
    const configured = configuredMapCenter();
    if (configured === null) return;

    expect(Number.isFinite(configured.lat)).toBe(true);
    expect(Number.isFinite(configured.lng)).toBe(true);
  });
});

describe('eco defaults', () => {
  it('resolves every multiplier to a finite number from the scoring constants', () => {
    for (const [key, value] of Object.entries(ECO_DEFAULTS)) {
      expect(Number.isFinite(value), `${key} is not finite`).toBe(true);
    }
  });

  it('never lets both eco multipliers be zero, which would make eco unscoreable', () => {
    const bothZero = ECO_DEFAULTS.CRUISE_SCORE_MULTIPLIER === 0 &&
      ECO_DEFAULTS.IDLE_PENALTY_MULTIPLIER === 0;

    expect(bothZero).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ECO_DEFAULTS)).toBe(true);
  });
});

describe('backup limits', () => {
  it('allows a decompressed payload larger than the compressed cap', () => {
    expect(MAX_BACKUP_DECOMPRESSED_BYTES).toBeGreaterThan(MAX_BACKUP_BYTES);
  });

  it('states the compressed cap in the user-facing message', () => {
    const cappedMb = MAX_BACKUP_BYTES / (1024 * 1024);

    expect(BACKUP_TOO_LARGE_MESSAGE).toContain(String(cappedMb));
    expect(BACKUP_DECOMPRESSED_TOO_LARGE_MESSAGE).toContain(
      String(MAX_BACKUP_DECOMPRESSED_BYTES / (1024 * 1024))
    );
  });

  it('keeps a stable machine-readable signature code', () => {
    expect(BACKUP_SIGNATURE_INVALID_CODE).toBe('BACKUP_SIGNATURE_INVALID');
  });
});

describe('trip economy defaults', () => {
  it('keeps fuel and energy baselines inside plausible ranges', () => {
    expect(DEFAULT_FUEL_PRICE_PER_LITER).toBeGreaterThan(0);
    expect(DEFAULT_L_PER_100KM).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_L_PER_100KM).toBeLessThanOrEqual(40);
    expect(DEFAULT_EV_KWH_PER_100KM).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_EV_KWH_PER_100KM).toBeLessThanOrEqual(40);
    expect(DEFAULT_GRID_CO2_KG_PER_KWH).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CO2_BASELINE_KG_PER_100KM).toBeGreaterThan(0);
    expect(DEFAULT_TREE_CO2_KG_PER_YEAR).toBeGreaterThan(0);
  });

  it('caps the eco-driving economy adjustment at the documented 8%', () => {
    expect(ECO_DRIVING_MAX_ECONOMY_ADJUSTMENT).toBe(0.08);
  });

  it('gives electric powertrains zero tailpipe CO2 and fossil fuels a positive value', () => {
    expect(CO2_KG_PER_LITER.electric).toBe(0);
    expect(CO2_KG_PER_LITER.ev).toBe(0);

    for (const fuel of ['gasoline', 'petrol', 'diesel', 'lpg', 'cng', 'hybrid']) {
      expect(CO2_KG_PER_LITER[fuel], `${fuel} has no CO2 factor`).toBeGreaterThan(0);
    }
  });

  it('keeps gasoline consistent between its named constant and the table', () => {
    expect(CO2_KG_PER_LITER.gasoline).toBe(GASOLINE_CO2_KG_PER_LITER);
    expect(CO2_KG_PER_LITER.petrol).toBe(GASOLINE_CO2_KG_PER_LITER);
  });

  it('ranks diesel above gasoline above LPG per litre', () => {
    expect(CO2_KG_PER_LITER.diesel).toBeGreaterThan(CO2_KG_PER_LITER.gasoline);
    expect(CO2_KG_PER_LITER.gasoline).toBeGreaterThan(CO2_KG_PER_LITER.lpg);
  });

  it('keeps the retired wear conversion disabled and labelled', () => {
    // Re-enabling this would let GPS events change service intervals, which the
    // project deliberately does not claim.
    expect(WEAR_KM_PER_STRESS_UNIT).toBeNull();
    expect(MAINTENANCE_CALIBRATION_REGISTRY.wearKmPerStressUnit.value).toBeNull();
    expect(MAINTENANCE_CALIBRATION_REGISTRY.wearKmPerStressUnit.calibrationStatus).toBe('retired');
    expect(DEFAULT_MAINTENANCE_ITEMS).toEqual([]);
  });
});

describe('shared runtime singletons', () => {
  it('namespaces the rescore progress event', () => {
    expect(RESCORE_PROGRESS_EVENT).toBe('road-sage:rescore-progress');
  });

  it('configures the query client to not refetch on window focus', () => {
    const defaults = queryClientInstance.getDefaultOptions().queries;

    expect(defaults.refetchOnWindowFocus).toBe(false);
    expect(defaults.retry).toBe(1);
    expect(defaults.staleTime).toBeGreaterThan(0);
    expect(defaults.gcTime).toBeGreaterThan(defaults.staleTime);
  });
});

describe('cn class merger', () => {
  it('joins class names and drops falsy entries', () => {
    expect(cn('a', false && 'b', null, undefined, 'c')).toBe('a c');
  });

  it('lets a later Tailwind utility win over an earlier conflicting one', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-sm text-red-500', 'text-lg')).toBe('text-red-500 text-lg');
  });

  it('accepts arrays and conditional objects', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c');
  });

  it('returns an empty string for no usable input', () => {
    expect(cn()).toBe('');
    expect(cn(null, undefined, false)).toBe('');
  });

  it('exposes a boolean iframe flag', () => {
    expect(typeof isIframe).toBe('boolean');
  });
});
