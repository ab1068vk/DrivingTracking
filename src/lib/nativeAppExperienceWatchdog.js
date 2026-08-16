import { PERFORMANCE_CHECKPOINT_EVENT } from '@/lib/performanceTriage';
import { isAndroid } from '@/lib/nativePlatform';
import ActivityRecognition from '@/lib/driveSenseNativePlugin';
import { bufferSuppressedDiagnostics, closeP0Span, openP0Span } from '@/lib/p0Probe';
import { suppressWatchdogCheckpoints } from '@/lib/p0ProbeArms';

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
      // P0 arm C suppresses the per-measurement checkpoint bridge call so its
      // cost can be isolated. Every other arm behaves exactly as before.
      if (suppressWatchdogCheckpoints()) {
        bufferSuppressedDiagnostics('watchdog_checkpoint');
        continue;
      }
      const span = openP0Span('watchdog_checkpoint');
      try {
        await ActivityRecognition.recordAppExperienceCheckpoint(checkpoint);
        if (span) closeP0Span(span, 'success');
      } catch {
        // The watchdog is optional and must never interfere with app startup.
        if (span) closeP0Span(span, 'error');
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
