export function PageSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-4 p-4">
      <div className="h-6 w-32 rounded bg-secondary" />
      <div className="h-4 w-full rounded bg-secondary/60" />
      <div className="h-4 w-3/4 rounded bg-secondary/60" />
      <div className="h-32 w-full rounded-lg bg-secondary/40" />
    </div>
  );
}
