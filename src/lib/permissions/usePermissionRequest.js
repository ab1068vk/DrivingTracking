import { useCallback, useState } from 'react';
import { getPermissionExplanation, openNativeSettings } from '@/lib/permissions';
import { PERMISSION_STATES } from '@/lib/permissionStateMachine';
import { usePermissions } from './PermissionContext';

function resultToPermissionState(result) {
  if (result === true || result?.granted === true) return PERMISSION_STATES.GRANTED;
  if (result?.requiresSettings === true) return PERMISSION_STATES.NEEDS_SETTINGS;
  return PERMISSION_STATES.DENIED;
}

export function usePermissionRequest(permissionKey, requestFn) {
  const permissions = usePermissions();
  const status = permissions[permissionKey] ?? PERMISSION_STATES.UNKNOWN;
  const { refresh, setOne } = permissions;
  const [showRationale, setShowRationale] = useState(false);

  const request = useCallback(async () => {
    if (status === PERMISSION_STATES.NEEDS_SETTINGS) {
      await openNativeSettings();
      return;
    }
    setShowRationale(true);
  }, [status]);

  const proceed = useCallback(async () => {
    setShowRationale(false);
    setOne(permissionKey, PERMISSION_STATES.REQUESTING);
    try {
      const result = await requestFn();
      setOne(permissionKey, resultToPermissionState(result));
      return result;
    } catch (error) {
      setOne(permissionKey, PERMISSION_STATES.UNKNOWN);
      throw error;
    } finally {
      await refresh({ force: true }).catch(() => null);
    }
  }, [permissionKey, refresh, requestFn, setOne]);

  return {
    status,
    request,
    showRationale,
    rationaleText: getPermissionExplanation(permissionKey),
    onProceed: proceed,
    onDismiss: () => setShowRationale(false),
  };
}
