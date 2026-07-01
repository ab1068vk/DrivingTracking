// @ts-check
export default function CalibrationStatusTag({ className = '' }) {
  return (
    <span className={`inline-flex rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-300 ${className}`}>
      approximate
    </span>
  );
}
