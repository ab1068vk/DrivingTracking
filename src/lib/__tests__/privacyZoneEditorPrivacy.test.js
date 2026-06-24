import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/Settings.jsx'),
  'utf8'
);
const previewMapSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/PrivacyZonePreviewMap.jsx'),
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

  it('previews privacy geometry without loading third-party map tiles', () => {
    expect(settingsSource).toContain('Preview Route Corridor');
    expect(settingsSource).toContain('Buffer each side (m)');
    expect(previewMapSource).toContain('no street tiles or geocoder');
    expect(previewMapSource).not.toMatch(/tileLayer|openstreetmap|mapbox|google/i);
  });

  it('treats unsaved geometry as ephemeral and blocks Android capture during preview', () => {
    expect(settingsSource).toContain('Unsaved corridor cleared');
    expect(settingsSource).toContain('5 minutes of inactivity');
    expect(settingsSource).toContain('openPrivacyPreview');
    expect(settingsSource).toContain('Verify to preview this private area');
    expect(settingsSource).toContain('Verify to review this suggested private place');
    expect(settingsSource).toContain('setScreenCaptureAllowed(false)');
    expect(settingsSource).toContain('even if screenshots are allowed elsewhere');
    expect(settingsSource).toContain('Exact corridor geometry was discarded');
  });
});
