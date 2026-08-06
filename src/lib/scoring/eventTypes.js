/**
 * Canonical driving-event type identifiers.
 *
 * These live in their own module rather than in tripEngine.js so that the smaller scoring
 * modules (sensor fusion, IMU refinement) can name an event type without importing the
 * 8,000-line engine — which would create an import cycle back through them.
 *
 * tripEngine.js re-exports EVENT_TYPES, so existing `from '@/lib/tripEngine'` imports keep
 * working; new code should import from here.
 */
export const EVENT_TYPES = Object.freeze({
  HARSH_BRAKE: 'harsh_brake',
  RAPID_ACCELERATION: 'rapid_acceleration',
  SHARP_TURN: 'sharp_turn',
  SPEEDING: 'speeding',
  IDLE: 'idle',
  HEADING_DEVIATION: 'heading_deviation',
  HEADING_DEVIATION_LEGACY: 'heading_deviation_legacy',
  STOP_START_PATTERN: 'stop_start_pattern',
  TAILGATE_CYCLE: 'tailgate_cycle',
  ERRATIC_SPEED: 'erratic_speed',
  NEAR_MISS: 'near_miss',
  CLOSE_PROXIMITY: 'close_proximity',
  AGGRESSIVE_OVERTAKE: 'aggressive_overtake',
  PHONE_USE: 'phone_use',
});
