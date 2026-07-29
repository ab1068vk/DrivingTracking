// @ts-check
import { useEffect, useRef } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { beginInteractionTask, endInteractionTask } from '@/lib/interactionFeedback';

export default function PageSkeleton({
  title = 'Loading page',
  showMap = false,
  cardCount = 3,
}) {
  const taskRef = useRef(null);

  useEffect(() => {
    taskRef.current = beginInteractionTask(title, { timeoutMs: 30_000 });
    return () => endInteractionTask(taskRef.current);
  }, [title]);

  return (
    <div className="space-y-5" role="status" aria-live="polite" aria-label={title}>
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
        <span>{title}</span>
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72 max-w-[70vw]" />
        </div>
        <Skeleton className="h-10 w-10 rounded-xl" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: cardCount }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-2xl" />
        ))}
      </div>
      {showMap && <Skeleton className="h-[24rem] rounded-2xl" />}
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}
