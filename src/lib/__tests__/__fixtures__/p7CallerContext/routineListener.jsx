// Focus/resume path: a lifecycle listener executes the callback by reference.
import { useEffect } from 'react';
import { tripService } from '@/api/trips';

const refresh = () => { tripService.list(); };

export default function Page() {
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  return <button onClick={refresh}>Refresh</button>;
}
