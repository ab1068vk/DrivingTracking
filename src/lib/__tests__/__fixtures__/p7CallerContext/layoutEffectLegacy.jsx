// `useLayoutEffect` runs before paint on every mount.
import { useLayoutEffect } from 'react';
import { tripService } from '@/api/trips';

const measure = () => { tripService.list(); };

export default function Page() {
  useLayoutEffect(measure, []);
  return <span>Trips</span>;
}
