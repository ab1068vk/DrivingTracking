import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('HPR-006 deliberate native stop caller contract', () => {
  it('routes every Settings action that disables native ownership through one stop seam', () => {
    const source = read('../../pages/Settings.jsx');
    const pauseBlock = source.slice(
      source.indexOf('const updateTrackingPaused'),
      source.indexOf('const enableTrackingMode')
    );
    const modeBlock = source.slice(
      source.indexOf('const enableTrackingMode'),
      source.indexOf('const refreshPermissions')
    );
    const trackingUi = source.slice(
      source.indexOf('label="Pause All Tracking"'),
      source.indexOf('label="Battery Optimization"')
    );

    expect(pauseBlock).toContain("stopNativeAutoTrackingSafely('Auto tracking could not be paused')");
    expect(modeBlock).toContain("mode === 'manual'");
    expect(modeBlock).toContain("stopNativeAutoTrackingSafely('Manual mode could not stop background tracking')");
    expect(modeBlock).toContain("mode !== 'background_auto'");
    expect(modeBlock).toContain("stopNativeAutoTrackingSafely('Background tracking could not be turned off')");
    expect(trackingUi).toContain("stopNativeAutoTrackingSafely('Auto tracking could not be turned off')");
    expect(trackingUi).toContain("stopNativeAutoTrackingSafely('Background tracking could not be turned off')");
  });

  it('dispatches ACTION_STOP as a service command and waits for durable bridge truth', () => {
    const service = read('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java');
    const plugin = read('../../../android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java');
    const stopBlock = service.slice(
      service.indexOf('static String stop(Context context)'),
      service.indexOf('static JSONObject deliberateStopStatus')
    );
    const pluginEntry = plugin.slice(
      plugin.indexOf('public void stopNativeAutoTracking'),
      plugin.indexOf('private void awaitDeliberateStop')
    );
    const pluginWait = plugin.slice(
      plugin.indexOf('private void awaitDeliberateStop'),
      plugin.indexOf('@PluginMethod', plugin.indexOf('private void awaitDeliberateStop'))
    );
    const terminalTurn = service.slice(
      service.indexOf('private boolean stopEverything()'),
      service.indexOf('private void removeTrackingNotification()')
    );
    const finishTrip = service.slice(
      service.indexOf('private void finishTrip(String reason, boolean keepArmed)'),
      service.indexOf('private void finishSpooledTrip(String reason, boolean keepArmed)')
    );

    expect(stopBlock).toContain('ContextCompat.startForegroundService(app, intent)');
    expect(stopBlock).not.toContain('stopService(intent)');
    expect(pluginEntry).toContain('awaitDeliberateStop');
    expect(pluginEntry).not.toContain('call.resolve');
    expect(pluginWait).toContain('DELIBERATE_STOP_SUCCEEDED');
    expect(pluginWait).toContain('terminalTruth');
    expect(pluginWait).toContain('durableTerminal');
    expect(pluginWait).toContain('Trip completion is still pending');

    const finishIndex = terminalTurn.indexOf('finishTrip("service_stopped_by_user", false)');
    const disableIndex = terminalTurn.indexOf('setServiceEnabledDurably(this, false)');
    expect(finishIndex).toBeGreaterThan(-1);
    expect(disableIndex).toBeGreaterThan(finishIndex);
    expect(finishTrip).toContain('if (!isTripActive()) return;');
  });

  it('binds pending stops to durable trip intent and separates explicit starts from recovery', () => {
    const service = read('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java');
    const plugin = read('../../../android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java');
    const boot = read('../../../android/app/src/main/java/com/drivesense/app/DriveSenseBootReceiver.java');
    const watchdog = read('../../../android/app/src/main/java/com/drivesense/app/DriveSenseTrackingWatchdog.java');

    expect(service).toContain('KEY_DELIBERATE_STOP_TARGET_TRIP_ID');
    expect(service).toContain('KEY_DELIBERATE_STOP_TARGET_SESSION_ID');
    expect(service).toContain('KEY_DELIBERATE_STOP_INTENT_GENERATION');
    expect(service).toContain('KEY_TRACKING_INTENT_GENERATION');
    expect(service).toContain('DELIBERATE_STOP_SUPERSEDED');
    expect(service).toContain('pendingStopStillOwnsRecovery');
    expect(service).toContain('targetTripId.equals(currentTripId)');
    expect(service).toContain('beginExplicitStartIntent');
    expect(service).toContain('TRACKING_INTENT_RECOVERY');
    expect(plugin).toContain('DELIBERATE_STOP_SUPERSEDED');
    expect(boot).toContain('startForRecovery(context)');
    expect(watchdog).toContain('recoveryStartIntent(context)');
  });
});
