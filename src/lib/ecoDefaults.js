import { scoringValue } from '@/lib/scoringConstants';

export const ECO_DEFAULTS = Object.freeze({
  CRUISE_SCORE_MULTIPLIER: scoringValue('ECO_CRUISE_SCORE_MULTIPLIER'),
  IDLE_PENALTY_MULTIPLIER: scoringValue('ECO_IDLE_PENALTY_MULTIPLIER'),
  IDLE_MAX_PENALTY: scoringValue('ECO_IDLE_MAX_PENALTY'),
});
