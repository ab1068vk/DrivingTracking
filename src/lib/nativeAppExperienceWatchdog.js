import { PERFORMANCE_CHECKPOINT_EVENT } from '@/lib/performanceTriage';
import { isAndroid } from '@/lib/nativePlatform';
import ActivityRecognition from '@/lib/driveSenseNativePlugin';

let initialized = false;
let flushing = false;
let pendingCheckpoint = null;

const flushCheckpoint = async () => {
  if (flushing || !isAndroid()) return;
  flushing = true;
  try {
    while (pendingCheckpoint) {
      const checkpoint = pendingCheckpoint;
      pendingCheckpoint = null;
      try {
        await ActivityRecognition.recordAppExperienceCheckpoint(checkpoint);
      } catch {
        // The watchdog is optional and must never interfere with app startup.
      }
    }
  } finally {
    flushing = false;
  }
};

const handleCheckpoint = (event) => {
  const detail = event?.detail;
  if (!detail || typeof detail !== 'object') return;
  pendingCheckpoint = {
    operation: String(detail.operation || 'unknown').slice(0, 140),
    phase: String(detail.phase || 'unknown').slice(0, 20),
    pathname: String(detail.pathname || '').slice(0, 160),
  };
  void flushCheckpoint();
};

export function initializeNativeAppExperienceWatchdog() {
  if (initialized || !isAndroid() || typeof window === 'undefined') return false;
  initialized = true;
  window.addEventListener(PERFORMANCE_CHECKPOINT_EVENT, handleCheckpoint);
  handleCheckpoint({
    detail: {
      operation: 'app.javascriptRuntime',
      phase: 'start',
      pathname: window.location?.pathname || '/',
    },
  });
  return true;
}
