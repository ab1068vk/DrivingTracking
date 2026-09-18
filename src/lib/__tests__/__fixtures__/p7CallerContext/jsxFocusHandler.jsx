// P7-IMPL-F04 reproduction 3: a JSX focus handler is lifecycle, not a user
// action. It fires from autofocus, from restoring a tab and from a remount, so
// the work behind it runs without anyone asking for it.
import { tripService } from '@/api/trips';

const refreshOnFocus = () => { tripService.list(); };

export default function Page() {
  return <input onFocus={refreshOnFocus} placeholder="Search drives" />;
}
