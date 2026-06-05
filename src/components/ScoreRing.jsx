import { useState } from 'react';
import { getScoreColor } from '@/lib/gps/formatting';
import { motion } from 'framer-motion';
import { isApproximateScoreOutput, scoreEstimateProgressText } from '@/lib/scoreDisplay';

/**
 * Circular score display with animated ring.
 * Uses SVG for the ring and color-codes based on score.
 */
export default function ScoreRing({ score = null, evidence = null, size = 120, strokeWidth = 8, label = '', sublabel = '', animated = true, title = '', approximate = true, scoreProvenance = null, tripCount = null }) {
  const [animationComplete, setAnimationComplete] = useState(!animated);
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
  const estimateProgressText = !unavailable && provisional
    ? scoreEstimateProgressText(tripCount)
    : null;

  return (
    <div className="flex flex-col items-center gap-2" title={title || undefined} data-evidence={evidenceLevel}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className={`${animated ? 'score-ring-animated' : ''} ${animationComplete || unavailable ? 'complete' : ''} rotate-[-90deg]`}>
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
            <motion.circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={strokeColor}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={provisional ? '5 4' : circumference}
              initial={animated ? { strokeDashoffset: circumference } : { strokeDashoffset: offset }}
              animate={{ strokeDashoffset: offset }}
              transition={{ duration: 1.2, ease: 'easeOut', delay: 0.1 }}
              onAnimationComplete={() => setAnimationComplete(true)}
            />
          )}
        </svg>

        {/* Score text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <motion.span
            className={`font-grotesk font-bold ${color}`}
            style={{ fontSize: size * 0.22 }}
            initial={animated ? { opacity: 0 } : { opacity: 1 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            {unavailable ? '-' : `${provisional ? '~' : ''}${Math.round(Number(score) || 0)}`}
          </motion.span>
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
      {estimateProgressText && (
        <div className="mt-1 max-w-[120px] text-center text-xs text-muted-foreground">
          {estimateProgressText}
        </div>
      )}
    </div>
  );
}
