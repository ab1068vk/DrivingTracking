// @ts-check
/**
 * Settings > Saved road speeds.
 *
 * Road Sage learns speed limits on-device so a driver never has to depend on
 * OSM for them. Everything that governed that system used to be either buried
 * on the Saved Road Speeds screen (the cleanup window, as a hardcoded 180) or
 * unreachable entirely: `speed_alert_min_confidence` was read by the alert
 * policy and `speed_alert_sustained_s` by the alert gate, but neither had a
 * declared default, so the shared constant was the only value they could take.
 *
 * This section is where those live. It renders only while its section is the
 * active one, so the store read below is not work the rest of Settings pays.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge, HardDrive, Route, Trash2, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  SettingRow,
  SettingsSubheading,
  Toggle,
} from '@/components/settings/SettingsPrimitives';
import { LocalSpeedKnowledge, SPEED_KNOWLEDGE_CHANGED_EVENT } from '@/lib/localSpeedKnowledge';
import {
  getNativeSpeedKnowledgeMirrorStatus,
  retryNativeSpeedKnowledgeMirror,
  speedKnowledgeStore,
} from '@/lib/speedKnowledgeRepository';
import {
  formatApproximateBytes,
  MAX_SPEED_KNOWLEDGE_RETENTION_DAYS,
  MIN_SPEED_KNOWLEDGE_RETENTION_DAYS,
  pruneSpeedKnowledge,
  speedKnowledgeRetentionDays,
  summarizeSpeedKnowledgeStorage,
} from '@/lib/speed/speedKnowledgeMaintenance';
import { speedLimitLadderForSettings, speedLimitLadderUnits } from '@/lib/speed/speedLimitLadder';
import { SPEED_ALERT_MIN_CONFIDENCE } from '@/lib/appConstants';
import { isAndroid } from '@/lib/nativePlatform';
import { logSystemFailure } from '@/lib/systemLog';
import { convertSpeedKmh, speedUnitLabel } from '@/lib/unitFormatting';

const MIRROR_STATE_LABELS = {
  synced: 'Background copy up to date',
  error: 'Background copy failed',
  unknown: 'Background copy not written yet',
};

/** The ladder rungs, in the driver's units, as a readable list. */
function ladderPreview(settings) {
  const units = speedLimitLadderUnits(settings);
  const rungs = speedLimitLadderForSettings(settings)
    .map((kmh) => Math.round(convertSpeedKmh(kmh, units)));
  return `${rungs.join(', ')} ${speedUnitLabel(units)}`;
}

/**
 * @param {{
 *   cfg: Record<string, any>,
 *   updateCfg: (patch: Record<string, any>) => any,
 *   onManageSavedSpeeds: () => void,
 * }} props
 */
