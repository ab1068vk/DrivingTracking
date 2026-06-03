import { EventStatusBadge } from './EventStatusBadge';

export const DIAGNOSTIC_EVENT_TYPES = new Set([
  'close_proximity',
  'erratic_speed',
  'gps_phone_use_proxy',
  'heading_deviation',
  'heading_deviation_legacy',
  'phone_use_gps_proxy',
  'stop_start_pattern',
  'tailgate_cycle',
]);

export const BETA_EVENT_TYPES = new Set([
  'pre_trip_readiness',
]);

export function classifyTripEvent(event = {}) {
  if (event.type === 'phone_use' && (event.source === 'gps_proxy' || event.diagnostic_only === true)) {
    return 'diagnostic';
  }
  if (BETA_EVENT_TYPES.has(event.type)) return 'beta';
  if (DIAGNOSTIC_EVENT_TYPES.has(event.type)) return 'diagnostic';
  return 'scored';
}

export function TripEventList({ scoredRows = [], reviewedRows = [], diagnosticRows = [], renderEventRow }) {
  return (
    <div className="event-list">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Scored Events</h3>
          <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
            {scoredRows.length}
          </span>
        </div>
        {scoredRows.length === 0 ? (
          <div className="rounded-xl bg-secondary/50 p-3 text-sm text-muted-foreground">
            No scored driving events were recorded on this trip.
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto thin-scrollbar">
            {scoredRows.map((row) => renderEventRow(row, {
              badge: <EventStatusBadge status="scored" />,
              status: 'scored',
            }))}
          </div>
        )}
      </section>

      {reviewedRows.length > 0 && (
        <section className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Reviewed Events</h3>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
              {reviewedRows.length}
            </span>
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto thin-scrollbar">
            {reviewedRows.map((row) => renderEventRow(row, {
              diagnostic: true,
              status: 'removed',
              badge: <EventStatusBadge status="removed" />,
            }))}
          </div>
        </section>
      )}

      {diagnosticRows.length > 0 && (
        <details className="diagnostic-section mt-4 rounded-2xl border border-border bg-secondary/30 p-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold">
            <span>
              Diagnostic Data
              <span className="ml-1 text-xs font-normal text-muted-foreground">- not scored</span>
            </span>
            <span className="rounded-full bg-card px-2 py-0.5 text-xs text-muted-foreground">
              {diagnosticRows.length}
            </span>
          </summary>
          <div className="mt-3 space-y-2 max-h-64 overflow-y-auto thin-scrollbar">
            {diagnosticRows.map((row) => {
              const status = classifyTripEvent(row.event);
              return renderEventRow(row, {
                diagnostic: true,
                status,
                badge: <EventStatusBadge status={status} />,
              });
            })}
          </div>
        </details>
      )}
    </div>
  );
}
