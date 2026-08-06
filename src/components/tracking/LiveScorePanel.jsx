import { AlertTriangle, Gauge } from 'lucide-react';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import { LIVE_SCORE_LIMITATION } from '@/lib/liveTripScore';
import { formatEstimatedScore } from '@/lib/scoreDisplay';
import { getScoreColor } from '@/lib/tripEngine';
import { formatPerDistanceRate } from '@/lib/unitFormatting';

const CONFIDENCE_LABELS = {
  early: 'Early evidence',
  developing: 'Developing evidence',
  strong: 'Strong evidence',
};

function ScoreBody({ score, units }) {
  const ready = score?.status === 'ok' && score.provisionalScore != null;
  const band = ready ? getScoreColor(score.provisionalScore) : null;
  const comparison = score?.windowComparison;

  return (
    <section className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4" aria-labelledby="live-score-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            <Gauge className="h-3.5 w-3.5" />Provisional drive score
          </div>
          <h2 id="live-score-title" className="mt-2 flex items-end gap-3">
            <span className="font-grotesk text-5xl font-bold leading-none tracking-tight text-slate-50">
              {ready ? formatEstimatedScore(score.provisionalScore) : '—'}
            </span>
            {ready && (
              <span className="mb-1 text-sm font-semibold text-slate-300">{band.label}</span>
            )}
          </h2>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300">
          {ready ? CONFIDENCE_LABELS[score.confidence] || 'Estimated' : 'Waiting for evidence'}
        </span>
      </div>

      {ready ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Safety</div>
            <div className="mt-1 font-grotesk text-xl font-bold text-slate-100">{formatEstimatedScore(score.safetyScore)}</div>
          </div>
          <div className="rounded-lg border border-white/10 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Smoothness</div>
            <div className="mt-1 font-grotesk text-xl font-bold text-slate-100">{formatEstimatedScore(score.smoothnessScore)}</div>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-400">
          A provisional score needs a few minutes of recorded movement. It appears once enough GPS evidence exists.
        </p>
      )}

      {ready && score.topDrivers.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">What is moving it</div>
          <ul className="mt-2 divide-y divide-white/10 border-y border-white/10">
            {score.topDrivers.map((driver) => (
              <li key={driver.key} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-slate-300">{driver.label}</span>
                <span className="font-semibold text-slate-100">
                  {driver.count} · {formatPerDistanceRate(driver.per100km, units)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {comparison?.available && (
        <div className={`mt-4 rounded-lg border px-3 py-2 text-xs ${
          comparison.declined
            ? 'border-amber-300/30 bg-amber-300/10 text-amber-100'
            : 'border-white/10 bg-white/5 text-slate-300'
        }`}>
          <div className="flex items-center gap-2 font-semibold">
            {comparison.declined && <AlertTriangle className="h-3.5 w-3.5" />}
            {comparison.declined ? 'Later driving is scoring lower' : 'First and latest ten minutes compared'}
          </div>
          <div className="mt-1">
            First 10 min {formatEstimatedScore(comparison.firstScore)} · latest 10 min {formatEstimatedScore(comparison.lastScore)}
            {comparison.delta != null ? ` (${comparison.delta > 0 ? '+' : ''}${comparison.delta})` : ''}
          </div>
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-500">{LIVE_SCORE_LIMITATION}</p>
    </section>
  );
}

export default function LiveScorePanel({ score, units = 'metric' }) {
  if (!score || score.status === 'no_active_trip') return null;
  return (
    <SectionErrorBoundary
      context="tracking_live_score"
      title="Live score unavailable"
      message="Something went wrong while estimating the in-drive score. Recording and the rest of the cockpit are unaffected."
      resetKey={score.tripId}
    >
      <ScoreBody score={score} units={units} />
    </SectionErrorBoundary>
  );
}
