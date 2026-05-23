import { getScoreColor } from '@/lib/tripEngine';
import { motion } from 'framer-motion';

/**
 * Circular score display with animated ring.
 * Uses SVG for the ring and color-codes based on score.
 */
export default function ScoreRing({ score = 0, size = 120, strokeWidth = 8, label = '', sublabel = '', animated = true, title = '' }) {
  const radius = (size - strokeWidth * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(100, score));
  const offset = circumference - (progress / 100) * circumference;
  const { color, label: scoreLabel, stroke: strokeColor } = getScoreColor(score);

  return (
    <div className="flex flex-col items-center gap-2" title={title || undefined}>
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
            className="text-secondary"
          />
          {/* Progress arc */}
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={animated ? { strokeDashoffset: circumference } : { strokeDashoffset: offset }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 1.2, ease: 'easeOut', delay: 0.1 }}
          />
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
            {Math.round(score)}
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
        </div>
      )}
    </div>
  );
}
