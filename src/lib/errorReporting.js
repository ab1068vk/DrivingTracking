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

export function initializeErrorReporting() {
  if (typeof window === 'undefined' || window.__roadSageErrorReportingInitialized) return;
  window.__roadSageErrorReportingInitialized = true;

  const report = (type, event) => {
    const error = sanitizeError(event);
    recordTrackingDiagnostic({
      type,
      title: 'App error captured',
      detail: error.message,
      error_name: error.name,
      stack_preview: error.stack,
    });
  };

  window.addEventListener('error', (event) => report('js_error', event));
  window.addEventListener('unhandledrejection', (event) => report('unhandled_rejection', event));
}
