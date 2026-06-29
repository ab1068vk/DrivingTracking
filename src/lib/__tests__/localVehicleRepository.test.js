import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageMocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  setJson: vi.fn(),
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: storageMocks.getJson,
  setJson: storageMocks.setJson,
}));

import { localVehicleRepository, VEHICLES_KEY } from '@/lib/localVehicleRepository';

describe('localVehicleRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.setJson.mockResolvedValue(undefined);
  });

  it('scrubs retired vehicle admin fields from legacy stored vehicles', async () => {
    storageMocks.getJson.mockResolvedValue([
      {
        id: 'vehicle_1',
        name: 'Daily driver',
        plate: 'ABC 123',
        registration_renewal_date: '2026-05-20',
        insurance_renewal_date: '2026-06-20',
        created_date: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const vehicles = await localVehicleRepository.list();

    expect(vehicles[0]).not.toHaveProperty('plate');
    expect(vehicles[0]).not.toHaveProperty('registration_renewal_date');
    expect(vehicles[0]).not.toHaveProperty('insurance_renewal_date');
    expect(storageMocks.setJson).toHaveBeenCalledWith(VEHICLES_KEY, expect.any(Array));
    const persisted = storageMocks.setJson.mock.calls.at(-1)[1][0];
    expect(persisted).not.toHaveProperty('plate');
    expect(persisted).not.toHaveProperty('registration_renewal_date');
    expect(persisted).not.toHaveProperty('insurance_renewal_date');
  });

  it('does not persist retired vehicle admin fields on create', async () => {
    storageMocks.getJson.mockResolvedValue([]);

    const vehicle = await localVehicleRepository.create({
      name: 'New car',
      plate: 'XYZ 789',
      registration_renewal_date: '2026-05-20',
      insurance_renewal_date: '2026-06-20',
    });

    expect(vehicle).not.toHaveProperty('plate');
    expect(vehicle).not.toHaveProperty('registration_renewal_date');
    expect(vehicle).not.toHaveProperty('insurance_renewal_date');
    expect(storageMocks.setJson).toHaveBeenCalledWith(VEHICLES_KEY, expect.any(Array));
    const persisted = storageMocks.setJson.mock.calls.at(-1)[1][0];
    expect(persisted).not.toHaveProperty('plate');
    expect(persisted).not.toHaveProperty('registration_renewal_date');
    expect(persisted).not.toHaveProperty('insurance_renewal_date');
  });
});
