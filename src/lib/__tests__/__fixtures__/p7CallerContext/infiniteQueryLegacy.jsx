// `useInfiniteQuery` executes its page function on mount exactly as `useQuery`
// does, and its explicit-looking "load more" button does not undo that.
import { useInfiniteQuery } from '@tanstack/react-query';
import { tripService } from '@/api/trips';

const readPage = () => tripService.list();

export default function Page() {
  const query = useInfiniteQuery({ queryKey: ['trips'], queryFn: readPage });
  return <button onClick={readPage}>Load more {query.data ? 1 : 0}</button>;
}
