// @ts-check

/** Offline primary-source directory. Entries are never treated as live data. */
export const VEHICLE_REFERENCE_CATALOG_VERSION = '2026.07.14';
export const VEHICLE_REFERENCE_REVIEWED_AT = '2026-07-14';

export const VEHICLE_REFERENCE_SOURCES = Object.freeze([
  {
    id: 'tc_tire_care', authority: 'government', publisher: 'Transport Canada',
    title: 'Riding on Air - tire safety and maintenance', region: 'CA',
    url: 'https://tc.canada.ca/en/road-transportation/stay-safe-when-driving/riding-air',
    reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    note: 'Monthly pressure and condition checks are general safety guidance. Rotation timing must follow the vehicle or tire manufacturer; about 10,000 km is described only as common practice.',
  },
  {
    id: 'tc_vehicle_recalls', authority: 'government', publisher: 'Transport Canada',
    title: 'Vehicle Recalls Database - monthly open dataset', region: 'CA',
    url: 'https://open.canada.ca/data/en/dataset/1ec92326-47ef-4110-b7ca-959fab03f96d',
    reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    note: 'Year/make/model matches are candidates only. Confirm applicability and repair status with the manufacturer using the VIN.',
  },
  {
    id: 'nrcan_fuel_ratings', authority: 'government', publisher: 'Natural Resources Canada',
    title: 'Fuel consumption ratings open dataset', region: 'CA',
    url: 'https://open.canada.ca/data/en/dataset/98f1a129-f628-4ce4-b24d-6f16bf24dd64',
    reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    note: 'Official laboratory ratings are reference values, not a prediction of an individual trip or vehicle condition.',
  },
  {
    id: 'nhtsa_vpic_offline', authority: 'government', publisher: 'U.S. NHTSA',
    title: 'vPIC standalone VIN decoding databases', region: 'US',
    url: 'https://vpic.nhtsa.dot.gov/downloads/', reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    note: 'The standalone database supports VIN decoding, not maintenance schedules, and primarily represents vehicles intended for the U.S. market.',
  },
  {
    id: 'nhtsa_safety_data', authority: 'government', publisher: 'U.S. NHTSA',
    title: 'NHTSA recalls and manufacturer communications downloads', region: 'US',
    url: 'https://www.nhtsa.gov/nhtsa-datasets-and-apis', reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    note: 'Bulk records can identify candidates; a current official VIN lookup is still required for exact open-recall status.',
  },
  {
    id: 'doe_ev_maintenance', authority: 'government', publisher: 'U.S. Department of Energy',
    title: 'Maintenance and Safety of Electric Vehicles', region: 'GLOBAL',
    url: 'https://afdc.energy.gov/vehicles/electric-maintenance', reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    note: 'Battery-electric vehicles have fewer conventional service items; exact requirements remain manufacturer-specific.',
  },
  {
    id: 'toyota_ca_manuals', authority: 'manufacturer', publisher: 'Toyota Canada',
    title: 'Toyota Canada owner manuals and supplements', region: 'CA',
    url: 'https://www.toyota.ca/en/owners/warranty-and-coverage/new-vehicle/',
    reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT, makes: ['toyota', 'scion'],
    note: 'Select the exact Canadian model year and publication. Road Sage does not infer a Toyota interval from make alone.',
  },
  {
    id: 'honda_ca_manuals', authority: 'manufacturer', publisher: 'Honda Canada',
    title: 'Honda Canada owner manuals', region: 'CA',
    url: 'https://integration.honda.ca/owners/manuals', reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    makes: ['honda', 'acura'],
    note: 'Dashboard Maintenance Minder oil-life and service codes take priority over a generic distance estimate.',
  },
  {
    id: 'ford_ca_manuals', authority: 'manufacturer', publisher: 'Ford of Canada',
    title: 'Ford owner manuals and warranty guides', region: 'CA',
    url: 'https://www.ford.ca/support/how-tos/owner-resources/vehicle-documents/where-can-i-get-an-owners-manual/',
    reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT, makes: ['ford', 'lincoln', 'mercury'],
    note: 'Use the VIN or exact year/model manual because engines and operating conditions have different schedules.',
  },
  {
    id: 'nissan_ca_manuals', authority: 'manufacturer', publisher: 'Nissan Canada',
    title: 'Nissan Canada manuals and guides', region: 'CA',
    url: 'https://www.nissan.ca/owners/owner-support.html', reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    makes: ['nissan', 'infiniti'],
    note: 'Use the maintenance information for the exact model year, powertrain, and operating schedule.',
  },
  {
    id: 'tesla_owner_manuals', authority: 'manufacturer', publisher: 'Tesla',
    title: 'Tesla owner manuals', region: 'GLOBAL', url: 'https://www.tesla.com/ownersmanual/',
    reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT, makes: ['tesla'],
    note: 'Tesla updates online manuals. Confirm model, model year, region, vehicle alerts, and Maintenance Summary.',
  },
]);

const sourceById = new Map(VEHICLE_REFERENCE_SOURCES.map((source) => [source.id, source]));
export const getVehicleReferenceSource = (id) => sourceById.get(String(id || '')) || null;

export function getVehicleReferenceSources(vehicle = {}) {
  const make = String(vehicle.make || '').trim().toLowerCase();
  const market = String(vehicle.market || 'CA').trim().toUpperCase();
  return VEHICLE_REFERENCE_SOURCES.filter((source) => {
    if (Array.isArray(source.makes)) return source.makes.includes(make);
    return source.region === 'GLOBAL' || source.region === market;
  });
}

export const VEHICLE_MAINTENANCE_DISCLAIMER =
  'Road Sage maintenance information is an estimated planning aid, not a diagnosis or a replacement for the current schedule for this exact vehicle. Model year, market, trim, engine, equipment, dashboard monitors, service history, software updates, recalls, and operating conditions can change requirements. Follow the current owner/warranty manual, vehicle alerts, recall notices, tire placard, and a qualified technician. If they conflict with Road Sage, they take priority. Never delay service because Road Sage shows an item as not due.';

export const MANUFACTURER_REFERENCE_TEMPLATES = Object.freeze([
  {
    id: 'tesla_model_3_current', make: 'tesla', model: 'model 3', powertrains: ['electric'],
    source_id: 'tesla_owner_manuals', reviewed_at: VEHICLE_REFERENCE_REVIEWED_AT,
    applicability_note: 'Current online Model 3 reference reviewed 2026-07-14. Confirm model year and region before enabling.',
    items: [
      { id: 'tire_rotation', label: 'Tire rotation / tread-difference check', interval_km: 10000, interval_months: 0, condition_note: 'Or at 1.5 mm tread-depth difference, whichever comes first.' },
      { id: 'brake_fluid_health', label: 'Brake fluid health check', interval_km: 0, interval_months: 48, condition_note: 'Replace only if a professional health check indicates it is needed.' },
      { id: 'cabin_air_filter', label: 'Cabin air filter', interval_km: 0, interval_months: 24, condition_note: 'Applicability can vary by model year and equipment.' },
      { id: 'wiper_blades', label: 'Wiper blade inspection/replacement', interval_km: 0, interval_months: 12, condition_note: 'Replace as condition requires.' },
      { id: 'salted_road_brake_service', label: 'Clean and lubricate brake calipers in salted-road regions', interval_km: 20000, interval_months: 12, condition_note: 'Confirm current model-year applicability.' },
    ],
  },
]);
