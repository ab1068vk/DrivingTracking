// The control that must stay EXPLICIT: reached only from a named user action.
import { tripService } from '@/api/trips';

const exportEverything = () => { tripService.listAllForExport(); };

export default function Page() {
  return <button onClick={exportEverything}>Export</button>;
}
