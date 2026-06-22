import { getScoreColor } from '@/lib/tripEngine';
import { isApproximateScoreOutput } from '@/lib/scoreDisplay';

/**
 * Circular score display with animated ring.
 * Uses SVG for the ring and color-codes based on score.
 */
export default function ScoreRing({ score = null, evidence = null, size = 120, strokeWidth = 8, label = '', sublabel = '', animated: _animated = false, title = '', approximate = true, scoreProvenance = null }) {
  const evidenceLevel = evidence || (score == null ? 'unavailable' : 'low');
  const unavailable = evidenceLevel === 'unavailable' || score == null;
  const provisional = !unavailable && (scoreProvenance ? isApproximateScoreOutput(scoreProvenance) : approximate !== false);
  const radius = (size - strokeWidth * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = unavailable ? 0 : Math.max(0, Math.min(100, Number(score) || 0));
  const offset = circumference - (progress / 100) * circumference;
  const scoredColor = getScoreColor(Number(score) || 0);
  const color = unavailable ? 'text-muted-foreground' : scoredColor.color;
  const scoreLabel = unavailable ? 'Unavailable' : scoredColor.label;
  const strokeColor = unavailable ? 'hsl(var(--muted-foreground) / 0.55)' : scoredColor.stroke;
  const trackClassName = unavailable ? 'text-muted-foreground/25' : 'text-secondary';
  const evidenceText = {
    high: 'high evidence',
    developing: 'limited evidence',
    low: 'low evidence',
    unavailable: 'unavailable evidence',
  }[evidenceLevel] || 'low evidence';

  return (
    <div className="flex flex-col items-center gap-2" title={title || undefined} data-evidence={evidenceLevel}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="rotate-[-90deg]">
          {/* Background track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeDasharray={unavailable ? '2 5' : provisional ? '4 4' : undefined}
            className={trackClassName}
          />
          {/* Progress arc */}
          {!unavailable && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={strokeColor}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={provisional ? '5 4' : circumference}
              strokeDashoffset={offset}
            />
          )}
        </svg>

        {/* Score text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={`font-grotesk font-bold ${color}`}
            style={{ fontSize: size * 0.22 }}
          >
            {unavailable ? '-' : `${provisional ? '~' : ''}${Math.round(Number(score) || 0)}`}
          </span>
          {sublabel && (
            <span className="text-muted-foreground text-xs">{sublabel}</span>
          )}
        </div>
      </div>

      {label && (
        <div className="text-center">
          <div className={`text-sm font-semibold ${color}`}>{scoreLabel}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
          {evidenceLevel !== 'high' && <div className="text-[11px] capitalize text-muted-foreground">{evidenceText}</div>}
        </div>
      )}
      {!label && evidenceLevel !== 'high' && (
        <div className="text-center text-[11px] capitalize text-muted-foreground">{evidenceText}</div>
      )}
    </div>
  );
}
