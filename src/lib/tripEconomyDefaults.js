export const DEFAULT_FUEL_PRICE_PER_LITER = 1.65;
export const DEFAULT_L_PER_100KM = 8.5;
export const DEFAULT_EV_KWH_PER_100KM = 18;
export const DEFAULT_GRID_CO2_KG_PER_KWH = 0.04;
export const DEFAULT_CO2_BASELINE_KG_PER_100KM = 12.0;
// USDA/Arbor Day cite >48 lb CO2/year for a mature tree; 21 kg/year keeps this as a conservative planning value.
export const DEFAULT_TREE_CO2_KG_PER_YEAR = 21.0;
export const ECO_DRIVING_MAX_ECONOMY_ADJUSTMENT = 0.08;
export const GASOLINE_CO2_KG_PER_LITER = 2.31;
export const CO2_KG_PER_LITER = {
  gasoline: 2.31,
  petrol: 2.31,
  diesel: 2.68,
  lpg: 1.65,
  cng: 2.0,
  hybrid: 2.10,
  electric: 0,
  ev: 0,
};

/**
 * Provisional maintenance conversion used for extra-wear estimates.
 *
 * Calibration intent: one driving stress unit is currently treated as about
 * 8 km of service-life reserve consumed. This has not been calibrated against
 * OEM tire/service interval data, so maintenance reminders should treat it as
 * a planning heuristic rather than a manufacturer-backed life estimate.
 */
export const WEAR_KM_PER_STRESS_UNIT = 8;
export const MAINTENANCE_CALIBRATION_REGISTRY = {
  wearKmPerStressUnit: {
    value: WEAR_KM_PER_STRESS_UNIT,
    unit: 'km_per_stress_unit',
    calibrationStatus: 'provisional',
    calibrationBasis: 'Not calibrated to OEM tire or maintenance interval data.',
    note: '1 stress unit is assumed to consume about 8 km of service-life reserve until manufacturer or fleet outcome data is available.',
  },
};

export const DEFAULT_MAINTENANCE_ITEMS = [
  { id: 'oil', label: 'Oil change', interval_km: 8000, last_service_km: 0 },
  { id: 'tires', label: 'Tire rotation', interval_km: 10000, last_service_km: 0 },
  { id: 'brakes', label: 'Brake check', interval_km: 20000, last_service_km: 0 },
  { id: 'inspection', label: 'Inspection', interval_km: 20000, last_service_km: 0 },
];
