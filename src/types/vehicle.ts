export type FuelType = 'gasoline' | 'diesel' | 'hybrid' | 'electric' | 'ev' | string;

export interface MaintenanceItem {
  id: string;
  label?: string;
  interval_km?: number;
  interval_months?: number;
  last_service_km?: number;
  last_service_date?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface VehicleRecord {
  id: string;
  name: string;
  make?: string;
  model?: string;
  year?: number | '';
  color?: string;
  plate?: string;
  odometer_km: number;
  odometer_trip_distance_anchor_km?: number;
  auto_odometer_last_sync_at?: string | null;
  fuel_type: FuelType;
  fuel_efficiency_l_per_100km?: number;
  ev_efficiency_kwh_per_100km?: number;
  fuel_price_per_liter?: number;
  maintenance_reserve_per_km?: number;
  registration_renewal_date?: string;
  insurance_renewal_date?: string;
  maintenance_items?: MaintenanceItem[];
  is_default?: boolean;
  created_date?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}
