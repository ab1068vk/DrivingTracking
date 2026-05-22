import { recordTrackingDiagnostic } from '@/lib/trackingDiagnostics';

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
  const sanitized = sanitizeError(error);
  return recordTrackingDiagnostic({
    type: 'operation_error',
    title: `Operation failed: ${context}`,
    detail: sanitized.message,
    context,
    error_name: sanitized.name,
    stack_preview: sanitized.stack,
    ...extra,
  });
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
