// Codex reproduction 1: the same function is wired to BOTH an onClick and a
// useEffect. It runs on mount, so the edge is ROUTINE however explicit the
// button looks.
import { useEffect } from 'react';
import { tripService } from '@/api/trips';

const legacy = () => { tripService.list(); };

export default function Page() {
  useEffect(legacy, []);
  return <button onClick={legacy}>Run</button>;
}
