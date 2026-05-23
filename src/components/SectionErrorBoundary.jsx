import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { logError } from '@/lib/errorReporting';

export function DefaultSectionErrorFallback({
  title = 'Something went wrong',
  message = 'This section could not be displayed. Reload to try again.',
  onReload,
}) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 shadow-sm dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{title}</div>
          <p className="mt-1 text-xs leading-relaxed text-red-700/80 dark:text-red-200/80">{message}</p>
          <button
            type="button"
            onClick={onReload}
            className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

export default class SectionErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    logError(this.props.context || 'react_section_error', error, {
      component_stack: info?.componentStack || '',
      section: this.props.context || 'unknown',
    });
  }

  componentDidUpdate(previousProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  reload = () => {
    if (typeof window !== 'undefined' && window.location?.reload) {
      window.location.reload();
      return;
    }
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    if (typeof this.props.fallback === 'function') {
      return this.props.fallback({ error: this.state.error, reload: this.reload });
    }

    if (this.props.fallback) return this.props.fallback;

    return (
      <DefaultSectionErrorFallback
        title={this.props.title}
        message={this.props.message}
        onReload={this.reload}
      />
    );
  }
}
