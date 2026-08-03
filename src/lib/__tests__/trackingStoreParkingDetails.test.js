import { beforeEach, describe, expect, it, vi } from 'vitest';

const parkingStorage = vi.hoisted(() => new Map());
const recordHistory = vi.hoisted(() => vi.fn(async (state) => ({
  ...state,
  state_revision: state.state_revision || state.location?.state_revision,
})));

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: vi.fn(async (key, fallback) => (
    parkingStorage.has(key) ? structuredClone(parkingStorage.get(key)) : fallback
  )),
  removeEncryptedJson: vi.fn(async (key) => parkingStorage.delete(key)),
  setEncryptedJson: vi.fn(async (key, value) => {
    parkingStorage.set(key, structuredClone(value));
  }),
}));

vi.mock('@/lib/privacyZones', () => ({
  getHydratedPrivacyZones: vi.fn(async () => []),
  isPointInPrivacyZone: vi.fn(() => false),
  redactRoutePointForPrivacyStorage: vi.fn((point) => point),
  sanitizeTripForPrivacyStorage: vi.fn((trip) => trip),
}));

vi.mock('@/lib/parkingHistory', () => ({
  isParkingPhotoExpired: vi.fn(() => false),
  recordParkingHistoryState: recordHistory,
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: vi.fn(() => false),
}));

vi.mock('@/lib/driveSenseNativePlugin', () => ({
  default: {},
}));

vi.mock('@/lib/parkingDiagnostics', () => ({
  recordParkingDiagnostic: vi.fn(async () => null),
}));

import {
  getLastParkingState,
  LAST_PARKED_KEY,
  LAST_PARKING_STATE_KEY,
  saveLastParkedLocation,
} from '@/lib/trackingStore';

describe('saved parking detail authority', () => {
  beforeEach(() => {
    parkingStorage.clear();
    recordHistory.mockClear();
    recordHistory.mockImplementation(async (state) => ({
      ...state,
      state_revision: state.state_revision || state.location?.state_revision,
    }));
  });

  it('reads back the same note, photo, vehicle, garage and revision shown by the UI', async () => {
    const photo = 'data:image/jpeg;base64,cGFya2luZw==';
    const saved = await saveLastParkedLocation({
      lat: 43.6501,
      lng: -79.3801,
      endpointLat: 43.6501,
      endpointLng: -79.3801,
      timestamp: '2026-08-01T12:00:00.000Z',
      tripId: 'manual-parking-details',
      source: 'manual_save_where_parked',
      confidence: 'high',
      confidenceScore: 100,
      evidence: ['manual_location_verified'],
      accuracyM: 7,
      vehicleId: 'vehicle-2',
      vehicleName: 'Blue SUV',
      indoorEstimated: true,
      garageEntrance: { lat: 43.6502, lng: -79.3802, accuracy_m: 9 },
      garageHint: 'Level 3, blue elevators',
      note: 'Section B, pillar 14',
      photoDataUrl: photo,
      photoExpiresAt: '2026-08-03T12:00:00.000Z',
      photoRetentionHours: 48,
      verified: true,
    });

    const state = await getLastParkingState();
    expect(state).toMatchObject({
      status: 'saved',
      state_revision: saved.state_revision,
      location: {
        note: 'Section B, pillar 14',
        photo_data_url: photo,
        photo_retention_hours: 48,
        vehicle_id: 'vehicle-2',
        vehicle_name: 'Blue SUV',
        indoor_estimated: true,
        garage_hint: 'Level 3, blue elevators',
        verified: true,
        state_revision: saved.state_revision,
      },
    });
    expect(parkingStorage.get(LAST_PARKED_KEY)).toMatchObject(state.location);
    expect(parkingStorage.get(LAST_PARKING_STATE_KEY)).toMatchObject({
      status: 'saved',
      state_revision: saved.state_revision,
    });
    expect(recordHistory).toHaveBeenCalledWith(expect.objectContaining({
      location: expect.objectContaining({
        note: 'Section B, pillar 14',
        photo_data_url: photo,
      }),
    }));
  });

  it('restores the previous current parking when history persistence fails', async () => {
    const previousLocation = {
      lat: 43.64,
      lng: -79.37,
      timestamp: '2026-08-01T10:00:00.000Z',
      tripId: 'previous-parking',
      state_revision: 100,
    };
    parkingStorage.set(LAST_PARKED_KEY, previousLocation);
    parkingStorage.set(LAST_PARKING_STATE_KEY, {
      status: 'saved',
      timestamp: previousLocation.timestamp,
      tripId: previousLocation.tripId,
      state_revision: 100,
    });
    recordHistory.mockRejectedValueOnce(new Error('encrypted history write failed'));

    await expect(saveLastParkedLocation({
      lat: 43.65,
      lng: -79.38,
      timestamp: '2026-08-01T12:00:00.000Z',
      tripId: 'new-parking',
      confidenceScore: 100,
      verified: true,
    })).rejects.toThrow('previous parking was restored');

    expect(parkingStorage.get(LAST_PARKED_KEY)).toEqual(previousLocation);
    expect(parkingStorage.get(LAST_PARKING_STATE_KEY)).toMatchObject({
      tripId: 'previous-parking',
      state_revision: 100,
    });
  });
});
