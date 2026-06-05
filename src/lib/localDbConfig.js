const LEGACY_DEFAULT_DB_NAME = 'drivesense_mobile';
const DEFAULT_DB_NAME = 'road_sage_mobile';

export const DB_NAME_META_KEY = 'road_sage_indexeddb_name';
export const DB_NAME = String(import.meta.env.VITE_DB_NAME || DEFAULT_DB_NAME).trim() || DEFAULT_DB_NAME;
export const DB_VERSION = 2;
export const TRIP_STORE = 'trips';
export const ROUTE_RISK_STORE = 'route_risk_index';
export const ROUTE_RISK_RECORD_ID = 'route_risk_index';
export const LOCAL_DB_LEGACY_DEFAULT_NAME = LEGACY_DEFAULT_DB_NAME;