export default function SavedRoadSpeedsSection({ cfg, updateCfg, onManageSavedSpeeds }) {
  const [storage, setStorage] = useState(/** @type {any} */ (null));
  const [storageFailed, setStorageFailed] = useState(false);
  const [mirror, setMirror] = useState(() => getNativeSpeedKnowledgeMirrorStatus());
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');

  const knowledge = useMemo(() => new LocalSpeedKnowledge(speedKnowledgeStore), []);
  const retentionDays = speedKnowledgeRetentionDays(cfg);
  const confidenceFloor = Number.isFinite(Number(cfg.speed_alert_min_confidence))
    ? Number(cfg.speed_alert_min_confidence)
    : SPEED_ALERT_MIN_CONFIDENCE;
  const sustainedSeconds = Number.isFinite(Number(cfg.speed_alert_sustained_s))
    ? Number(cfg.speed_alert_sustained_s)
    : 5;

  const refreshStorage = useCallback(async () => {
    try {
      const data = await knowledge.exportData();
      setStorage(summarizeSpeedKnowledgeStorage(data));
      setStorageFailed(false);
    } catch (error) {
      // A failed read must not render as an empty store: "0 saved rules" would
      // invite a driver to conclude their saved speeds had been lost.
      logSystemFailure('settings_speed_knowledge_storage_read', error);
      setStorage(null);
      setStorageFailed(true);
    }
    setMirror(getNativeSpeedKnowledgeMirrorStatus());
  }, [knowledge]);

  useEffect(() => {
    void refreshStorage();
    const onChanged = () => { void refreshStorage(); };
    window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, onChanged);
  }, [refreshStorage]);

  const runCleanup = async () => {
    setBusy('cleanup');
    setStatus('');
    try {
      const { updatedTrips, retentionDays: usedDays } = await pruneSpeedKnowledge(knowledge, {
        retentionDays,
        rescore: async (before, after) => {
          const { refreshTripsForLocalSpeedKnowledgeChanges } = await import('@/lib/localSpeedScoreRefresh');
          return refreshTripsForLocalSpeedKnowledgeChanges(before, after).catch((error) => {
            logSystemFailure('settings_speed_knowledge_cleanup_rescore', error);
            return null;
          });
        },
      });
      setStatus(updatedTrips
        ? `Removed expired rules and learned evidence older than ${usedDays} days. Recalculated ${updatedTrips.length} affected trip${updatedTrips.length === 1 ? '' : 's'}.`
        : `Removed expired rules and learned evidence older than ${usedDays} days, but affected trips could not be recalculated right now.`);
    } catch (error) {
      logSystemFailure('settings_speed_knowledge_cleanup', error);
      setStatus('Cleanup could not finish. Your saved road speeds were left unchanged.');
    }
    setBusy('');
    await refreshStorage();
  };

  const retryMirror = async () => {
    setBusy('mirror');
    setStatus('');
    try {
      await retryNativeSpeedKnowledgeMirror();
      setStatus('Background copy rewritten. Trips recorded with the app closed can use your saved speeds again.');
    } catch (error) {
      logSystemFailure('settings_speed_knowledge_mirror_retry', error);
      setStatus('The background copy could not be written. Saved speeds still work while the app is open.');
    }
    setBusy('');
    setMirror(getNativeSpeedKnowledgeMirrorStatus());
  };

  const learningEnabled = cfg.road_memory_learning_enabled !== false;

  return (
    <>
      <SettingsSubheading>Learning</SettingsSubheading>
      <SettingRow
        icon={Route}
        label="Learn speeds from my drives"
        sublabel={learningEnabled
          ? 'Road Sage builds its own speed limits from how you actually drive a road, on this device only. Nothing is sent anywhere.'
          : 'Paused. Speeds already saved still resolve, score and alert as normal — this only stops new drives adding evidence.'}
      >
        <Toggle
          value={learningEnabled}
          onChange={(value) => updateCfg({ road_memory_learning_enabled: value })}
        />
      </SettingRow>
      <SettingRow
        icon={Gauge}
        label="Speed ladder"
        sublabel={`Learned speeds snap onto these rungs: ${ladderPreview(cfg)}. This follows your Units setting and nothing else, so switching to Imperial in Appearance moves the learner onto mph rungs.`}
      />
      <SettingRow
        icon={Gauge}
        label="Manage your saved road speeds"
        sublabel="Add, review, correct, or remove individual road-section speeds on the private in-app map. Edits re-score matching stored trips."
        onClick={onManageSavedSpeeds}
      />

      <SettingsSubheading>Alerts from saved speeds</SettingsSubheading>
      <SettingRow
        icon={Volume2}
        label="Speak estimated speed checks"
        sublabel="Applies to learned, regional, and GPS-inferred limits, never to a posted one. This is the same switch as in Speed &amp; Road Data."
      >
        <Toggle
          value={cfg.speak_estimated_speed_checks === true}
          onChange={(value) => updateCfg({ speak_estimated_speed_checks: value })}
        />
      </SettingRow>
      {/* data-setting-label matches SettingRow so Settings search can scroll
          straight to the slider rather than only to the section heading. */}
      <div className="scroll-mt-24 px-1 py-3 border-b border-border/50" data-setting-label="Minimum confidence to speak">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Minimum confidence to speak</div>
          <span className="text-primary font-semibold">{confidenceFloor.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0.3}
          max={0.95}
          step={0.05}
          aria-label="Minimum confidence to speak"
          aria-valuetext={`${confidenceFloor.toFixed(2)} confidence`}
          value={confidenceFloor}
          className="w-full mt-2"
          onChange={(event) => updateCfg({ speed_alert_min_confidence: parseFloat(event.target.value) })}
        />
        <div className="mt-1 text-xs text-muted-foreground">
          A saved speed the app is less sure of than this is never spoken aloud. It is still
          shown, and still scored. Higher means fewer, better-earned alerts. The background
          service applies the same floor.
        </div>
      </div>
      <div className="scroll-mt-24 px-1 py-3 border-b border-border/50" data-setting-label="Sustained over the limit before speaking">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Sustained over the limit before speaking</div>
          <span className="text-primary font-semibold">{Math.round(sustainedSeconds)}s</span>
        </div>
        <input
          type="range"
          min={0}
          max={20}
          step={1}
          aria-label="Sustained over the limit before speaking"
          aria-valuetext={`${Math.round(sustainedSeconds)} seconds`}
          value={sustainedSeconds}
          className="w-full mt-2"
          onChange={(event) => updateCfg({ speed_alert_sustained_s: parseFloat(event.target.value) })}
        />
        <div className="mt-1 text-xs text-muted-foreground">
          How long you must stay over the limit before Road Sage says anything, so a single
          GPS spike cannot make it talk. The on-screen badge is unaffected and stays immediate.
        </div>
      </div>

      <SettingsSubheading>Storage and cleanup</SettingsSubheading>
      <SettingRow
        icon={HardDrive}
        label="What this device has saved"
        sublabel={storageFailed
          ? 'Saved road speeds could not be read just now. This is a display problem — nothing has been deleted.'
          : storage
            ? `${storage.ruleCount} rule${storage.ruleCount === 1 ? '' : 's'} you set, ${storage.learnedRoadCount} road${storage.learnedRoadCount === 1 ? '' : 's'} learned, ${storage.cellCount} area${storage.cellCount === 1 ? '' : 's'} with evidence. About ${formatApproximateBytes(storage.approximateBytes)}, plus ${storage.historicalRuleCount} retained historical version${storage.historicalRuleCount === 1 ? '' : 's'}.`
            : 'Reading…'}
      />
      <SettingRow
        icon={Trash2}
        label="Keep learned evidence for"
        sublabel={`Days of learned evidence to keep. Rules you set yourself are never removed by cleanup, and a historical version of a limit you changed is always preserved. Currently ${retentionDays} days.`}
      >
        <input
          type="number"
          min={MIN_SPEED_KNOWLEDGE_RETENTION_DAYS}
          max={MAX_SPEED_KNOWLEDGE_RETENTION_DAYS}
          step={30}
          value={cfg.speed_knowledge_retention_days ?? retentionDays}
          aria-label="Days of learned speed evidence to keep"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) updateCfg({ speed_knowledge_retention_days: next });
          }}
          className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm"
        />
      </SettingRow>
      <SettingRow
        icon={Trash2}
        label="Clean up expired evidence now"
        sublabel="Drops expired temporary rules and learned evidence past the window above, then re-scores the trips whose scores depended on it."
      >
        <Button type="button" size="sm" variant="outline" disabled={busy !== ''} onClick={() => void runCleanup()}>
          {busy === 'cleanup' ? 'Cleaning…' : 'Clean up'}
        </Button>
      </SettingRow>
      {isAndroid() && (
        <SettingRow
          icon={HardDrive}
          label="Background copy for closed-app trips"
          sublabel={`${MIRROR_STATE_LABELS[mirror.state] || MIRROR_STATE_LABELS.unknown}. The Android service reads its own copy of your saved speeds, so a trip recorded with the app closed still gets them.${mirror.error ? ` Last error: ${mirror.error}` : ''}`}
        >
          <Button type="button" size="sm" variant="outline" disabled={busy !== ''} onClick={() => void retryMirror()}>
            {busy === 'mirror' ? 'Writing…' : 'Rewrite'}
          </Button>
        </SettingRow>
      )}
      {status && (
        <div className="px-1 py-2 text-xs text-muted-foreground" role="status">{status}</div>
      )}
    </>
  );
}
