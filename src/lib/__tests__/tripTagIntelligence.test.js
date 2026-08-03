import { describe, expect, it } from 'vitest';
import {
  getTripTagOption,
  normalizeTripTagId,
  normalizeTripTags,
} from '@/lib/tripMetadata';
import {
  getEffectiveTripTags,
  inferTripTags,
  reconcileWeatherDerivedTags,
} from '@/lib/tripTagIntelligence';

const mondayMorning = new Date(2026, 6, 27, 8, 0, 0).toISOString();

describe('trip tag intelligence', () => {
  it('returns multiple explainable tags across purpose, route, and conditions', () => {
    const result = inferTripTags({
      id: 'smart-trip',
      start_time: mondayMorning,
      duration_seconds: 35 * 60,
      distance_km: 24,
      night_driving: true,
      dominant_road_type: 'highway',
      weather_context: {
        source: 'open_meteo',
        condition: 'rain',
      },
    });

    expect(result.recommended_tags).toEqual(expect.arrayContaining([
      'commute',
      'highway',
      'night',
      'rain',
    ]));
    expect(result.auto_apply_tags).toEqual(expect.arrayContaining([
      'highway',
      'night',
      'rain',
    ]));
    expect(result.candidates.every((candidate) => (
      candidate.reason && candidate.source && candidate.confidence_label
    ))).toBe(true);
  });

  it('learns a purpose tag from repeated user-confirmed routes', () => {
    const history = [
      {
        id: 'earlier-1',
        route_key: 'local-route-a',
        tags: ['school_run', 'city'],
        tag_reviewed: true,
      },
      {
        id: 'earlier-2',
        route_key: 'local-route-a',
        tags: ['school_run'],
        tag_reviewed: true,
      },
      {
        id: 'earlier-3',
        route_key: 'local-route-a',
        tags: ['commute'],
        tag_reviewed: true,
      },
    ];
    const result = inferTripTags({
      id: 'current',
      route_key: 'local-route-a',
      start_time: mondayMorning,
      duration_seconds: 25 * 60,
      distance_km: 12,
    }, history);

    expect(result.primary.tag).toBe('school_run');
    expect(result.primary.source).toBe('confirmed_route_learning');
    expect(result.primary.reason).toContain('2 times');
    expect(result.auto_apply_tags).toContain('school_run');
  });

  it('does not add inferred tags after the driver reviewed a trip', () => {
    const reviewedTrip = {
      id: 'reviewed',
      start_time: mondayMorning,
      dominant_road_type: 'highway',
      night_driving: true,
      tags: ['leisure'],
      tag_reviewed: true,
    };

    expect(getEffectiveTripTags(reviewedTrip)).toEqual(['leisure']);
  });

  it('keeps existing purpose and route tags exclusive while adding conditions', () => {
    const tags = getEffectiveTripTags({
      id: 'exclusive-categories',
      start_time: mondayMorning,
      duration_seconds: 8 * 60,
      distance_km: 4,
      dominant_road_type: 'highway',
      night_driving: true,
      tags: ['commute', 'city'],
    });

    expect(tags).toEqual(expect.arrayContaining(['commute', 'city', 'night']));
    expect(tags).not.toContain('errand');
    expect(tags).not.toContain('highway');
  });

  it('preserves safe custom tags and creates readable custom options', () => {
    expect(normalizeTripTagId('Client Visit!')).toBe('client_visit');
    expect(normalizeTripTags(['Client Visit!', 'client_visit', 'Highway'])).toEqual([
      'client_visit',
      'highway',
    ]);
    expect(getTripTagOption('client_visit')).toMatchObject({
      id: 'client_visit',
      label: 'Client Visit',
      category: 'custom',
      custom: true,
    });
  });

  it('removes a stale automatically derived rain tag when trusted weather becomes clear', () => {
    const patch = reconcileWeatherDerivedTags({
      tags: ['city', 'rain', 'errand'],
      tag: 'city',
      auto_tags: ['city', 'rain'],
      tag_sources: {
        city: { source: 'road_evidence' },
        rain: { source: 'weather_evidence' },
        errand: { source: 'trip_pattern' },
      },
      tag_candidates: [
        { tag: 'city', source: 'road_evidence' },
        { tag: 'rain', source: 'weather_evidence' },
      ],
    }, {
      source: 'user_confirmed',
      condition: 'clear',
    });

    expect(patch.tags).toEqual(['city', 'errand']);
    expect(patch.auto_tags).not.toContain('rain');
    expect(patch.tag_sources.rain).toBeUndefined();
    expect(patch.tag_candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'rain' }),
    ]));
  });

  it('hides already-stored stale weather evidence immediately on read', () => {
    expect(normalizeTripTags({
      tags: ['city', 'rain', 'errand'],
      tag_sources: {
        rain: { source: 'weather_evidence' },
      },
      weather_context: {
        source: 'user_confirmed',
        condition: 'clear',
      },
    })).toEqual(['city', 'errand']);
  });

  it('preserves a rain tag that the driver explicitly confirmed', () => {
    const patch = reconcileWeatherDerivedTags({
      tags: ['rain'],
      tag: 'rain',
      tag_reviewed: true,
      tag_sources: {
        rain: { source: 'user_confirmed' },
      },
    }, {
      source: 'open_meteo',
      condition: 'clear',
    });

    expect(patch.tags).toEqual(['rain']);
    expect(patch.tag_sources.rain.source).toBe('user_confirmed');
  });

  it('replaces an automatically derived rain tag with snow evidence', () => {
    const patch = reconcileWeatherDerivedTags({
      tags: ['rain', 'errand'],
      tag: 'rain',
      auto_tag: 'rain',
      auto_tags: ['rain', 'errand'],
      tag_sources: {
        rain: { source: 'weather_evidence' },
        errand: { source: 'trip_pattern' },
      },
    }, {
      source: 'open_meteo',
      condition: 'snow',
    });

    expect(patch.tags).toEqual(['errand', 'snow']);
    expect(patch.tag).toBe('errand');
    expect(patch.auto_tags).toEqual(['errand', 'snow']);
    expect(patch.tag_sources.snow).toMatchObject({ source: 'weather_evidence' });
  });
});
