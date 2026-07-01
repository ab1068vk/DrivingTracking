// @ts-check
import { Skeleton } from '@/components/ui/skeleton';

export default function PageSkeleton({
  title = 'Loading page',
  showMap = false,
  cardCount = 3,
}) {
  return (
    <div className="space-y-5" role="status" aria-label={title}>
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
      <span className="sr-only">{title}</span>
    </div>
  );
}
