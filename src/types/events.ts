export type EventSeverity = 'low' | 'medium' | 'high' | 'critical' | string;

export type EventSource =
  | 'gps'
  | 'gps_proxy'
  | 'android_usage_access'
  | 'obd_bluetooth'
  | 'manual'
  | string;

export interface DrivingEvent {
  id?: string;
  type: string;
  severity?: EventSeverity;
  timestamp?: string | number;
  start_time?: string;
  end_time?: string;
  durationS?: number;
  duration_seconds?: number;
  value?: number;
  score_impact?: number;
  lat?: number | null;
  lng?: number | null;
  point_index?: number;
  start_index?: number;
  end_index?: number;
  speed_kmh?: number;
  confidence?: number;
  source?: EventSource;
  diagnostic_only?: boolean;
  masked_for_privacy?: boolean;
  privacy_boundary?: boolean;
  signals_triggered?: string[];
  legacy_renamed?: boolean;
  [key: string]: unknown;
}

export interface PhoneUseEvent extends DrivingEvent {
  type: 'phone_use' | string;
  source?: 'gps_proxy' | 'android_usage_access' | string;
  package_name?: string;
}

export interface EventFeedback {
  verdict?: 'correct' | 'wrong' | 'unsure' | string;
  note?: string;
  updated_at?: string;
}

export type EventFeedbackMap = Record<string, EventFeedback>;
