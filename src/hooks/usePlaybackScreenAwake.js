import { useEffect } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';

const ScreenAwake = registerPlugin('ScreenAwake');
const activePlaybacks = new Set();

let browserWakeLock = null;
let nativeKeepScreenOn = false;
let updateQueue = Promise.resolve();

async function applyCurrentPlaybackState() {
  const shouldStayAwake = activePlaybacks.size > 0;

  if (Capacitor.isNativePlatform()) {
    if (nativeKeepScreenOn === shouldStayAwake) return;
    await ScreenAwake.setKeepScreenOn({ keepScreenOn: shouldStayAwake });
    nativeKeepScreenOn = shouldStayAwake;
    return;
  }

  if (!shouldStayAwake || document.visibilityState !== 'visible') {
    if (browserWakeLock) {
      const lock = browserWakeLock;
      browserWakeLock = null;
      await lock.release();
    }
    return;
  }

  if (!browserWakeLock && navigator.wakeLock?.request) {
    const lock = await navigator.wakeLock.request('screen');
    browserWakeLock = lock;
    lock.addEventListener('release', () => {
      if (browserWakeLock === lock) browserWakeLock = null;
    }, { once: true });
  }
}

function updateScreenAwakeState() {
  updateQueue = updateQueue
    .then(applyCurrentPlaybackState)
    .catch(() => {
      // Screen-awake support is best-effort and must never interrupt playback.
    });
}

/** Keep the display awake only while a visible replay is actively playing. */
export default function usePlaybackScreenAwake(playing) {
  useEffect(() => {
    if (!playing) return undefined;

    const playback = Symbol('playback');
    activePlaybacks.add(playback);
    updateScreenAwakeState();

    const handleVisibilityChange = () => updateScreenAwakeState();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      activePlaybacks.delete(playback);
      updateScreenAwakeState();
    };
  }, [playing]);
}
