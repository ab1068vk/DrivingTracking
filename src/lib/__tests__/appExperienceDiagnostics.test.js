import { describe, expect, it } from 'vitest';
import {
  APP_EXPERIENCE_REPORT_KIND,
  buildAppActivityProfile,
  buildAppExperienceReport,
  buildRuntimeProfile,
  buildTripDataProfile,
  parseAppExperienceReport,
} from '@/lib/appExperienceDiagnostics';

describe('app experience diagnostics', () => {
  it('builds useful anonymous trip data without private trip content', () => {
    const profile = buildTripDataProfile([{
      id: 'private-trip-id',
      status: 'completed',
      start_time: '2026-08-02T12:00:00Z',
      end_time: '2026-08-02T12:30:00Z',
      distance_km: 12.34,
      route_points_map_count: 456,
      route_replay_available: true,
      nickname: 'Secret commute',
      notes: 'Home address is private',
      route_points: [{ lat: 43.1, lng: -79.2 }],
      sensor_fusion_summary: { sample_count: 20 },
      start_source: 'native_auto',
    }]);

    expect(profile).toMatchObject({
      trip_count: 1,
      completed_trip_count: 1,
      total_distance_km: 12.3,
      total_route_point_count: 456,
      advanced_evidence_trip_count: 1,
      automatic_trip_count: 1,
    });
    expect(profile.anonymous_trip_shapes[0]).toMatchObject({
      distance_km: 12.3,
      duration_minutes: 30,
      route_point_count: 456,
    });
    const exported = JSON.stringify(profile);
    expect(exported).not.toContain('private-trip-id');
    expect(exported).not.toContain('Secret commute');
    expect(exported).not.toContain('43.1');
    expect(exported).not.toContain('2026-08-02T12:00:00Z');
  });

  it('classifies crashes, deletion, settings, transfers, coaching, and advanced mode activity', () => {
    const activity = buildAppActivityProfile([
      { timestamp: '2026-08-02T12:00:00Z', severity: 'error', operation: 'section_crash' },
      { timestamp: '2026-08-02T12:01:00Z', operation: 'secure_trip_deletion_completed' },
      { timestamp: '2026-08-02T12:02:00Z', operation: 'settings_changed', details: { changed_keys: ['units'] } },
      { timestamp: '2026-08-02T12:03:00Z', operation: 'backup_export_completed' },
      { timestamp: '2026-08-02T12:04:00Z', operation: 'fetch_non_ok', details: { status: 503, origin: 'https://private.example' } },
      { timestamp: '2026-08-02T12:05:00Z', operation: 'coach_program_started' },
      { timestamp: '2026-08-02T12:06:00Z', operation: 'native_tracking_started' },
      { timestamp: '2026-08-02T12:07:00Z', operation: 'android_ui_stall', duration_ms: 6500 },
      { timestamp: '2026-08-02T12:08:00Z', operation: 'android_memory_pressure', memory_available_bytes: 1000 },
    ]);

    expect(activity.counts).toMatchObject({
      crashes_and_failures: 1,
      trip_deletions: 1,
      settings_changes: 1,
      imports_and_exports: 1,
      network_responses: 1,
      coaching_experience: 1,
      advanced_tracking: 1,
      freezes_and_anrs: 1,
      resource_pressure: 1,
    });
    expect(JSON.stringify(activity)).not.toContain('private.example');
    expect(activity.recent_important_events.find((event) => event.operation === 'fetch_non_ok')?.details.status).toBe(503);
  });

  it('keeps Android resource evidence and last operation privacy-safe', () => {
    const runtime = buildRuntimeProfile({
      memory_available_bytes: 2_000_000,
      heap_used_bytes: 500_000,
      storage_usable_bytes: 9_000_000,
      thermal_status: 2,
      thermal_label: 'moderate',
      battery_temperature_c: 37.2,
      last_operation: {
        operation: 'tripService.getById',
        phase: 'start',
        pathname: '/trips/private-trip-id?token=secret',
        timestamp: '2026-08-02T12:00:00Z',
        note: 'must not export',
      },
    });

    expect(runtime).toMatchObject({
      available: true,
      memory_available_bytes: 2_000_000,
      thermal_label: 'moderate',
      battery_temperature_c: 37.2,
      last_operation: {
        operation: 'tripService.getById',
        phase: 'start',
        pathname: '/trips/:id',
      },
    });
    expect(JSON.stringify(runtime)).not.toContain('private-trip-id');
    expect(JSON.stringify(runtime)).not.toContain('token');
    expect(JSON.stringify(runtime)).not.toContain('must not export');
  });

  it('exports a privacy-declared report and imports only a read-only sanitized comparison', () => {
    const report = buildAppExperienceReport({
      trips: [{ id: 'trip-secret', status: 'completed', distance_km: 4.56, notes: 'private note' }],
      performanceEntries: [
        { id: 'p1', name: 'page.firstPaint', pathname: '/coach', durationMs: 210, at: '2026-08-02T12:00:00Z' },
        { id: 'p2', name: 'tripService.listAllSummaries', durationMs: 3200, at: '2026-08-02T12:01:00Z' },
      ],
      systemEvents: [{
        timestamp: '2026-08-02T12:02:00Z',
        operation: 'settings_changed',
        details: { changed_keys: ['tracking_mode'], changes: { tracking_mode: { before: 'manual', after: 'background_auto' } } },
      }],
      settings: {
        experience_mode: 'tracking',
        tracking_mode: 'background_auto',
        osrm_map_matching_url: 'https://private.example/route',
      },
    });

    expect(report.report_kind).toBe(APP_EXPERIENCE_REPORT_KIND);
    expect(report.privacy.precise_locations_included).toBe(false);
    expect(report.app).toMatchObject({ experience_mode: 'tracking', tracking_mode: 'background_auto' });
    const exported = JSON.stringify(report);
    expect(exported).not.toContain('trip-secret');
    expect(exported).not.toContain('private note');
    expect(exported).not.toContain('private.example');
    expect(report.activity.recent_important_events[0].details).toEqual({ changed_keys: ['tracking_mode'] });

    const imported = parseAppExperienceReport(JSON.stringify({
      ...report,
      health: { ...report.health, headline: '<script>alert(1)</script>' },
      performance: {
        ...report.performance,
        operations: [{ name: 'trip load <script>', pathname: '/trips/private-trip-id?token=secret', count: 2, p95Ms: 900 }],
      },
      activity: {
        ...report.activity,
        recent_important_events: [{ message: 'must not survive import' }],
      },
    }));
    expect(imported.performance.operations[0].name).toBe('trip_load__script_');
    expect(imported.performance.operations[0].pathname).toBe('/trips/:id');
    expect(imported.activity.recent_important_events).toEqual([]);
  });

  it('rejects unrelated JSON', () => {
    expect(() => parseAppExperienceReport('{"kind":"backup"}')).toThrow(/not a Road Sage/i);
  });
});
