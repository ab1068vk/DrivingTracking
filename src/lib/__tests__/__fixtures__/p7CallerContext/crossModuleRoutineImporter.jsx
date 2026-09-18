// Cross-module mixed root: the exported helper is explicit here...
import { useEffect } from 'react';
import { sharedLegacyRead } from './crossModuleLegacy';

export default function Page() {
  useEffect(sharedLegacyRead, []);
  return <button onClick={() => sharedLegacyRead()}>Run</button>;
}
