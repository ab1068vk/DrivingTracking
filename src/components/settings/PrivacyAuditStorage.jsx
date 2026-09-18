import { useEffect, useRef, useState } from 'react';
import { getPrivacyAuditReadiness, runPrivacyAuditCompatibilityUpgrade } from '@/lib/hashChainLog';
import { nativeTripArchive } from '@/lib/nativeTripArchive';
import { isAndroid } from '@/lib/nativePlatform';

/** Explicit compatibility UI. It observes bounded status; never starts conversion in an effect. */
export default function PrivacyAuditStorage() {
  const [status, setStatus] = useState('CHECKING');
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const abort = useRef(null);
  useEffect(() => {
    let active = true;
    const refresh = () => getPrivacyAuditReadiness().then((value) => { if (active) setStatus(value.state); });
    void refresh();
    if (isAndroid() && import.meta.env.VITE_P35_NATIVE_AUTHORITY === 'true') {
      nativeTripArchive.p5PrivacyReceipts().then((value) => {
        if (active) setPending(value.state === 'READY' ? value.privacyReceiptPending : null);
      });
    }
    let unsubscribe = () => {};
    void import('@/lib/appLifecycleWork').then(({ getP5PrivacyReceiptStatus, subscribeP5PrivacyReceiptStatus }) => {
      if (!active) return;
      setPending(getP5PrivacyReceiptStatus().privacyReceiptPending);
      unsubscribe = subscribeP5PrivacyReceiptStatus((value) => {
        if (active) { setPending(value.privacyReceiptPending); void refresh(); }
      });
    });
    return () => { active = false; unsubscribe(); abort.current?.abort(); };
  }, []);
  const convert = async () => {
    setBusy(true); setProgress(null); abort.current = new AbortController();
    try {
      const result = await runPrivacyAuditCompatibilityUpgrade({ signal: abort.current.signal, onProgress: setProgress });
      setStatus(result.state);
    } catch (error) { setStatus(error.message); }
    finally { setBusy(false); abort.current = null; }
  };
  return <div className="space-y-2 rounded-lg border border-border p-3" aria-label="Privacy audit storage">
    <p className="text-sm font-semibold">Privacy Audit Storage</p>
    <p className="text-xs text-muted-foreground" role="status">
      {status === 'READY' ? 'Bounded audit storage ready.' : `Audit storage: ${status}.`}
      {pending === true ? ' Privacy receipt delivery is pending; completed native deletion is not undone.' : pending === null ? ' Native receipt debt has not yet been checked.' : ''}
    </p>
    {status !== 'READY' && <>
      <p className="text-xs text-muted-foreground">Upgrade runs only when you start it. It reads and verifies the entire older audit log; time and memory grow with log size. Interrupted upgrades may need to restart.</p>
      <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold"
        onClick={busy ? () => abort.current?.abort() : convert}>
        {busy ? 'Cancel audit upgrade' : 'Upgrade privacy audit storage'}
      </button>
    </>}
    {progress && <p className="text-xs text-muted-foreground">{progress.phase}: {progress.completed}{progress.total == null ? '' : ` / ${progress.total}`}</p>}
  </div>;
}
