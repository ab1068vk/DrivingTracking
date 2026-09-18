// Codex reproduction 2: the same function is both an onClick handler and a
// queryFn. React Query calls it on mount.
import { useQuery } from '@tanstack/react-query';
import { tripService } from '@/api/trips';

const legacy = () => tripService.list();

export default function Page() {
  useQuery({ queryKey: ['x'], queryFn: legacy });
  return <button onClick={legacy}>Run</button>;
}
