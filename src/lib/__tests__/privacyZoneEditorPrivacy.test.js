import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/Settings.jsx'),
  'utf8'
);
const protectionCheckSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/PrivacyZoneProtectionCheck.jsx'),
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
      'High sensitivity also blocks OSRM route sharing whenever a route touches the zone.'
    );
    expect(settingsSource).toContain('Existing raw GPS inside this zone is erased when the zone is saved.');
  });

  it('checks privacy protection locally without map tiles or a remote geocoder', () => {
    expect(settingsSource).toContain('Check protected corridor');
    expect(settingsSource).toContain('Add at least {PRIVACY_CORRIDOR_MIN_WAYPOINTS} route points to check corridor protection');
    expect(settingsSource).toContain('Buffer each side (m)');
    expect(settingsSource).toContain('This authenticated check uses local geometry only.');
    expect(protectionCheckSource).toContain('Local geometry diagram');
    expect(protectionCheckSource).toContain('No street map');
    expect(protectionCheckSource).toContain('Protected privacy circle diagram');
    expect(protectionCheckSource).toContain('protected on each side');
    expect(protectionCheckSource).toContain('It does not load street-map tiles, run a geocoder, or send coordinates away from the app.');
    expect(protectionCheckSource).not.toMatch(/tile\.openstreetmap|leaflet|REMOTE_TILES|nominatim|mapbox|google/i);
    expect(protectionCheckSource).not.toMatch(/geocod(?:e|ing)\s*\(/i);
  });

  it('treats unsaved geometry as ephemeral and blocks Android capture during the protection check', () => {
    expect(settingsSource).toContain('Unsaved corridor cleared');
    expect(settingsSource).toContain('5 minutes of inactivity');
    expect(settingsSource).toContain('openPrivacyProtectionCheck');
    expect(settingsSource).toContain('Verify to review this private area');
    expect(settingsSource).toContain('Verify to review this suggested private place');
    expect(settingsSource).toContain('setScreenCaptureAllowed(false)');
    expect(settingsSource).toContain('even if screenshots are allowed elsewhere');
    expect(settingsSource).toContain('Exact corridor geometry was discarded');
  });
});
