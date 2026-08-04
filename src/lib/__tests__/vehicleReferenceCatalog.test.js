import { describe, expect, it } from 'vitest';
import {
  MANUFACTURER_REFERENCE_TEMPLATES,
  VEHICLE_MAINTENANCE_DISCLAIMER,
  VEHICLE_REFERENCE_CATALOG_VERSION,
  VEHICLE_REFERENCE_REVIEWED_AT,
  VEHICLE_REFERENCE_SOURCES,
  getVehicleReferenceSource,
  getVehicleReferenceSources,
} from '@/lib/vehicleReferenceCatalog';

describe('vehicle reference catalog data', () => {
  it('gives every source a unique id', () => {
    const ids = VEHICLE_REFERENCE_SOURCES.map((source) => source.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cites every source with an HTTPS URL and a publisher', () => {
    for (const source of VEHICLE_REFERENCE_SOURCES) {
      expect(source.publisher, `${source.id} has no publisher`).toBeTruthy();
      expect(source.title, `${source.id} has no title`).toBeTruthy();
      expect(source.url, `${source.id} is not HTTPS`).toMatch(/^https:\/\//);
    }
  });

  it('stamps every source with the catalog review date', () => {
    expect(VEHICLE_REFERENCE_REVIEWED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(VEHICLE_REFERENCE_CATALOG_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);

    for (const source of VEHICLE_REFERENCE_SOURCES) {
      expect(source.reviewed_at, `${source.id} is missing a review date`).toBe(VEHICLE_REFERENCE_REVIEWED_AT);
    }
  });

  it('targets each source at either specific makes or a region', () => {
    for (const source of VEHICLE_REFERENCE_SOURCES) {
      const targeted = Array.isArray(source.makes) || typeof source.region === 'string';
      expect(targeted, `${source.id} matches nothing`).toBe(true);
    }
  });

  it('keeps the maintenance disclaimer non-committal about service intervals', () => {
    expect(VEHICLE_MAINTENANCE_DISCLAIMER).toBeTruthy();
    expect(VEHICLE_MAINTENANCE_DISCLAIMER.length).toBeGreaterThan(20);
  });

  it('freezes the exported catalog against accidental mutation', () => {
    expect(Object.isFrozen(VEHICLE_REFERENCE_SOURCES)).toBe(true);
    expect(Object.isFrozen(MANUFACTURER_REFERENCE_TEMPLATES)).toBe(true);
  });
});

describe('getVehicleReferenceSource', () => {
  it('looks a source up by id', () => {
    const known = VEHICLE_REFERENCE_SOURCES[0];

    expect(getVehicleReferenceSource(known.id)).toEqual(known);
  });

  it('returns null rather than undefined for an unknown or empty id', () => {
    for (const value of ['nope', '', null, undefined, 0]) {
      expect(getVehicleReferenceSource(value)).toBeNull();
    }
  });
});

describe('getVehicleReferenceSources', () => {
  it('always returns an array, even for missing vehicle input', () => {
    expect(Array.isArray(getVehicleReferenceSources())).toBe(true);
    expect(Array.isArray(getVehicleReferenceSources({}))).toBe(true);
    expect(Array.isArray(getVehicleReferenceSources(null))).toBe(true);
  });

  it('defaults to the CA market, so CA and GLOBAL sources are offered', () => {
    const sources = getVehicleReferenceSources({});
    const regions = new Set(sources.map((source) => source.region).filter(Boolean));

    for (const region of regions) {
      expect(['CA', 'GLOBAL']).toContain(region);
    }
  });

  it('matches the market case-insensitively', () => {
    const upper = getVehicleReferenceSources({ market: 'CA' }).map((source) => source.id);
    const lower = getVehicleReferenceSources({ market: ' ca ' }).map((source) => source.id);

    expect(lower).toEqual(upper);
  });

  it('matches make-specific sources case-insensitively', () => {
    const makeSource = VEHICLE_REFERENCE_SOURCES.find((source) => Array.isArray(source.makes) && source.makes.length);
    if (!makeSource) return;
    const make = makeSource.makes[0];

    const ids = getVehicleReferenceSources({ make: make.toUpperCase() }).map((source) => source.id);
    expect(ids).toContain(makeSource.id);
  });

  it('omits make-specific sources for an unrelated make', () => {
    const ids = getVehicleReferenceSources({ make: 'not-a-real-make' }).map((source) => source.id);

    for (const source of VEHICLE_REFERENCE_SOURCES) {
      if (Array.isArray(source.makes)) expect(ids).not.toContain(source.id);
    }
  });

  it('returns only GLOBAL sources for a market with no regional entries', () => {
    const sources = getVehicleReferenceSources({ market: 'ZZ' });

    for (const source of sources) {
      const globalOrMakeScoped = source.region === 'GLOBAL' || Array.isArray(source.makes);
      expect(globalOrMakeScoped, `${source.id} leaked into an unknown market`).toBe(true);
    }
  });
});
