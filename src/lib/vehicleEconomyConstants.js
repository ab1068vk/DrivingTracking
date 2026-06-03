export const DEFAULT_FUEL_PRICE_PER_LITER = 1.65;
export const DEFAULT_L_PER_100KM = 8.5;
export const DEFAULT_EV_KWH_PER_100KM = 18;
export const DEFAULT_GRID_CO2_KG_PER_KWH = 0.04;
export const DEFAULT_CO2_BASELINE_KG_PER_100KM = 12.0;
// USDA/Arbor Day cite >48 lb CO2/year for a mature tree; 21 kg/year keeps this as a conservative planning value.
export const DEFAULT_TREE_CO2_KG_PER_YEAR = 21.0;
export const GASOLINE_CO2_KG_PER_LITER = 2.31;
export const CO2_KG_PER_LITER = Object.freeze({
  gasoline: 2.31,
  petrol: 2.31,
  diesel: 2.68,
  lpg: 1.65,
  cng: 2.0,
  hybrid: 2.10,
  electric: 0,
  ev: 0,
});

export const DEFAULT_MAINTENANCE_ITEMS = Object.freeze([
  Object.freeze({ id: 'oil', label: 'Oil change', interval_km: 8000, last_service_km: 0 }),
  Object.freeze({ id: 'tires', label: 'Tire rotation', interval_km: 10000, last_service_km: 0 }),
  Object.freeze({ id: 'brakes', label: 'Brake check', interval_km: 20000, last_service_km: 0 }),
  Object.freeze({ id: 'inspection', label: 'Inspection', interval_km: 20000, last_service_km: 0 }),
]);
