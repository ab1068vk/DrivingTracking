import { AlertTriangle } from 'lucide-react';
import { osrmEndpointDomain } from '@/lib/osrmEndpointTrust';

const statusText = (cfg, isPublicOsrmDemoUrl) => {
  if (cfg.osrm_health_status === 'connected' && cfg.osrm_last_reachable_at) {
    return `Connected. OSRM last verified: ${new Date(cfg.osrm_last_reachable_at).toLocaleString()}.`;
  }
  if (cfg.osrm_health_status === 'unreachable') {
    return `Unreachable${cfg.osrm_last_health_error ? `: ${cfg.osrm_last_health_error}` : '.'}`;
  }
  if (cfg.map_matching_enabled === false) {
    return 'Off: Get Road Data will not contact OSRM, and map/playback use the original GPS line.';
  }
  if (!cfg.osrm_map_matching_url) {
    return 'Optional: add a trusted OSRM endpoint only if you want road-snapped map lines.';
  }
  if (isPublicOsrmDemoUrl(cfg.osrm_map_matching_url)) {
    return 'Blocked: the public OSRM demo cannot be used as a route-snapping endpoint.';
  }
  if (cfg.osrm_data_sharing_consented === true) {
    return 'Verification needed: route snapping stays off until this endpoint passes the OSRM OPTIONS check.';
  }
  return 'Consent needed: save this endpoint and confirm OSRM data sharing before route snapping can run.';
};

export function OsrmEndpointPanel({
  cfg,
  endpointDraft,
  healthCheckState,
  isPublicOsrmDemoUrl,
  publicDemoUrl,
  onChangeEndpointDraft,
  onClearEndpoint,
  onSaveEndpoint,
}) {
  const configuredDomain = osrmEndpointDomain(cfg.osrm_map_matching_url);

  return (
    <div className="px-1 py-3">
      <div className="mb-1 text-xs font-medium">Trusted OSRM endpoint</div>
      {configuredDomain && (
        <div className="mb-2 rounded-xl border border-border bg-card px-3 py-2 text-xs">
          <span className="text-muted-foreground">Configured domain: </span>
          <span className="break-all font-semibold text-foreground">{configuredDomain}</span>
        </div>
      )}
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.85fr)] lg:items-stretch">
        <input
          value={endpointDraft}
          onChange={event => onChangeEndpointDraft(event.target.value)}
          placeholder="https://your-osrm.example"
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-xs disabled:opacity-50"
        />
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            This endpoint will receive raw GPS coordinates from your routes. Only use endpoints you control or fully trust.
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSaveEndpoint}
          disabled={healthCheckState === 'checking'}
          className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {healthCheckState === 'checking' ? 'Checking...' : 'Save endpoint'}
        </button>
        <button
          type="button"
          onClick={onClearEndpoint}
          disabled={!cfg.osrm_map_matching_url && !endpointDraft}
          className="rounded-lg bg-secondary px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Turn off + clear
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Blank keeps route snapping off. Example only: {publicDemoUrl}. The public demo is not saved or used by Road Sage because it receives route points and has no service guarantee.</p>
      <div className="mt-2 rounded-xl bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
        {statusText(cfg, isPublicOsrmDemoUrl)}
      </div>
    </div>
  );
}
