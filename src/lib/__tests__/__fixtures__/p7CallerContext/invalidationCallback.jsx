// A cache-invalidation callback path: the refetch option executes the legacy
// read whenever the query is invalidated.
import { useQuery } from '@tanstack/react-query';
import { tripService } from '@/api/trips';

const reload = () => { tripService.list(); };

export default function Page() {
  const query = useQuery({ queryKey: ['trips'], queryFn: reload, refetchOnWindowFocus: reload });
  return <span>{query.data?.length ?? 0}</span>;
}
