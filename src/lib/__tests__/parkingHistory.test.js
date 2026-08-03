import { beforeEach, describe, expect, it, vi } from 'vitest';

const encrypted = new Map();

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: vi.fn(async (key, fallback) => encrypted.has(key) ? encrypted.get(key) : fallback),
  removeEncryptedJson: vi.fn(async (key) => encrypted.delete(key)),
  setEncryptedJson: vi.fn(async (key, value) => encrypted.set(key, structuredClone(value))),
}));

import {
  clearParkingHistory,
  deleteParkingHistoryRecord,
  getParkingHistory,
  getParkingHistoryPageWindow,
  getVehicleParkingStates,
  recordParkingHistoryState,
  rejectParkingHistoryRecord,
  updateParkingHistoryRecord,
} from '@/lib/parkingHistory';

describe('parking history', () => {
  beforeEach(() => encrypted.clear());

  it('stores privacy-protected stops without coordinates or manual media', async () => {
    await recordParkingHistoryState({
      status: 'private',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'private-trip',
      source: 'privacy_zone',
      location: {
        lat: 43.65,
        lng: -79.38,
        note: 'Home',
        photo_data_url: 'data:image/jpeg;base64,abc',
      },
    });

    expect(await getParkingHistory()).toEqual([
      expect.objectContaining({
        id: 'trip:private-trip',
        status: 'private',
      }),
    ]);
    expect((await getParkingHistory())[0]).not.toHaveProperty('location');
    expect((await getParkingHistory())[0]).not.toHaveProperty('note');
    expect((await getParkingHistory())[0]).not.toHaveProperty('photo_data_url');
  });

  it('keeps state revision, vehicle, and garage metadata for widget/page parity', async () => {
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'garage-trip',
      state_revision: 12345,
      source: 'manual_save_where_parked',
      location: {
        lat: 43.65,
        lng: -79.38,
        state_revision: 12345,
        vehicle_id: 'car-2',
        vehicle_name: 'Blue SUV',
        indoor_estimated: true,
        garage_hint: 'Level 3, blue elevators',
        garage_entrance: { lat: 43.6501, lng: -79.3801, accuracy_m: 12 },
      },
    });

    expect((await getParkingHistory())[0]).toMatchObject({
      state_revision: 12345,
      location: {
        state_revision: 12345,
        vehicle_id: 'car-2',
        vehicle_name: 'Blue SUV',
        indoor_estimated: true,
        garage_hint: 'Level 3, blue elevators',
        garage_entrance: { lat: 43.6501, lng: -79.3801, accuracy_m: 12 },
      },
    });
    expect(await getVehicleParkingStates()).toMatchObject({
      'car-2': {
        status: 'saved',
        location: { vehicle_id: 'car-2', garage_hint: 'Level 3, blue elevators' },
      },
    });
  });

  it('keeps independent latest parking states and photo retention for different vehicles', async () => {
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'car-a-stop',
      vehicle_id: 'car-a',
      vehicle_name: 'Car A',
      location: {
        lat: 43.65,
        lng: -79.38,
        vehicle_id: 'car-a',
        vehicle_name: 'Car A',
        photo_data_url: 'data:image/jpeg;base64,Y2FyLWE=',
      },
    });
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T13:00:00.000Z',
      tripId: 'car-b-stop',
      vehicle_id: 'car-b',
      vehicle_name: 'Car B',
      location: {
        lat: 43.66,
        lng: -79.39,
        vehicle_id: 'car-b',
        vehicle_name: 'Car B',
        photo_data_url: 'data:image/jpeg;base64,Y2FyLWI=',
      },
    });

    const states = await getVehicleParkingStates();
    expect(Object.keys(states).sort()).toEqual(['car-a', 'car-b']);
    expect(states['car-a'].photo_data_url).toBe('data:image/jpeg;base64,Y2FyLWE=');
    expect(states['car-b'].photo_data_url).toBe('data:image/jpeg;base64,Y2FyLWI=');
    const history = await getParkingHistory();
    expect(history.find((record) => record.id === 'trip:car-a-stop')?.photo_data_url)
      .toBe('data:image/jpeg;base64,Y2FyLWE=');
  });

  it('updates a refined event while preserving its local note and photo', async () => {
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'shop-trip',
      source: 'manual_marker_correction',
      verified: true,
      location: {
        lat: 43.65,
        lng: -79.38,
        confidence_score: 100,
        note: 'Level 3, section B',
        photo_data_url: 'data:image/jpeg;base64,abc',
      },
    });
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'shop-trip',
      source: 'trip_end_refined',
      location: {
        lat: 43.65001,
        lng: -79.38001,
        confidence_score: 92,
        refinement_count: 5,
      },
    });

    const [record] = await getParkingHistory();
    expect(record.location).toMatchObject({
      lat: 43.65001,
      confidence_score: 92,
      refinement_count: 5,
    });
    expect(record.note).toBe('Level 3, section B');
    expect(record.photo_data_url).toBe('data:image/jpeg;base64,abc');
    expect(record.verified).toBe(true);
  });

  it('permanently removes a photo from an existing history record', async () => {
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'photo-removal',
      source: 'manual_save_where_parked',
      location: {
        lat: 43.65,
        lng: -79.38,
        photo_data_url: 'data:image/jpeg;base64,remove-me',
      },
    });

    await updateParkingHistoryRecord('trip:photo-removal', { photo_data_url: null });
    expect((await getParkingHistory())[0].photo_data_url).toBeNull();
  });

  it('automatically removes an expired photo while retaining its parking record', async () => {
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'expired-photo',
      source: 'manual_save_where_parked',
      location: {
        lat: 43.65,
        lng: -79.38,
        photo_data_url: 'data:image/jpeg;base64,expired',
        photo_expires_at: new Date(Date.now() - 60_000).toISOString(),
        photo_retention_hours: 24,
      },
    });

    const [record] = await getParkingHistory();
    expect(record).toMatchObject({
      id: 'trip:expired-photo',
      status: 'saved',
    });
    expect(record.photo_data_url).toBeNull();
    expect(record.photo_expires_at).toBeNull();
    expect(record.photo_retention_hours).toBeNull();
  });

  it('retains an unexpired photo with its selected deadline', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'hotel-photo',
      source: 'manual_save_where_parked',
      location: {
        lat: 43.65,
        lng: -79.38,
        photo_data_url: 'data:image/jpeg;base64,hotel',
        photo_expires_at: expiresAt,
        photo_retention_hours: 168,
      },
    });

    expect((await getParkingHistory())[0]).toMatchObject({
      photo_data_url: 'data:image/jpeg;base64,hotel',
      photo_expires_at: expiresAt,
      photo_retention_hours: 168,
    });

    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'hotel-photo',
      source: 'manual_marker_correction',
      location: {
        lat: 43.65,
        lng: -79.38,
        photo_data_url: 'data:image/jpeg;base64,hotel',
        photo_expires_at: null,
        photo_retention_hours: 0,
      },
    });
    expect((await getParkingHistory())[0]).toMatchObject({
      photo_data_url: 'data:image/jpeg;base64,hotel',
      photo_expires_at: null,
      photo_retention_hours: 0,
    });
  });

  it('keeps a photo only for the newest public parking record', async () => {
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'first-shop',
      source: 'manual_save_where_parked',
      location: {
        lat: 43.65,
        lng: -79.38,
        photo_data_url: 'data:image/jpeg;base64,first',
      },
    });
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T13:00:00.000Z',
      tripId: 'second-shop',
      source: 'trip_end',
      location: {
        lat: 43.66,
        lng: -79.39,
        photo_data_url: 'data:image/jpeg;base64,second',
      },
    });

    const history = await getParkingHistory();
    expect(history.find((record) => record.id === 'trip:second-shop')?.photo_data_url)
      .toBe('data:image/jpeg;base64,second');
    expect(history.find((record) => record.id === 'trip:first-shop')?.photo_data_url)
      .toBeNull();
  });

  it('removes all previous photos when the current parking state is private', async () => {
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'public-shop',
      source: 'manual_save_where_parked',
      location: {
        lat: 43.65,
        lng: -79.38,
        photo_data_url: 'data:image/jpeg;base64,shop',
      },
    });
    await recordParkingHistoryState({
      status: 'private',
      timestamp: '2026-07-29T13:00:00.000Z',
      tripId: 'home',
      source: 'privacy_zone',
    });

    const history = await getParkingHistory();
    expect(history.find((record) => record.id === 'trip:public-shop')?.photo_data_url)
      .toBeNull();
    expect(history.find((record) => record.id === 'trip:home')).toMatchObject({
      status: 'private',
    });
  });

  it('deletes one parking record or clears all records', async () => {
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'first',
      source: 'trip_end',
      location: { lat: 43.65, lng: -79.38 },
    });
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T13:00:00.000Z',
      tripId: 'second',
      source: 'trip_end',
      location: { lat: 43.66, lng: -79.39 },
    });

    expect(await deleteParkingHistoryRecord('trip:first')).toBe(true);
    expect((await getParkingHistory()).map((record) => record.id)).toEqual(['trip:second']);
    expect(await deleteParkingHistoryRecord('trip:missing')).toBe(false);

    await clearParkingHistory();
    expect(await getParkingHistory()).toEqual([]);
  });

  it('marks an incorrect automatic result as rejected', async () => {
    await recordParkingHistoryState({
      status: 'saved',
      timestamp: '2026-07-29T12:00:00.000Z',
      tripId: 'wrong-trip',
      source: 'trip_end',
      location: { lat: 43.65, lng: -79.38 },
    });
    await rejectParkingHistoryRecord('trip:wrong-trip');
    expect((await getParkingHistory())[0]).toMatchObject({
      rejected: true,
      correction_reason: 'not_where_parked',
    });
  });

  it('builds bounded pages and clamps stale page requests', () => {
    expect(getParkingHistoryPageWindow(14, 0, 6)).toEqual({
      page: 0,
      pageCount: 3,
      offset: 0,
      start: 1,
      end: 6,
    });
    expect(getParkingHistoryPageWindow(14, 99, 6)).toEqual({
      page: 2,
      pageCount: 3,
      offset: 12,
      start: 13,
      end: 14,
    });
    expect(getParkingHistoryPageWindow(0, 4, 6)).toEqual({
      page: 0,
      pageCount: 1,
      offset: 0,
      start: 0,
      end: 0,
    });
  });
});
