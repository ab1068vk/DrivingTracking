import { describe, expect, it } from 'vitest';
import {
  PERMISSION_STATES,
  isValidTransition,
  normalizePermissionState,
  transitionPermissionState,
} from '@/lib/permissionStateMachine';

describe('permissionStateMachine', () => {
  it('normalizes legacy booleans without promoting false to granted', () => {
    expect(normalizePermissionState(true)).toBe(PERMISSION_STATES.GRANTED);
    expect(normalizePermissionState(false)).toBe(PERMISSION_STATES.UNKNOWN);
    expect(normalizePermissionState(null)).toBe(PERMISSION_STATES.UNKNOWN);
  });

  it('accepts needs_settings as a first-class permission state', () => {
    expect(normalizePermissionState('needs_settings')).toBe(PERMISSION_STATES.NEEDS_SETTINGS);
    expect(isValidTransition('denied', 'needs_settings')).toBe(true);
  });

  it('keeps invalid transitions from changing state', () => {
    expect(isValidTransition('needs_settings', 'requesting')).toBe(false);
    expect(transitionPermissionState('needs_settings', 'requesting')).toBe(PERMISSION_STATES.NEEDS_SETTINGS);
  });
});
