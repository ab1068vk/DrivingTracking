export type EvidenceLevel = 'none' | 'low' | 'medium' | 'high' | 'estimated' | 'unavailable' | string;

export type ScoreAvailability = 'available' | 'estimated' | 'insufficient_data' | 'unavailable' | string;

export interface ComponentScore {
  value: number | null;
  evidence?: EvidenceLevel;
  confidence?: number;
  availability?: ScoreAvailability;
  sampleCount?: number;
  distanceKm?: number;
  dataSource?: string[];
  reason?: string;
  label?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ComponentScores {
  overall?: ComponentScore;
  safety?: ComponentScore;
  smoothness?: ComponentScore;
  eco?: ComponentScore;
  intersection?: ComponentScore;
  fatigue?: ComponentScore;
  phone_use?: ComponentScore;
  [component: string]: ComponentScore | undefined;
}

export interface ScoreProvenanceComponent {
  value?: number | null;
  evidence?: EvidenceLevel;
  confidence?: number;
  dataSource?: string[];
  constants?: Record<string, number | string | boolean | null>;
  [key: string]: unknown;
}

export interface ScoreProvenance {
  scoring_version?: string | null;
  version?: string | null;
  computed_at?: string;
  settings_version?: string | number | null;
  calibration_status?: string | null;
  constants_snapshot?: Record<string, unknown>;
  components?: Record<string, ScoreProvenanceComponent>;
  migrated_without_rescore?: boolean;
  migration_note?: string;
  target_scoring_version?: string;
  [key: string]: unknown;
}

export interface ScoreExplanationFactor {
  factor: string;
  label: string;
  impact: number;
  score?: number | null;
  risk?: string;
  [key: string]: unknown;
}

export interface ScoreExplanation {
  top_factors: ScoreExplanationFactor[];
  overall: ScoreExplanationFactor[];
  safety: ScoreExplanationFactor[];
  smoothness: ScoreExplanationFactor[];
  eco: ScoreExplanationFactor[];
}

export interface TripStats {
  distance_km?: number;
  estimated_private_distance_km?: number;
  duration_seconds?: number;
  moving_time_seconds?: number;
  idle_time_seconds?: number;
  avg_speed_kmh?: number;
  avg_running_speed_kmh?: number;
  max_speed_kmh?: number;
  [key: string]: unknown;
}
