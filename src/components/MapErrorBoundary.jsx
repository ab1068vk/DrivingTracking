import { Component, Fragment } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { logError } from '@/lib/errorReporting';

export function MapUnavailableCard({
  title = 'Map unavailable',
  message = 'The map could not be drawn. The rest of this page is still available.',
  onRetry,
  height = '300px',
}) {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
      style={{ minHeight: height }}
      role="alert"
    >
      <div className="max-w-sm text-center">
        <AlertTriangle className="mx-auto h-6 w-6" />
        <div className="mt-2 font-semibold">{title}</div>
        <p className="mt-1 text-sm opacity-85">{message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-xl border border-current/25 bg-background/70 px-3 py-2 text-xs font-semibold hover:bg-background"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry map
        </button>
      </div>
    </div>
  );
}

export default class MapErrorBoundary extends Component {
  state = { error: null, retryNonce: 0 };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    logError(this.props.context || 'leaflet_map_error', error, {
      component_stack: info?.componentStack || '',
      section: this.props.context || 'map',
      reset_key: this.props.resetKey || null,
    });
  }

  retry = () => {
    this.setState((state) => ({
      error: null,
      retryNonce: state.retryNonce + 1,
    }));
    this.props.onRetry?.();
  };

  render() {
    if (this.state.error) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback({ error: this.state.error, retry: this.retry });
      }

      if (this.props.fallback) return this.props.fallback;

      return (
        <MapUnavailableCard
          title={this.props.title}
          message={this.props.message}
          height={this.props.height}
          onRetry={this.retry}
        />
      );
    }

    return <Fragment key={this.state.retryNonce}>{this.props.children}</Fragment>;
  }
}
