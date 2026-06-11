import { recordTrackingDiagnostic } from '@/lib/trackingDiagnostics';
import { logSystemFailure } from '@/lib/systemLog';
import { sanitizeCrashPayload } from '@/lib/crashSanitizer';

const sanitizeError = (error) => {
  const value = error?.reason || error?.error || error;
  const name = value?.name || 'Error';
  const message = String(value?.message || value || 'Unknown error').slice(0, 240);
  const stack = typeof value?.stack === 'string'
    ? value.stack
      .split('\n')
      .slice(0, 3)
      .map((line) => line.replace(/https?:\/\/[^)\s]+/g, '[url]').replace(/[A-Z]:\\[^)\s]+/gi, '[path]'))
      .join('\n')
      .slice(0, 500)
    : '';
  return { name, message, stack };
};

export function logError(context, error, extra = {}) {
  const errorSummary = sanitizeError(error);
  const crashPayload = sanitizeCrashPayload({
    context,
    error: errorSummary,
    extra,
  });
  const safeContext = crashPayload.context || 'app_error';
  const safeError = crashPayload.error || { name: 'Error', message: 'Crash payload was redacted.', stack: '' };
  const safeExtra = crashPayload.extra && typeof crashPayload.extra === 'object'
    ? crashPayload.extra
    : {};

  logSystemFailure(safeContext, safeError, safeExtra);
  return recordTrackingDiagnostic(sanitizeCrashPayload({
    type: 'operation_error',
    title: `Operation failed: ${safeContext}`,
    detail: safeError.message,
    context: safeContext,
    error_name: safeError.name,
    stack_preview: safeError.stack,
    ...safeExtra,
  }));
}

export function initializeErrorReporting() {
  if (typeof window === 'undefined' || window.__roadSageErrorReportingInitialized) return;
  window.__roadSageErrorReportingInitialized = true;

  const report = (type, event) => {
    logError(type, event, { type, title: 'App error captured' });
  };

  window.addEventListener('error', (event) => report('js_error', event));
  window.addEventListener('unhandledrejection', (event) => report('unhandled_rejection', event));
}
