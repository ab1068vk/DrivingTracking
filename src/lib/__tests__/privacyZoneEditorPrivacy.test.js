import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/Settings.jsx'),
  'utf8'
);

describe('privacy zone editor network privacy', () => {
  it('keeps typed place text local and exposes no third-party geocoding path', () => {
    expect(settingsSource).toContain(
      'Zone creation does not send typed labels or addresses to a geocoder'
    );
    expect(settingsSource).not.toMatch(/nominatim|mapbox.*geocod|google.*geocod|geocod(?:e|ing)\s*\(/i);
    expect(settingsSource).not.toMatch(/placeholder=["'][^"']*address/i);
  });

  it('documents the high-sensitivity OSRM override in the editor', () => {
    expect(settingsSource).toContain(
      "High-sensitivity zones never share route data with OSRM, even if you&apos;ve consented elsewhere."
    );
  });
});
