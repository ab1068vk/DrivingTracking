import type { DrivingEvent, EventFeedbackMap, PhoneUseEvent } from './events';
import type { ComponentScores, ScoreExplanation, ScoreProvenance, TripStats } from './metrics';

export interface RoutePoint {
  lat: number | null;
  lng: number | null;
  timestamp?: string | number;
  accuracy?: number | null;
  speed?: number | null;
  speed_kmh?: number | null;
  vehicle_speed_kmh?: number | null;
  heading?: number | null;
  bearing?: number | null;
  altitude?: number | null;
  road_type?: string | null;
  speed_limit_kmh?: number | null;
  inferred_speed_limit_kmh?: number | null;
  privacy_boundary?: boolean;
  privacy_zone_key?: string;
  [key: string]: unknown;
}

export type TripStatus = 'active' | 'completed' | 'cancelled' | 'discarded' | string;

export interface ScoreProvenanceChange {
  previous_scoring_version?: string | null;
  current_scoring_version?: string | null;
  reason?: string;
  changed_constants?: string[];
  rescored_at?: string;
  tagged_at?: string;
  [key: string]: unknown;
}

export interface TripRecord extends TripStats {
  id: string;
  status: TripStatus;
  vehicle_id?: string | number | null;
  nickname?: string;
  start_time?: string;
  end_time?: string;
  created_at?: string;
  updated_at?: string;
  schema_version?: number;
  route_points: RoutePoint[];
  route_points_raw_count?: number;
  route_points_map_count?: number;
  driving_events: DrivingEvent[];
  phone_use_events?: PhoneUseEvent[];
  phone_proxy_events?: DrivingEvent[];
  native_phone_usage_events?: DrivingEvent[];
  event_feedback?: EventFeedbackMap;
  component_scores?: ComponentScores;
  score_provenance?: ScoreProvenance;
  score_provenance_change?: ScoreProvenanceChange;
  score_explanation?: ScoreExplanation;
  score_version?: string | null;
  scored_with_settings_version?: string | number | null;
  score_overall?: number | null;
  score_safety?: number | null;
  score_smoothness?: number | null;
  score_eco?: number | null;
  score_intersection?: number | null;
  score_confidence_label?: string | null;
  needs_rescore?: boolean;
  imported_from_native?: boolean;
  feedback_adjusted_events_count?: number;
  co2_saved_kg?: number | null;
  motion_samples?: unknown[];
  sensor_fusion_summary?: Record<string, unknown>;
  [key: string]: unknown;
}
