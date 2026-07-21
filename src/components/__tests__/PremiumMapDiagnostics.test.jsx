import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PremiumMapDiagnostics, {
  buildPremiumMapDiagnosticsAggregate,
  buildPremiumMapDiagnosticsModel,
} from '@/components/PremiumMapDiagnostics';

const trip = {
  distance_km: 8.4,
  duration_seconds: 920,
  avg_speed_kmh: 39,
  avg_running_speed_kmh: 48,
  max_speed_kmh: 74,
  route_points_raw_count: 987654,
  satellite_count: 36,
  route_points: [{ lat: 1, lng: 2 }],
  driving_events: [{ type: 'harsh_brake' }, { type: 'speeding' }],
  traffic_stop_count: 3,
  score_overall: 88,
  score_overall_confidence: 'high',
};

describe('PremiumMapDiagnostics', () => {
  it('formats real trip values using the current units and full evidence counts', () => {
    expect(buildPremiumMapDiagnosticsModel(trip, 'imperial')).toMatchObject({
      distance: '5.2 mi',
      maximumSpeed: '46 mph',
      averageSpeed: '24 mph',
      duration: '15m 20s',
      gpsPoints: '987,654',
      satellites: '36',
      satellitesAvailable: true,
      eventCount: '2',
      stops: '3',
      score: '~88',
    });
  });

  it('keeps missing and zero-data values explicit without demonstration data', () => {
    expect(buildPremiumMapDiagnosticsModel({}, 'metric')).toMatchObject({
      distance: '0 m',
      maximumSpeed: '0 km/h',
      averageSpeed: '0 km/h',
      duration: '0m',
      gpsPoints: '0',
      satellites: '\u2014',
      satellitesAvailable: false,
      eventCount: '0',
      stops: '0',
    });
  });

  it('aggregates the routes drawn by the all-filtered overview', () => {
    expect(buildPremiumMapDiagnosticsAggregate([
      trip,
      {
        distance_km: 4.2,
        duration_seconds: 460,
        avg_speed_kmh: 39,
        max_speed_kmh: 81,
        route_points_raw_count: 12,
        driving_events_count: 1,
        stop_count: 2,
      },
    ])).toMatchObject({
      distance_km: expect.closeTo(12.6, 10),
      duration_seconds: 1380,
      max_speed_kmh: 81,
      avg_speed_kmh: expect.closeTo(32.87, 2),
      route_points_raw_count: 987666,
      driving_events_count: 3,
      traffic_stop_count: 5,
    });
  });

  it('renders the generated route artwork, semantic metrics, and preserved show-all action', () => {
    const html = renderToStaticMarkup(
      <PremiumMapDiagnostics trip={trip} units="metric" loading={false} onShowAll={() => {}} />,
    );

    expect(html).toContain('class="premium-map-diagnostics"');
    expect(html).toContain('premium-map-route-intelligence.png');
    expect(html).toContain('Route diagnostics');
    expect(html).toContain('Standard');
    expect(html).toContain('Maximum speed');
    expect(html).toContain('Average including stops');
    expect(html).toContain('987,654 GPS');
    expect(html).toContain('<strong>36</strong><small>Satellites</small>');
    expect(html).toContain('Show all routes');
    expect(html.match(/class="premium-map-diagnostic-metric"/g)).toHaveLength(4);
  });

  it('uses the compact overlay composition inside the premium live map', () => {
    const html = renderToStaticMarkup(
      <PremiumMapDiagnostics trip={trip} units="metric" onShowAll={() => {}} onDismiss={() => {}} overlay />,
    );

    expect(html).toContain('premium-map-diagnostics--overlay');
    expect(html).toContain('premium-map-diagnostics--dismissible');
    expect(html).toContain('aria-label="Hide route diagnostics"');
    expect(html).toContain('premium-map-diagnostic-stack');
    expect(html).toContain('>Stops</span>');
    expect(html).toContain('average including stops');
    expect(html).toContain('Show all routes');
    expect(html).toContain('<strong>36</strong><small>Satellites</small>');
  });

  it('keeps all route diagnostic information in the standard visual experience', () => {
    const html = renderToStaticMarkup(
      <PremiumMapDiagnostics trip={trip} units="metric" onShowAll={() => {}} premium={false} />,
    );

    expect(html).toContain('premium-map-diagnostics--standard');
    expect(html).toContain('data-visual-experience="standard"');
    expect(html).not.toContain('premium-map-route-intelligence.png');
    expect(html).toContain('Maximum speed');
    expect(html).toContain('Stops');
    expect(html).toContain('Recorded time');
    expect(html).toContain('Average including stops');
    expect(html).toContain('987,654 GPS');
    expect(html).toContain('<strong>36</strong><small>Satellites</small>');
    expect(html).toContain('Show all routes');
  });

  it('uses premium route diagnostics for the all-filtered map overview', () => {
    const html = renderToStaticMarkup(
      <PremiumMapDiagnostics trip={null} trips={[trip, { ...trip, satellite_count: 20 }]} units="metric" overlay />,
    );

    expect(html).toContain('premium-map-diagnostics--overlay');
    expect(html).toContain('Route diagnostics');
    expect(html).toContain('2 routes');
    expect(html).toContain('on map');
    expect(html).not.toContain('Show all routes');
  });
});
