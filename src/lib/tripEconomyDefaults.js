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

/** Retired compatibility exports. Maintenance now requires an explicit manufacturer-backed source. */
export const WEAR_KM_PER_STRESS_UNIT = null;
export const MAINTENANCE_CALIBRATION_REGISTRY = Object.freeze({
  wearKmPerStressUnit: Object.freeze({
    value: null,
    calibrationStatus: 'retired',
    calibrationBasis: 'No defensible conversion from driving events to component life.',
    note: 'Road Sage does not convert GPS events into kilometres of wear or change service intervals.',
  }),
});

export const DEFAULT_MAINTENANCE_ITEMS = Object.freeze([]);
