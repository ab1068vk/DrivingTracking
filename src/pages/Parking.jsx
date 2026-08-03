// @ts-check
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  Building2,
  Camera,
  Car,
  Check,
  ChevronLeft,
  ChevronRight,
  History,
  LocateFixed,
  LoaderCircle,
  MapPin,
  Navigation,
  Pencil,
  Shield,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import TripMap from '@/components/TripMap';
import {
  clearCurrentParkingState,
  getLastParkingState,
  inspectParkingSyncStatus,
  localSettings,
  parkingStateRevision,
  PARKED_LOCATION_PRIVACY_GUARD_M,
  reconcileNativeParkingState,
  saveLastParkedLocation,
  suppressLastParkedLocation,
} from '@/lib/trackingStore';
import { vehicleService } from '@/api/vehicles';
import { getPermissionStatus } from '@/lib/permissions';
import {
  activateParkingReminderForVehicle,
  cancelParkingReminder,
  cancelStaleParkingReminder,
  getParkingReminderState,
  getParkingReminderStates,
  PARKING_REMINDER_CHANGED_EVENT,
  scheduleParkingReminder,
} from '@/lib/notificationService';
import { getCurrentLocation } from '@/lib/trackingService';
import {
  getHydratedPrivacyZones,
  isPointInPrivacyZone,
} from '@/lib/privacyZones';
import {
  clearParkingHistory,
  deleteParkingHistoryRecord,
  getParkingHistory,
  getParkingHistoryPageWindow,
  getVehicleParkingStates,
  MAX_PARKING_HISTORY_RECORDS,
  MAX_PARKING_NOTE_LENGTH,
  MAX_PARKING_PHOTO_DATA_URL_LENGTH,
  PARKING_HISTORY_PAGE_SIZE,
  PARKING_HISTORY_CHANGED_EVENT,
  rejectParkingHistoryRecord,
  replaceParkingHistory,
  updateParkingHistoryRecord,
} from '@/lib/parkingHistory';
import {
  getParkingLearningProfile,
  parkingPointDistanceM,
  recordParkingLearningFeedback,
} from '@/lib/parkingLearning';
import { requestAppConfirm } from '@/lib/appDialog';
import DriveSenseNative from '@/lib/driveSenseNativePlugin';
import { isNativePlatform } from '@/lib/nativePlatform';
import { clearParkingDiagnostics, getParkingDiagnostics } from '@/lib/parkingDiagnostics';
import { toast } from '@/components/ui/use-toast';

const relativeTime = (value) => {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return 'recently';
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const evidenceLabel = (value) => String(value || '')
  .replaceAll('_', ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const parkingReminderRemaining = (reminderAt, now = Date.now()) => {
  const remainingSeconds = Math.max(0, Math.ceil((Number(reminderAt) - now) / 1000));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const PARKING_PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PARKING_PHOTO_SOURCE_BYTES = 20_000_000;
const MAX_PARKING_PHOTO_EDGE_PX = 1_280;
const DEFAULT_PARKING_PHOTO_RETENTION_HOURS = 168;
const PARKING_PHOTO_RETENTION_OPTIONS = [
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
  { hours: 0, label: 'When I park somewhere else' },
];

const preferredScrollBehavior = () => (
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'
);

const readParkingPhoto = (file) => new Promise((resolve, reject) => {
  if (!file || !PARKING_PHOTO_MIME_TYPES.has(String(file.type || '').toLowerCase())) {
    reject(new Error('Choose a JPEG, PNG, or WebP image.'));
    return;
  }
  if (Number(file.size) > MAX_PARKING_PHOTO_SOURCE_BYTES) {
    reject(new Error('Choose an image smaller than 20 MB.'));
    return;
  }

  const sourceUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onerror = () => {
    URL.revokeObjectURL(sourceUrl);
    reject(new Error('The parking photo could not be read.'));
  };
  image.onload = () => {
    URL.revokeObjectURL(sourceUrl);
    const sourceWidth = Number(image.naturalWidth);
    const sourceHeight = Number(image.naturalHeight);
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
      reject(new Error('The parking photo could not be read.'));
      return;
    }

    const scale = Math.min(1, MAX_PARKING_PHOTO_EDGE_PX / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      reject(new Error('The parking photo could not be prepared.'));
      return;
    }

    // Re-encoding removes EXIF metadata (including embedded GPS) before local storage.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const value = [0.82, 0.72, 0.62]
      .map((quality) => canvas.toDataURL('image/jpeg', quality))
      .find((candidate) => candidate.length <= MAX_PARKING_PHOTO_DATA_URL_LENGTH);
    if (!value) {
      reject(new Error('The prepared parking photo is still too large.'));
      return;
    }
    resolve(value);
  };
  image.src = sourceUrl;
});

export default function Parking() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [parkingState, setParkingState] = useState(null);
  const [parkingHistory, setParkingHistory] = useState([]);
  const [vehicleParkingStates, setVehicleParkingStates] = useState({});
  const [learningProfile, setLearningProfile] = useState(null);
  const [displayLocation, setDisplayLocation] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [note, setNote] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState(null);
  const [photoFileId, setPhotoFileId] = useState(null);
  const [originalPhotoFileId, setOriginalPhotoFileId] = useState(null);
  const [photoViewerUrl, setPhotoViewerUrl] = useState(null);
  const [photoExpiresAt, setPhotoExpiresAt] = useState(null);
  const [photoRetentionHours, setPhotoRetentionHours] = useState(
    DEFAULT_PARKING_PHOTO_RETENTION_HOURS,
  );
  const [photoExpiryDirty, setPhotoExpiryDirty] = useState(false);
  const [privateSavePending, setPrivateSavePending] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [indoorEstimated, setIndoorEstimated] = useState(false);
  const [garageHint, setGarageHint] = useState('');
  const [permissionStatus, setPermissionStatus] = useState(null);
  const [reminderMinutes, setReminderMinutes] = useState(60);
  const [customReminderAt, setCustomReminderAt] = useState('');
  const [parkingReminder, setParkingReminderState] = useState(null);
  const [vehicleReminders, setVehicleReminders] = useState({});
  const [reminderClock, setReminderClock] = useState(Date.now());
  const [vehicles, setVehicles] = useState([]);
  const [actionStatus, setActionStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingParking, setSavingParking] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [viewingHistoryId, setViewingHistoryId] = useState(null);
  const [historyPage, setHistoryPage] = useState(0);
  const [undoSnapshot, setUndoSnapshot] = useState(null);
  const [parkingDiagnostics, setParkingDiagnostics] = useState([]);
  const [vehicleHistoryFilter, setVehicleHistoryFilter] = useState('all');
  const [saveReceipt, setSaveReceipt] = useState(null);
  const [parkingSyncNotice, setParkingSyncNotice] = useState(null);
  const [parkingSyncIssue, setParkingSyncIssue] = useState(null);
  const cameraInputRef = useRef(null);
  const saveReceiptRef = useRef(null);
  const savedDetailsRef = useRef(null);
  const photoViewerCloseRef = useRef(null);
  const photoViewerTriggerRef = useRef(null);
  const draftPhotoFileIdRef = useRef(null);
  const originalPhotoFileIdRef = useRef(null);

  useEffect(() => {
    draftPhotoFileIdRef.current = photoFileId;
    originalPhotoFileIdRef.current = originalPhotoFileId;
  }, [originalPhotoFileId, photoFileId]);

  useEffect(() => () => {
    const pendingId = draftPhotoFileIdRef.current;
    if (
      isNativePlatform() &&
      pendingId &&
      pendingId !== originalPhotoFileIdRef.current
    ) {
      DriveSenseNative.deleteParkingPhoto({ photoId: pendingId }).catch(() => {});
    }
  }, []);

  const closePhotoViewer = useCallback(() => {
    setPhotoViewerUrl(null);
    window.requestAnimationFrame(() => photoViewerTriggerRef.current?.focus?.());
  }, []);

  useEffect(() => {
    if (!photoViewerUrl) return undefined;
    window.requestAnimationFrame(() => photoViewerCloseRef.current?.focus());
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePhotoViewer();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        photoViewerCloseRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closePhotoViewer, photoViewerUrl]);

  const viewedHistoryRecord = viewingHistoryId
    ? parkingHistory.find((record) => record.id === viewingHistoryId) || null
    : null;
  const viewedHistoryLocation = viewedHistoryRecord?.status === 'saved'
    ? {
      ...viewedHistoryRecord.location,
      timestamp: viewedHistoryRecord.timestamp,
      source: viewedHistoryRecord.source || viewedHistoryRecord.location?.source,
      verified: viewedHistoryRecord.verified === true,
      state_revision: viewedHistoryRecord.state_revision || viewedHistoryRecord.location?.state_revision,
      note: viewedHistoryRecord.note,
      photo_data_url: viewedHistoryRecord.photo_data_url,
      photo_file_id: viewedHistoryRecord.photo_file_id,
      photo_expires_at: viewedHistoryRecord.photo_expires_at,
      photo_retention_hours: viewedHistoryRecord.photo_retention_hours,
    }
    : null;
  const currentParkingLocation = parkingState?.status === 'saved'
    ? parkingState.location || null
    : null;
  const detailsLocation = viewedHistoryLocation || currentParkingLocation;
  const detailsAreCurrent = !viewedHistoryLocation && Boolean(currentParkingLocation);

  const filteredParkingHistory = vehicleHistoryFilter === 'all'
    ? parkingHistory
    : parkingHistory.filter((record) => (
      String(record.location?.vehicle_id || '') === String(vehicleHistoryFilter)
    ));

  const historyWindow = getParkingHistoryPageWindow(
    filteredParkingHistory.length,
    historyPage,
    PARKING_HISTORY_PAGE_SIZE,
  );
  const visibleParkingHistory = filteredParkingHistory.slice(
    historyWindow.offset,
    historyWindow.offset + PARKING_HISTORY_PAGE_SIZE,
  );

  const refresh = useCallback(async ({ resetDisplay = false } = {}) => {
    const syncBefore = await inspectParkingSyncStatus().catch(() => null);
    try {
      await reconcileNativeParkingState();
      setParkingSyncIssue(null);
      if (syncBefore && !['synced', 'empty', 'not_applicable'].includes(syncBefore.status)) {
        setParkingSyncNotice('A stale or missing app/widget parking record was detected and safely repaired.');
      }
    } catch (error) {
      setParkingSyncIssue(error?.message || 'The app and Android widget could not be synchronized.');
    }
    const [state, history, vehicleStates, learning, permissions, reminder, remindersByVehicle, localDiagnostics, nativeDiagnostics] = await Promise.all([
      getLastParkingState(),
      getParkingHistory(),
      getVehicleParkingStates(),
      getParkingLearningProfile(),
      getPermissionStatus().catch(() => null),
      getParkingReminderState().catch(() => null),
      getParkingReminderStates().catch(() => ({})),
      getParkingDiagnostics().catch(() => []),
      isNativePlatform() ? DriveSenseNative.getNativeDiagnostics().catch(() => null) : null,
    ]);
    const staleReminder = await cancelStaleParkingReminder(parkingStateRevision(state))
      .catch(() => false);
    setParkingState(state);
    setParkingHistory(history);
    setVehicleParkingStates(vehicleStates);
    setLearningProfile(learning);
    setPermissionStatus(permissions);
    setParkingReminderState(staleReminder ? null : reminder);
    setVehicleReminders(staleReminder
      ? await getParkingReminderStates().catch(() => ({}))
      : remindersByVehicle);
    setParkingDiagnostics([
      ...(Array.isArray(localDiagnostics) ? localDiagnostics : []),
      ...(Array.isArray(nativeDiagnostics?.events) ? nativeDiagnostics.events.map((event, index) => ({
        id: `native-${index}-${event.timestamp || ''}`,
        timestamp: event.timestamp,
        type: event.type || event.event || 'native_parking_event',
        detail: event.title || event.detail || event.reason || '',
      })) : []),
    ].sort((a, b) => Date.parse(b.timestamp || '') - Date.parse(a.timestamp || '')).slice(0, 100));
    setReminderClock(Date.now());
    const currentLocation = state?.status === 'saved' ? state.location || null : null;
    if (resetDisplay) {
      setDisplayLocation(currentLocation);
      setViewingHistoryId(null);
    } else {
      setDisplayLocation((current) => current || currentLocation);
    }
    setLoading(false);
    return state;
  }, []);

  const isPrivateParkingDraft = useCallback(async (location) => {
    const zones = await getHydratedPrivacyZones(localSettings.get());
    return isPointInPrivacyZone(location, zones, PARKED_LOCATION_PRIVACY_GUARD_M);
  }, []);

  const discardUnsavedPhoto = useCallback(async () => {
    if (isNativePlatform() && photoFileId && photoFileId !== originalPhotoFileId) {
      await DriveSenseNative.deleteParkingPhoto({ photoId: photoFileId }).catch(() => {});
    }
  }, [originalPhotoFileId, photoFileId]);

  const recordPrivateParking = useCallback(async () => {
    const selectedVehicle = vehicles.find(
      (vehicle) => String(vehicle.id) === String(vehicleId),
    );
    await suppressLastParkedLocation({
      timestamp: new Date().toISOString(),
      source: 'privacy_zone',
      tripId: `manual-private-parking-${Date.now()}`,
      vehicleId: vehicleId || null,
      vehicleName: selectedVehicle?.name || null,
    });
    setPrivateSavePending(false);
    setEditorOpen(false);
    setDraft(null);
    setDisplayLocation(null);
    setNote('');
    setPhotoDataUrl(null);
    await discardUnsavedPhoto();
    setPhotoFileId(null);
    setOriginalPhotoFileId(null);
    setPhotoExpiresAt(null);
    setPhotoExpiryDirty(false);
    setVehicleId('');
    setIndoorEstimated(false);
    setGarageHint('');
    const protectedState = await refresh({ resetDisplay: true });
    setSaveReceipt({
      privacyProtected: true,
      revision: parkingStateRevision(protectedState),
      timestamp: protectedState?.timestamp || new Date().toISOString(),
      noteSaved: false,
      photoSaved: false,
      vehicleName: selectedVehicle?.name || null,
    });
    setActionStatus('Currently parked privately. No coordinates, note, or photo were stored.');
    toast({
      title: 'Private parking protected',
      description: 'No coordinates, note, or photo were stored or sent to the widget.',
    });
    scrollToSaveReceipt();
    return true;
  }, [discardUnsavedPhoto, refresh, vehicleId, vehicles]);

  const openEditor = useCallback(async ({ useCurrentLocation = false, location = null } = {}) => {
    setActionStatus('');
    setSaveReceipt(null);
    let source = location || (parkingState?.status === 'saved' ? parkingState.location : null);
    if (useCurrentLocation || !source) {
      try {
        source = await getCurrentLocation();
      } catch (error) {
        setActionStatus(error?.message || 'A current GPS fix is required to save this parking spot.');
        return;
      }
    }
    if (await isPrivateParkingDraft(source)) {
      await discardUnsavedPhoto();
      setPrivateSavePending(true);
      setEditorOpen(false);
      setDraft(null);
      setDisplayLocation(null);
      setNote('');
      setPhotoDataUrl(null);
      setPhotoFileId(null);
      setOriginalPhotoFileId(null);
      setPhotoExpiresAt(null);
      setPhotoExpiryDirty(false);
      const defaultVehicle = vehicles.find((vehicle) => vehicle.is_default) || vehicles[0] || null;
      setVehicleId(String(defaultVehicle?.id ?? ''));
      setActionStatus('Private zone detected. Confirm the protected state below; no coordinates have been stored.');
      return;
    }
    setPrivateSavePending(false);
    const next = { ...source, lat: Number(source.lat), lng: Number(source.lng) };
    setDraft(next);
    setDisplayLocation(next);
    setNote(source.note || '');
    setPhotoDataUrl(source.photo_data_url || null);
    setPhotoFileId(source.photo_file_id || null);
    setOriginalPhotoFileId(source.photo_file_id || null);
    setPhotoExpiresAt(source.photo_expires_at || null);
    const hasStoredRetention = source.photo_retention_hours != null;
    const storedRetentionHours = Number(source.photo_retention_hours);
    setPhotoRetentionHours(
      hasStoredRetention &&
      PARKING_PHOTO_RETENTION_OPTIONS.some(({ hours }) => hours === storedRetentionHours)
        ? storedRetentionHours
        : DEFAULT_PARKING_PHOTO_RETENTION_HOURS,
    );
    setPhotoExpiryDirty(Boolean(source.photo_data_url) && !hasStoredRetention);
    const defaultVehicle = vehicles.find((vehicle) => vehicle.is_default) || vehicles[0] || null;
    setVehicleId(String(source.vehicle_id ?? defaultVehicle?.id ?? ''));
    setIndoorEstimated(source.indoor_estimated === true);
    setGarageHint(source.garage_hint || '');
    setEditorOpen(true);
    setViewingHistoryId(null);
  }, [discardUnsavedPhoto, isPrivateParkingDraft, parkingState, vehicles]);

  useEffect(() => {
    vehicleService.list({ sort: '-created_date', limit: 50 })
      .then((items) => setVehicles(Array.isArray(items) ? items : []))
      .catch(() => setVehicles([]));
  }, []);

  useEffect(() => {
    if (!undoSnapshot) return undefined;
    const timeout = window.setTimeout(() => {
      if (isNativePlatform()) {
        (undoSnapshot.pendingPhotoIds || []).forEach((photoId) => {
          DriveSenseNative.deleteParkingPhoto({ photoId }).catch(() => {});
        });
      }
      setUndoSnapshot(null);
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [undoSnapshot]);

  const armUndo = useCallback((label, { restoreCurrent = false, pendingPhotoIds = [] } = {}) => {
    if (isNativePlatform()) {
      (undoSnapshot?.pendingPhotoIds || []).forEach((photoId) => {
        DriveSenseNative.deleteParkingPhoto({ photoId }).catch(() => {});
      });
    }
    setUndoSnapshot({
      label,
      restoreCurrent,
      pendingPhotoIds: Array.from(new Set(pendingPhotoIds.filter(Boolean))),
      parkingState,
      parkingHistory,
      parkingReminder,
    });
  }, [parkingHistory, parkingReminder, parkingState, undoSnapshot]);

  const undoLastParkingAction = async () => {
    const snapshot = undoSnapshot;
    if (!snapshot) return;
    setUndoSnapshot(null);
    setActionStatus('Restoring the previous parking state...');
    try {
      await replaceParkingHistory(snapshot.parkingHistory);
      if (snapshot.restoreCurrent) {
        await clearCurrentParkingState();
        if (snapshot.parkingState?.status === 'saved' && snapshot.parkingState.location) {
          await saveLastParkedLocation({
            ...snapshot.parkingState.location,
            timestamp: snapshot.parkingState.timestamp || snapshot.parkingState.location.timestamp,
            tripId: snapshot.parkingState.tripId ?? snapshot.parkingState.location.tripId,
            source: 'undo_restore',
            verified: snapshot.parkingState.location.verified === true,
          });
        } else if (snapshot.parkingState?.status) {
          await suppressLastParkedLocation({
            timestamp: snapshot.parkingState.timestamp,
            tripId: snapshot.parkingState.tripId,
            source: snapshot.parkingState.status === 'private'
              ? 'privacy_zone'
              : snapshot.parkingState.source,
          });
        }
      }
      if (snapshot.parkingReminder?.reminderAt > Date.now()) {
        await scheduleParkingReminder({
          minutes: Math.max(1, Math.ceil((snapshot.parkingReminder.reminderAt - Date.now()) / 60_000)),
          stateRevision: parkingStateRevision(await getLastParkingState()),
          vehicleName: snapshot.parkingState?.location?.vehicle_name || '',
        });
      }
      await refresh({ resetDisplay: true });
      setActionStatus(`${snapshot.label} undone.`);
    } catch (error) {
      setActionStatus(error?.message || 'The parking action could not be undone.');
    }
  };

  const markCarFound = useCallback(async () => {
    const confirmed = await requestAppConfirm({
      title: 'Clear the current parked-car marker?',
      message: 'The current marker, photo, and reminder will be removed. Parking history will remain.',
      confirmLabel: 'I found my car',
      destructive: true,
    });
    if (!confirmed) return;
    armUndo('Clear parked-car marker', {
      restoreCurrent: true,
      pendingPhotoIds: [parkingState?.location?.photo_file_id],
    });
    await cancelParkingReminder().catch(() => {});
    await clearCurrentParkingState();
    await refresh({ resetDisplay: true });
    setActionStatus('Current parked-car marker cleared. Parking history was kept.');
  }, [armUndo, refresh]);

  const setParkingReminder = useCallback(async (requestedAt = null) => {
    if (!parkingState?.status) {
      setActionStatus('Save or confirm a parking state before setting a reminder.');
      return;
    }
    const selectedVehicle = vehicles.find(
      (vehicle) => String(vehicle.id) === String(
        parkingState.location?.vehicle_id ?? parkingState.vehicle_id ?? '',
      ),
    );
    const scheduled = await scheduleParkingReminder({
      minutes: reminderMinutes,
      reminderAt: requestedAt ? new Date(requestedAt).getTime() : null,
      stateRevision: parkingStateRevision(parkingState),
      vehicleName: parkingState.location?.vehicle_name || parkingState.vehicle_name || selectedVehicle?.name || '',
      vehicleId: parkingState.location?.vehicle_id ?? parkingState.vehicle_id ?? null,
    });
    setParkingReminderState(scheduled ? await getParkingReminderState() : null);
    setReminderClock(Date.now());
    setActionStatus(scheduled
      ? requestedAt
        ? `Parking reminder set for ${new Date(requestedAt).toLocaleString()}.`
        : `Parking reminder set for ${reminderMinutes < 60
          ? `${reminderMinutes} minutes`
          : `${reminderMinutes / 60} hour${reminderMinutes === 60 ? '' : 's'}`}.`
      : 'Parking reminder needs notification permission.');
  }, [parkingState, reminderMinutes, vehicles]);

  useEffect(() => {
    refresh({ resetDisplay: true }).catch(() => {
      setLoading(false);
      setActionStatus('Parking records could not be loaded.');
    });
    const onChanged = () => refresh({ resetDisplay: true }).catch(() => {});
    const onResume = () => {
      if (document.visibilityState === 'visible') onChanged();
    };
    window.addEventListener(PARKING_HISTORY_CHANGED_EVENT, onChanged);
    window.addEventListener(PARKING_REMINDER_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.removeEventListener(PARKING_HISTORY_CHANGED_EVENT, onChanged);
      window.removeEventListener(PARKING_REMINDER_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [refresh]);

  useEffect(() => {
    if (!parkingReminder) return undefined;
    const update = () => {
      const now = Date.now();
      setReminderClock(now);
      if (Number(parkingReminder.reminderAt) <= now) setParkingReminderState(null);
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [parkingReminder]);

  useEffect(() => {
    if (loading) return;
    const action = searchParams.get('action');
    if (action === 'save') {
      openEditor({ useCurrentLocation: true }).catch(() => {});
    } else if (action === 'verify' && parkingState?.status === 'saved') {
      openEditor({ location: parkingState.location }).catch(() => {});
    } else if (action === 'verify' && parkingState?.status === 'private') {
      setActionStatus('Currently parked privately. The exact location is intentionally unavailable.');
    } else if (action === 'found') {
      markCarFound().catch(() => setActionStatus('The parked-car marker could not be cleared.'));
    } else if (action === 'reminder') {
      setActionStatus('Choose when you want the parking reminder.');
      window.setTimeout(() => {
        document.getElementById('parking-reminder-controls')?.scrollIntoView({
          behavior: preferredScrollBehavior(),
          block: 'center',
        });
      }, 0);
    } else if (action === 'snooze15' && parkingReminder) {
      setParkingReminder(new Date(Number(parkingReminder.reminderAt) + 15 * 60_000).toISOString())
        .catch(() => setActionStatus('The parking reminder could not be extended.'));
    } else if (action === 'cancelreminder') {
      cancelParkingReminder()
        .then(() => {
          setParkingReminderState(null);
          setActionStatus('Parking reminder cancelled from the widget.');
        })
        .catch(() => setActionStatus('The parking reminder could not be cancelled.'));
    }
    if (action) {
      const next = new URLSearchParams(searchParams);
      next.delete('action');
      setSearchParams(next, { replace: true });
    }
  }, [loading, markCarFound, openEditor, parkingReminder, parkingState, searchParams, setParkingReminder, setSearchParams]);

  useEffect(() => {
    if (historyPage !== historyWindow.page) setHistoryPage(historyWindow.page);
  }, [historyPage, historyWindow.page]);

  useEffect(() => setHistoryPage(0), [vehicleHistoryFilter]);

  const saveCorrection = async () => {
    if (savingParking) return;
    if (!Number.isFinite(Number(draft?.lat)) || !Number.isFinite(Number(draft?.lng))) {
      setActionStatus('Choose a valid marker location first.');
      return;
    }
    setSavingParking(true);
    setActionStatus('Checking privacy and saving parking...');
    try {
      if (await isPrivateParkingDraft(draft)) {
        await discardUnsavedPhoto();
        setPrivateSavePending(true);
        setEditorOpen(false);
        setDraft(null);
        setDisplayLocation(null);
        setNote('');
        setPhotoDataUrl(null);
        setPhotoFileId(null);
        setOriginalPhotoFileId(null);
        setPhotoExpiresAt(null);
        setPhotoExpiryDirty(false);
        setActionStatus('The marker entered a privacy zone. Confirm protected parking without coordinates.');
        return;
      }
      const current = parkingState?.status === 'saved' ? parkingState.location : null;
      const isNew = !current;
      const timestamp = isNew
        ? new Date().toISOString()
        : current.timestamp || parkingState.timestamp || new Date().toISOString();
      const tripId = isNew
        ? `manual-parking-${Date.now()}`
        : current.tripId ?? parkingState.tripId ?? `manual-parking-${Date.now()}`;
      const resolvedPhotoExpiresAt = photoDataUrl
        ? photoExpiryDirty
          ? photoRetentionHours > 0
            ? new Date(Date.now() + photoRetentionHours * 60 * 60 * 1000).toISOString()
            : null
          : photoExpiresAt
        : null;
      const selectedVehicle = vehicles.find(
        (vehicle) => String(vehicle.id) === String(vehicleId),
      );
      const saved = await saveLastParkedLocation({
        ...current,
        ...draft,
        endpointLat: draft.lat,
        endpointLng: draft.lng,
        timestamp,
        tripId,
        source: isNew ? 'manual_save_where_parked' : 'manual_marker_correction',
        confidence: 'high',
        confidenceScore: 100,
        evidence: ['manual_location_verified'],
        strategy: 'manual_verified',
        vehicleId: vehicleId || null,
        vehicleName: selectedVehicle?.name || null,
        indoorEstimated,
        garageEntrance: indoorEstimated
          ? current?.garage_entrance || {
            lat: Number(draft.lat),
            lng: Number(draft.lng),
            accuracy_m: Number(draft.accuracy_m) || null,
          }
          : null,
        garageHint,
        note,
        photoDataUrl,
        photoFileId,
        photoExpiresAt: resolvedPhotoExpiresAt,
        photoRetentionHours: photoDataUrl ? photoRetentionHours : null,
        verified: true,
        correctionReason: isNew ? 'manual_save' : 'marker_moved',
        correctedAt: new Date().toISOString(),
      });
      if (!saved) throw new Error('Parking could not be saved.');

      const [confirmedState, confirmedHistory] = await Promise.all([
        getLastParkingState(),
        getParkingHistory(),
      ]);
      const confirmedLocation = confirmedState?.status === 'saved'
        ? confirmedState.location
        : null;
      const savedRevision = parkingStateRevision(saved);
      const confirmedRevision = parkingStateRevision(confirmedState);
      const expectedNote = String(note || '').trim().slice(0, MAX_PARKING_NOTE_LENGTH);
      const notePersisted = !expectedNote || confirmedLocation?.note === expectedNote;
      const photoPersisted = !photoDataUrl || Boolean(
        confirmedLocation?.photo_data_url || confirmedLocation?.photo_file_id,
      );
      const expectedHistoryId = tripId != null
        ? `trip:${String(tripId)}`
        : `parking:${timestamp}`;
      const confirmedHistoryRecord = confirmedHistory.find(
        (record) => record.id === expectedHistoryId,
      );
      const historyPersisted = Boolean(
        confirmedHistoryRecord?.status === 'saved' &&
        parkingStateRevision(confirmedHistoryRecord) === confirmedRevision &&
        (!expectedNote || confirmedHistoryRecord.note === expectedNote) &&
        (!photoDataUrl || confirmedHistoryRecord.photo_data_url || confirmedHistoryRecord.photo_file_id),
      );
      if (
        !confirmedLocation ||
        savedRevision !== confirmedRevision ||
        !notePersisted ||
        !photoPersisted ||
        !historyPersisted
      ) {
        throw new Error(
          'Parking was not fully verified after saving. Keep this screen open and try Save parking details again.',
        );
      }

      const receipt = {
        revision: confirmedRevision,
        timestamp: confirmedLocation.timestamp || confirmedState.timestamp,
        noteSaved: Boolean(confirmedLocation.note),
        photoSaved: Boolean(confirmedLocation.photo_data_url || confirmedLocation.photo_file_id),
        historySaved: true,
        vehicleName: confirmedLocation.vehicle_name || null,
      };
      setParkingState(confirmedState);
      setEditorOpen(false);
      setDraft(null);
      setViewingHistoryId(null);
      setDisplayLocation(confirmedLocation);
      setSaveReceipt(receipt);
      setActionStatus('Parking saved and verified. Complete details are shown below.');
      toast({
        title: 'Parking saved and verified',
        description: `Location${receipt.noteSaved ? ', note' : ''}${receipt.photoSaved ? ', photo' : ''} and Android widget revision were confirmed.`,
      });
      scrollToSaveReceipt();

      if (photoDataUrl === null) {
        const savedRecordId = saved.tripId != null
          ? `trip:${String(saved.tripId)}`
          : `parking:${saved.timestamp}`;
        await updateParkingHistoryRecord(savedRecordId, {
          photo_data_url: null,
          photo_file_id: null,
        });
      }
      if (isNativePlatform() && originalPhotoFileId && originalPhotoFileId !== photoFileId) {
        await DriveSenseNative.deleteParkingPhoto({ photoId: originalPhotoFileId }).catch(() => {});
      }
      if (current) {
        const movementM = parkingPointDistanceM(current, draft);
        setLearningProfile(await recordParkingLearningFeedback({
          kind: Number(movementM) >= 5 ? 'marker_moved' : 'verified',
          movementM: movementM || 0,
        }));
      } else {
        setLearningProfile(await recordParkingLearningFeedback({ kind: 'verified' }));
      }
      const refreshedState = await refresh({ resetDisplay: true });
      if (
        refreshedState?.status !== 'saved' ||
        parkingStateRevision(refreshedState) !== confirmedRevision
      ) {
        throw new Error('The saved parking revision changed during refresh. Review the current parking details.');
      }
      setActionStatus('Parking saved and verified. Complete details are shown below.');
    } catch (error) {
      setActionStatus(error?.message || 'Parking could not be saved. Please try again.');
    } finally {
      setSavingParking(false);
    }
  };

  const rejectCurrent = async () => {
    const current = parkingState?.status === 'saved' ? parkingState.location : null;
    if (!current) return;
    const confirmed = await requestAppConfirm({
      title: 'Reject this parking location?',
      message: 'This removes it as the current car location and teaches local parking detection that the result was incorrect.',
      confirmLabel: 'This is not where I parked',
      destructive: true,
    });
    if (!confirmed) return;
    armUndo('Reject parking location', {
      restoreCurrent: true,
      pendingPhotoIds: [current.photo_file_id],
    });
    const historyId = current.tripId != null
      ? `trip:${String(current.tripId)}`
      : `parking:${current.timestamp}`;
    await rejectParkingHistoryRecord(historyId);
    setLearningProfile(await recordParkingLearningFeedback({ kind: 'rejected' }));
    await suppressLastParkedLocation({
      timestamp: new Date().toISOString(),
      source: 'manual_parking_rejected',
      tripId: `manual-reject-${Date.now()}`,
    });
    await refresh({ resetDisplay: true });
    setActionStatus('The incorrect location was rejected locally.');
  };

  const showHistoryRecord = (record) => {
    if (record.status !== 'saved' || !record.location) return;
    setViewingHistoryId(record.id);
    setDisplayLocation({
      ...record.location,
      timestamp: record.timestamp,
      source: record.source || record.location?.source,
      verified: record.verified === true,
      state_revision: record.state_revision || record.location?.state_revision,
      note: record.note,
      photo_data_url: record.photo_data_url,
      photo_file_id: record.photo_file_id,
      photo_expires_at: record.photo_expires_at,
      photo_retention_hours: record.photo_retention_hours,
    });
    setActionStatus('');
  };

  const scrollToSavedDetails = () => {
    window.requestAnimationFrame(() => {
      savedDetailsRef.current?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
    });
  };

  const scrollToSaveReceipt = () => {
    window.requestAnimationFrame(() => {
      saveReceiptRef.current?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
    });
  };

  const showCurrentParking = async () => {
    const state = await refresh({ resetDisplay: true });
    if (state?.status === 'saved' && state.location) {
      setActionStatus('Showing the complete current parking record.');
      scrollToSavedDetails();
    } else if (state?.status === 'private') {
      setActionStatus('Currently parked privately. Exact details are protected.');
    } else {
      setActionStatus('There is no current public parking record to show.');
    }
  };

  const deleteHistoryRecord = async (record) => {
    const confirmed = await requestAppConfirm({
      title: 'Delete this parking record?',
      message: 'Its saved location, note, and photo will be permanently removed from local parking history.',
      confirmLabel: 'Delete record',
      destructive: true,
    });
    if (!confirmed) return;
    const currentPhotoId = parkingState?.status === 'saved'
      ? parkingState.location?.photo_file_id
      : null;
    armUndo('Delete parking record', {
      pendingPhotoIds: record.photo_file_id && record.photo_file_id !== currentPhotoId
        ? [record.photo_file_id]
        : [],
    });

    await deleteParkingHistoryRecord(record.id);
    if (viewingHistoryId === record.id) setViewingHistoryId(null);
    await refresh({ resetDisplay: true });
    setActionStatus('Parking history record permanently deleted.');
  };

  const selectParkingRecordForWidget = async (record) => {
    if (record?.status !== 'saved' || !record.location) return;
    const confirmed = await requestAppConfirm({
      title: 'Show this vehicle in the widget?',
      message: 'This parking record will become the active parked-car marker. Its history entry and local photo will be kept.',
      confirmLabel: 'Use for widget',
    });
    if (!confirmed) return;
    armUndo('Change widget vehicle', { restoreCurrent: true });
    setActionStatus('Updating the parking page and Android widget...');
    try {
      await clearCurrentParkingState();
      const selectedParking = await saveLastParkedLocation({
        ...record.location,
        timestamp: record.timestamp,
        tripId: record.tripId,
        note: record.note,
        photoDataUrl: record.photo_data_url,
        photoFileId: record.photo_file_id,
        photoExpiresAt: record.photo_expires_at,
        photoRetentionHours: record.photo_retention_hours,
        source: 'manual_vehicle_selection',
        verified: true,
        recordHistory: false,
      });
      const selectedVehicleId = record.location.vehicle_id ?? null;
      const selectedReminder = await getParkingReminderState({ vehicleId: selectedVehicleId });
      if (selectedReminder) {
        await scheduleParkingReminder({
          reminderAt: selectedReminder.reminderAt,
          stateRevision: parkingStateRevision(selectedParking),
          vehicleName: record.location.vehicle_name || selectedReminder.vehicleName || '',
          vehicleId: selectedVehicleId,
        });
      } else {
        await activateParkingReminderForVehicle(selectedVehicleId);
      }
      await refresh({ resetDisplay: true });
      setActionStatus(`${record.location.vehicle_name || 'Selected vehicle'} is now shown in the widget.`);
    } catch (error) {
      setActionStatus(error?.message || 'The widget vehicle could not be changed.');
    }
  };

  const useViewedParkingForWidget = async () => {
    const record = parkingHistory.find((item) => item.id === viewingHistoryId);
    await selectParkingRecordForWidget(record);
  };

  const deleteAllHistory = async () => {
    const confirmed = await requestAppConfirm({
      title: 'Clear all parking history?',
      message: 'All locally stored parking-history locations, notes, and photos will be permanently deleted. Your current parked-car marker will remain.',
      confirmLabel: 'Clear all history',
      destructive: true,
    });
    if (!confirmed) return;
    const currentPhotoId = parkingState?.status === 'saved'
      ? parkingState.location?.photo_file_id
      : null;
    armUndo('Clear parking history', {
      pendingPhotoIds: parkingHistory
        .map((record) => record.photo_file_id)
        .filter((photoId) => photoId && photoId !== currentPhotoId),
    });

    await clearParkingHistory();
    setViewingHistoryId(null);
    setHistoryPage(0);
    await refresh({ resetDisplay: true });
    setActionStatus('All parking history permanently deleted.');
  };

  const handleParkingPhoto = (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) {
      input.value = '';
      return;
    }

    readParkingPhoto(file)
      .then(async (value) => {
        const stored = isNativePlatform()
          ? await DriveSenseNative.storeParkingPhoto({ dataUrl: value })
          : { dataUrl: value, photoFileId: null };
        if (isNativePlatform() && photoFileId && photoFileId !== originalPhotoFileId) {
          await DriveSenseNative.deleteParkingPhoto({ photoId: photoFileId }).catch(() => {});
        }
        setPhotoDataUrl(stored.dataUrl || value);
        setPhotoFileId(stored.photoFileId || null);
        setPhotoExpiresAt(null);
        setPhotoExpiryDirty(true);
        setActionStatus('Parking photo ready to save locally.');
      })
      .catch((error) => setActionStatus(error.message))
      .finally(() => {
        input.value = '';
      });
  };

  const takeParkingPhoto = async () => {
    if (cameraBusy) return;
    if (!isNativePlatform()) {
      cameraInputRef.current?.click();
      return;
    }

    setCameraBusy(true);
    setActionStatus('Opening the camera...');
    try {
      const result = await DriveSenseNative.captureParkingPhoto();
      if (result?.cancelled) {
        setActionStatus('Camera closed without taking a photo.');
        return;
      }
      const value = String(result?.dataUrl || '');
      if (!value.startsWith('data:image/jpeg;base64,') ||
          value.length > MAX_PARKING_PHOTO_DATA_URL_LENGTH) {
        throw new Error('The camera photo could not be prepared for local parking storage.');
      }
      if (isNativePlatform() && photoFileId && photoFileId !== originalPhotoFileId) {
        await DriveSenseNative.deleteParkingPhoto({ photoId: photoFileId }).catch(() => {});
      }
      setPhotoDataUrl(value);
      setPhotoFileId(result.photoFileId || null);
      setPhotoExpiresAt(null);
      setPhotoExpiryDirty(true);
      setActionStatus('Parking photo ready. Tap Save and verify parking to keep it.');
    } catch (error) {
      setActionStatus(error?.message || 'The camera could not be opened.');
    } finally {
      setCameraBusy(false);
    }
  };

  const openFullParkingPhoto = async (location) => {
    photoViewerTriggerRef.current = document.activeElement;
    if (!location?.photo_file_id || !isNativePlatform()) {
      setPhotoViewerUrl(location?.photo_data_url || null);
      return;
    }
    setActionStatus('Opening the encrypted parking photo...');
    try {
      const result = await DriveSenseNative.readParkingPhoto({ photoId: location.photo_file_id });
      setPhotoViewerUrl(result?.dataUrl || location.photo_data_url || null);
      setActionStatus('');
    } catch (error) {
      setActionStatus(error?.message || 'The full parking photo is unavailable.');
    }
  };

  const openParkingDirections = (location) => {
    const target = location?.indoor_estimated && location?.garage_entrance
      ? location.garage_entrance
      : location;
    const lat = Number(target?.lat);
    const lng = Number(target?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setActionStatus('Directions are unavailable because this parking record has no safe public coordinate.');
      return;
    }
    const label = location?.indoor_estimated ? 'Parking garage entrance' : 'Parked car';
    window.location.href = isNativePlatform()
      ? `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(label)})`
      : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  };

  const missingParkingPermissions = permissionStatus
    ? [
      ['foregroundLocation', 'Location'],
      ['backgroundLocation', 'Background location'],
      ['activityRecognition', 'Physical activity'],
    ].filter(([key]) => permissionStatus[key] !== 'granted').map(([, label]) => label)
    : [];
  const notificationPermissionMissing =
    permissionStatus && permissionStatus.notifications !== 'granted';

  return (
    <div className="space-y-5 pb-5">
      <div className="app-page-header">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Car className="h-6 w-6 text-orange-500" />
            <h1 className="text-2xl font-grotesk font-bold">Where I parked</h1>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          The dedicated companion page for the Android home-screen widget.
        </p>
      </div>

      {(parkingSyncIssue || parkingSyncNotice) && (
        <section
          role={parkingSyncIssue ? 'alert' : 'status'}
          className={`rounded-2xl border p-4 ${
            parkingSyncIssue
              ? 'border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100'
              : 'border-sky-300 bg-sky-50 text-sky-950 dark:bg-sky-950/30 dark:text-sky-100'
          }`}
        >
          <div className="font-semibold">
            {parkingSyncIssue ? 'Parking synchronization needs attention' : 'Parking record repaired'}
          </div>
          <div className="mt-1 text-sm">{parkingSyncIssue || parkingSyncNotice}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {parkingSyncIssue && (
              <button
                type="button"
                onClick={() => refresh({ resetDisplay: true })}
                className="min-h-9 rounded-lg border border-current px-3 text-xs font-bold"
              >
                Retry safe repair
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const log = document.getElementById('parking-recovery-log');
                if (log instanceof HTMLDetailsElement) {
                  log.open = true;
                  log.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
                }
              }}
              className="min-h-9 rounded-lg border border-current px-3 text-xs font-semibold"
            >
              Review recovery log
            </button>
            {!parkingSyncIssue && (
              <button
                type="button"
                onClick={() => setParkingSyncNotice(null)}
                className="min-h-9 rounded-lg px-3 text-xs font-semibold"
              >
                Dismiss
              </button>
            )}
          </div>
        </section>
      )}

      {saveReceipt && (
        <section
          ref={saveReceiptRef}
          role="status"
          aria-live="polite"
          className="rounded-2xl border border-emerald-400 bg-emerald-50 p-4 text-emerald-950 shadow-sm dark:bg-emerald-950/30 dark:text-emerald-50"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
              <Check className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                {saveReceipt.privacyProtected
                  ? 'Private parking protected'
                  : 'Parking saved and verified'}
              </div>
              <div className="mt-1 text-sm">
                {saveReceipt.privacyProtected
                  ? 'No coordinates, note, or photo were stored. The Android widget received only the protected private state.'
                  : (
                    <>
                      The public location was stored locally and Android widget revision{' '}
                      {String(saveReceipt.revision).slice(-6)} was confirmed.
                    </>
                  )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs font-medium">
                <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-50">
                  {saveReceipt.privacyProtected ? 'Coordinates not stored' : 'Location saved'}
                </span>
                {saveReceipt.noteSaved && (
                  <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-50">
                    Note saved
                  </span>
                )}
                {saveReceipt.photoSaved && (
                  <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-50">
                    Photo saved
                  </span>
                )}
                {saveReceipt.historySaved && (
                  <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-50">
                    History verified
                  </span>
                )}
                {saveReceipt.vehicleName && (
                  <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-50">
                    {saveReceipt.vehicleName}
                  </span>
                )}
              </div>
              {!saveReceipt.privacyProtected && (
                <button
                  type="button"
                  onClick={scrollToSavedDetails}
                  className="mt-3 min-h-9 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white"
                >
                  View saved note, photo, and details
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss parking saved confirmation"
              onClick={() => setSaveReceipt(null)}
              className="rounded-lg p-2 hover:bg-emerald-100 dark:hover:bg-emerald-900"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Current car state
            </div>
            <div className="mt-1 text-lg font-semibold">
              {loading
                ? 'Loading parking state...'
                : parkingState?.status === 'saved'
                  ? `${Math.round(Number(parkingState.location?.confidence_score) || 0)}% confidence${
                    parkingState.location?.verified ? ' · Verified' : ''
                  }`
                  : parkingState?.status === 'private'
                    ? 'Currently parked privately'
                    : parkingState?.status === 'unavailable'
                      ? 'Parking location needs review'
                      : 'No parking event yet'}
            </div>
            {parkingState?.timestamp && (
              <div className="mt-1 text-xs text-muted-foreground">
                Updated {relativeTime(parkingState.timestamp)}
                {parkingStateRevision(parkingState) > 0
                  ? ` · Synced revision ${String(parkingStateRevision(parkingState)).slice(-6)}`
                  : ''}
              </div>
            )}
            {parkingState?.status === 'saved' && parkingState.location?.vehicle_name && (
              <div className="mt-1 text-xs font-medium">
                Vehicle: {parkingState.location.vehicle_name}
              </div>
            )}
            {parkingState?.status === 'saved' && parkingState.location?.garage_hint && (
              <div className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                <Building2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
                {parkingState.location.garage_hint}
              </div>
            )}
            {parkingState?.status === 'private' && (
              <div className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                <Shield className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
                The widget keeps the private parking state, but coordinates and directions remain hidden.
              </div>
            )}
            {parkingState?.status === 'saved' && Array.isArray(parkingState.location?.evidence) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {parkingState.location.evidence.slice(0, 6).map((item) => (
                  <span key={item} className="rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground">
                    {evidenceLabel(item)}
                  </span>
                ))}
              </div>
            )}
            {learningProfile?.feedback_count > 0 && (
              <div className="mt-2 text-xs font-medium text-primary">
                Local learning active · {learningProfile.feedback_count} review
                {learningProfile.feedback_count === 1 ? '' : 's'}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openEditor({ useCurrentLocation: true })}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-xs font-semibold text-primary-foreground"
            >
              <MapPin className="h-4 w-4" />
              Save where I parked
            </button>
            {parkingState?.status === 'saved' && (
              <>
                <button
                  type="button"
                  onClick={() => openEditor({ location: parkingState.location })}
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold"
                >
                  <Pencil className="h-4 w-4" />
                  Move marker
                </button>
                <button
                  type="button"
                  onClick={rejectCurrent}
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-red-300 px-3 text-xs font-semibold text-red-600"
                >
                  <X className="h-4 w-4" />
                  Not where I parked
                </button>
                <button
                  type="button"
                  onClick={markCarFound}
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold"
                >
                  <LocateFixed className="h-4 w-4" />
                  I found my car
                </button>
              </>
            )}
            {parkingState?.status === 'private' && (
              <button
                type="button"
                onClick={markCarFound}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-xs font-semibold"
              >
                <LocateFixed className="h-4 w-4" />
                I found my car
              </button>
            )}
          </div>
        </div>
        {actionStatus && <div className="mt-3 text-xs font-medium text-primary">{actionStatus}</div>}
        {undoSnapshot && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
            <span className="text-xs font-medium">{undoSnapshot.label} completed.</span>
            <button
              type="button"
              onClick={undoLastParkingAction}
              className="min-h-9 rounded-lg border border-amber-400 px-3 text-xs font-bold"
            >
              Undo
            </button>
          </div>
        )}
      </section>

      {privateSavePending && (
        <section
          role="region"
          aria-labelledby="private-parking-confirm-title"
          className="rounded-2xl border border-emerald-400 bg-emerald-50 p-4 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-50"
        >
          <div className="flex items-start gap-3">
            <Shield className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-300" />
            <div className="min-w-0 flex-1">
              <div id="private-parking-confirm-title" className="font-semibold">
                Private zone detected
              </div>
              <p className="mt-1 text-sm">
                No coordinates, note, photo, or map marker have been stored. Confirming saves only a protected
                “parked privately” state for the app and Android widget.
              </p>
              {vehicles.length > 0 && (
                <label className="mt-3 block text-xs font-medium">
                  Vehicle label (optional)
                  <select
                    value={vehicleId}
                    onChange={(event) => setVehicleId(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-emerald-300 bg-background px-3 py-2 text-sm text-foreground"
                  >
                    <option value="">Unassigned vehicle</option>
                    {vehicles.map((vehicle) => (
                      <option key={vehicle.id} value={vehicle.id}>
                        {vehicle.name || `${vehicle.make || ''} ${vehicle.model || ''}`.trim() || 'Vehicle'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => recordPrivateParking().catch((error) => {
                    setActionStatus(error?.message || 'Protected parking could not be saved.');
                  })}
                  className="min-h-10 rounded-xl bg-emerald-700 px-4 text-xs font-bold text-white"
                >
                  Save protected private state
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPrivateSavePending(false);
                    setVehicleId('');
                    setActionStatus('Private parking save cancelled. Nothing was stored.');
                  }}
                  className="min-h-10 rounded-xl border border-emerald-400 px-4 text-xs font-semibold"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      <section
        id="parking-reminder-controls"
        className="rounded-2xl border border-border bg-card p-4"
      >
        <div className="flex items-start gap-3">
          <Bell className="mt-0.5 h-5 w-5 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Parking reminder</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Set a local reminder for a parking meter, hotel checkout, or long stay.
              It is cancelled automatically when the parking revision changes.
            </div>
            {parkingReminder && Number(parkingReminder.reminderAt) > reminderClock && (
              <div
                role="status"
                className="mt-3 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2"
              >
                <div className="text-sm font-semibold text-primary">
                  Reminder active · {parkingReminderRemaining(
                    parkingReminder.reminderAt,
                    reminderClock,
                  )} remaining
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Due {new Date(parkingReminder.reminderAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={reminderMinutes}
                onChange={(event) => setReminderMinutes(Number(event.target.value))}
                className="min-h-10 rounded-xl border border-border bg-background px-3 text-sm"
              >
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={120}>2 hours</option>
                <option value={240}>4 hours</option>
                <option value={480}>8 hours</option>
                <option value={1440}>24 hours</option>
              </select>
              <button
                type="button"
                onClick={() => setParkingReminder()}
                disabled={!parkingState?.status}
                className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
              >
                <Bell className="h-4 w-4" />
                {parkingReminder ? 'Replace reminder' : 'Set reminder'}
              </button>
              {parkingReminder && (
                <>
                  <button
                    type="button"
                    onClick={() => setParkingReminder(
                      new Date(Number(parkingReminder.reminderAt) + 15 * 60_000).toISOString(),
                    )}
                    className="min-h-10 rounded-xl border border-border px-3 text-xs font-semibold"
                  >
                    +15 min
                  </button>
                  <button
                    type="button"
                    onClick={() => setParkingReminder(
                      new Date(Number(parkingReminder.reminderAt) + 60 * 60_000).toISOString(),
                    )}
                    className="min-h-10 rounded-xl border border-border px-3 text-xs font-semibold"
                  >
                    +1 hour
                  </button>
                </>
              )}
              {parkingReminder && (
                <button
                  type="button"
                  onClick={() => cancelParkingReminder()
                    .then(() => {
                      setParkingReminderState(null);
                      setActionStatus('Parking reminder cancelled.');
                    })
                    .catch(() => setActionStatus('Parking reminder could not be cancelled.'))}
                  className="min-h-10 rounded-xl border border-border px-3 text-xs font-semibold"
                >
                  Cancel reminder
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
              <label className="min-w-52 flex-1 text-xs font-medium">
                Custom date and time
                <input
                  type="datetime-local"
                  value={customReminderAt}
                  min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                  onChange={(event) => setCustomReminderAt(event.target.value)}
                  className="mt-1 min-h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                />
              </label>
              <button
                type="button"
                disabled={!parkingState?.status || !customReminderAt || new Date(customReminderAt).getTime() <= Date.now()}
                onClick={() => setParkingReminder(customReminderAt)}
                className="min-h-10 rounded-xl border border-primary px-3 text-xs font-semibold text-primary disabled:opacity-50"
              >
                Set custom reminder
              </button>
            </div>
          </div>
        </div>
      </section>

      {(missingParkingPermissions.length > 0 || notificationPermissionMissing) && (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">Parking permissions need attention</div>
              <div className="mt-1 text-xs">
                {missingParkingPermissions.length > 0
                  ? `${missingParkingPermissions.join(', ')} can reduce automatic parking confidence.`
                  : 'Notification permission is needed for parking reminders.'}
              </div>
              <button
                type="button"
                onClick={() => navigate('/settings')}
                className="mt-3 min-h-9 rounded-lg border border-amber-400 px-3 text-xs font-semibold"
              >
                Review permissions
              </button>
            </div>
          </div>
        </section>
      )}

      {(displayLocation || parkingState?.status === 'private') && (
        <section className="overflow-hidden rounded-2xl border border-border bg-card">
          {displayLocation ? (
            <TripMap
              routePoints={[]}
              parkedLocation={displayLocation}
              parkedLocationDraggable={editorOpen}
              showPrivacyZones={false}
              onParkedLocationMove={(location) => {
                setDraft((current) => ({ ...current, ...location }));
                setDisplayLocation((current) => ({ ...current, ...location }));
              }}
              smoothRoute={false}
              showIncompleteRouteWarning={false}
              height="320px"
            />
          ) : (
            <div className="flex min-h-48 items-center justify-center p-6 text-center">
              <div>
                <Shield className="mx-auto h-8 w-8 text-emerald-600" />
                <div className="mt-3 font-semibold">Private parking location protected</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  No exact marker can be displayed for this parking event.
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {detailsLocation && (
        <section
          ref={savedDetailsRef}
          className="scroll-mt-4 rounded-2xl border border-border bg-card p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-semibold">
                {detailsAreCurrent ? 'Current parking details' : 'Parking history details'}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {detailsAreCurrent
                  ? 'This complete saved record is shared with the Android widget.'
                  : 'This is the complete locally saved history record you selected.'}
              </div>
            </div>
            {detailsAreCurrent && (
              <button
                type="button"
                onClick={() => openEditor({ location: detailsLocation })}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit saved details
              </button>
            )}
            <button
              type="button"
              onClick={() => openParkingDirections(detailsLocation)}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground"
            >
              <Navigation className="h-3.5 w-3.5" />
              {detailsLocation.indoor_estimated ? 'Directions to entrance' : 'Directions to car'}
            </button>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Parked</dt>
              <dd className="font-medium">
                {new Date(detailsLocation.timestamp || parkingState?.timestamp).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Detection</dt>
              <dd className="font-medium">
                {Math.round(Number(detailsLocation.confidence_score) || 0)}% confidence
                {detailsLocation.verified ? ' · manually verified' : ''}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Vehicle</dt>
              <dd className="font-medium">{detailsLocation.vehicle_name || 'No vehicle assigned'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Location quality</dt>
              <dd className="font-medium">
                {detailsLocation.indoor_estimated
                  ? 'Indoor location estimated'
                  : Number(detailsLocation.accuracy_m) > 0
                    ? `GPS accuracy about ${Math.round(Number(detailsLocation.accuracy_m))} m`
                    : evidenceLabel(detailsLocation.source || 'Saved parking')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Saved position</dt>
              <dd className="break-all font-mono text-xs font-medium">
                {Number(detailsLocation.lat).toFixed(6)}, {Number(detailsLocation.lng).toFixed(6)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Storage</dt>
              <dd className="font-medium">
                Local encrypted record · revision {String(detailsLocation.state_revision || 0).slice(-6)}
              </dd>
            </div>
          </dl>
          {(detailsLocation.address || detailsLocation.garage_hint || detailsLocation.note) && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {detailsLocation.address && (
                <div className="rounded-xl border border-border bg-background p-3">
                  <div className="text-xs font-semibold text-muted-foreground">Saved address</div>
                  <div className="mt-1 text-sm">{detailsLocation.address}</div>
                </div>
              )}
              {detailsLocation.garage_hint && (
                <div className="rounded-xl border border-border bg-background p-3">
                  <div className="text-xs font-semibold text-muted-foreground">Garage / walking hint</div>
                  <div className="mt-1 text-sm">{detailsLocation.garage_hint}</div>
                </div>
              )}
              {detailsLocation.note && (
                <div className="rounded-xl border border-border bg-background p-3">
                  <div className="text-xs font-semibold text-muted-foreground">Local-only note</div>
                  <div className="mt-1 whitespace-pre-wrap text-sm">{detailsLocation.note}</div>
                </div>
              )}
            </div>
          )}
          {Array.isArray(detailsLocation.evidence) && detailsLocation.evidence.length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-semibold text-muted-foreground">Parking evidence</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detailsLocation.evidence.map((item) => (
                  <span key={item} className="rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground">
                    {evidenceLabel(item)}
                  </span>
                ))}
              </div>
            </div>
          )}
          {(detailsLocation.photo_data_url || detailsLocation.photo_file_id) && (
            <div className="mt-4">
              <div className="text-xs font-semibold text-muted-foreground">Parking photo</div>
              {detailsLocation.photo_data_url && (
                <img
                  src={detailsLocation.photo_data_url}
                  alt="Saved parking reference"
                  className="mt-2 max-h-56 rounded-xl border border-border object-cover"
                />
              )}
              <div className="mt-2 text-xs text-muted-foreground">
                Stored only on this device
                {detailsLocation.photo_expires_at
                  ? ` · deletes ${new Date(detailsLocation.photo_expires_at).toLocaleString()}`
                  : ' · deletes when the next parking location is confirmed'}
              </div>
              <button
                type="button"
                onClick={() => openFullParkingPhoto(detailsLocation)}
                className="mt-2 min-h-9 rounded-lg border border-border px-3 text-xs font-semibold"
              >
                View full photo
              </button>
            </div>
          )}
        </section>
      )}

      {editorOpen && draft && (
        <section className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">Review parking before saving</div>
              <div className="text-xs text-muted-foreground">
                Check the marker, note, photo, and vehicle. Nothing below is stored until you tap Save and verify parking.
              </div>
            </div>
            <button
              type="button"
              aria-label="Close parking editor"
              onClick={async () => {
                await discardUnsavedPhoto();
                setEditorOpen(false);
                setDraft(null);
                refresh({ resetDisplay: true }).catch(() => {});
              }}
              className="rounded-lg p-2 hover:bg-secondary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium">
              Latitude
              <input
                type="number"
                step="0.000001"
                value={draft.lat}
                onChange={(event) => {
                  const lat = Number(event.target.value);
                  setDraft((current) => ({ ...current, lat }));
                  if (Number.isFinite(lat)) setDisplayLocation((current) => ({ ...current, lat }));
                }}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="text-xs font-medium">
              Longitude
              <input
                type="number"
                step="0.000001"
                value={draft.lng}
                onChange={(event) => {
                  const lng = Number(event.target.value);
                  setDraft((current) => ({ ...current, lng }));
                  if (Number.isFinite(lng)) setDisplayLocation((current) => ({ ...current, lng }));
                }}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </label>
          </div>
          {vehicles.length > 0 && (
            <label className="mt-3 block text-xs font-medium">
              Vehicle
              <select
                value={vehicleId}
                onChange={(event) => setVehicleId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">Unassigned vehicle</option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.name || `${vehicle.make || ''} ${vehicle.model || ''}`.trim() || 'Vehicle'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="mt-3 flex items-start gap-2 rounded-xl border border-border bg-background p-3 text-xs">
            <input
              type="checkbox"
              checked={indoorEstimated}
              onChange={(event) => setIndoorEstimated(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-semibold">Indoor or parking-garage estimate</span>
              <span className="mt-0.5 block text-muted-foreground">
                Treat this marker as the last reliable entrance coordinate rather than an exact indoor position.
              </span>
            </span>
          </label>
          {indoorEstimated && (
            <label className="mt-3 block text-xs font-medium">
              Garage or walking hint
              <input
                value={garageHint}
                maxLength={MAX_PARKING_NOTE_LENGTH}
                onChange={(event) => setGarageHint(event.target.value)}
                placeholder="North entrance, level 3, blue elevators"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
          )}
          <label className="mt-3 block text-xs font-medium">
            Local-only note
            <input
              value={note}
              maxLength={MAX_PARKING_NOTE_LENGTH}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Level 3, section B"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <div className="mt-1 text-xs text-muted-foreground">
            A photo can help you remember a garage level, aisle, pillar, entrance, or nearby landmark.
          </div>
          {photoDataUrl && (
            <label className="mt-3 block text-xs font-medium">
              Automatically delete this photo
              <select
                value={photoRetentionHours}
                onChange={(event) => {
                  setPhotoRetentionHours(Number(event.target.value));
                  setPhotoExpiryDirty(true);
                }}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                {PARKING_PHOTO_RETENTION_OPTIONS.map((option) => (
                  <option key={option.hours} value={option.hours}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block font-normal text-muted-foreground">
                A newly confirmed parking location or privacy-zone arrival always deletes it sooner.
              </span>
            </label>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={cameraBusy || savingParking}
              onClick={takeParkingPhoto}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-semibold disabled:opacity-60"
            >
              {cameraBusy
                ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                : <Camera className="h-3.5 w-3.5" />}
              {cameraBusy ? 'Opening camera...' : photoDataUrl ? 'Retake photo' : 'Take photo'}
            </button>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="sr-only"
              onChange={handleParkingPhoto}
            />
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-semibold">
              <Upload className="h-3.5 w-3.5" />
              {photoDataUrl ? 'Replace from gallery' : 'Choose from gallery'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={handleParkingPhoto}
              />
            </label>
            {photoDataUrl && (
              <button
                type="button"
                onClick={async () => {
                  await discardUnsavedPhoto();
                  setPhotoDataUrl(null);
                  setPhotoFileId(null);
                  setPhotoExpiresAt(null);
                  setPhotoExpiryDirty(false);
                }}
                className="min-h-9 rounded-lg border border-border bg-background px-3 text-xs font-semibold"
              >
                Remove photo
              </button>
            )}
            <button
              type="button"
              onClick={saveCorrection}
              disabled={savingParking || cameraBusy}
              className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-60"
            >
              {savingParking
                ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                : <Check className="h-3.5 w-3.5" />}
              {savingParking ? 'Saving and verifying widget...' : 'Save and verify parking'}
            </button>
          </div>
          {savingParking && (
            <div role="status" className="mt-3 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-medium text-primary">
              Saving locally, reading the record back, and confirming the Android widget revision. Keep this page open.
            </div>
          )}
          {!savingParking && actionStatus && (
            <div role="status" aria-live="polite" className="mt-3 rounded-xl border border-border bg-background px-3 py-2 text-xs font-medium">
              {actionStatus}
            </div>
          )}
          {photoDataUrl && (
            <>
              <img
                src={photoDataUrl}
                alt="Local parking reference"
                className="mt-3 max-h-40 rounded-xl border border-border object-cover"
              />
              <div className="mt-2 text-xs text-muted-foreground">
                Optional local reference only. It does not affect parking confidence.
                The image is resized and its embedded metadata is removed before storage.
                {photoRetentionHours > 0
                  ? ` It will be deleted within ${PARKING_PHOTO_RETENTION_OPTIONS.find(
                    ({ hours }) => hours === photoRetentionHours,
                  )?.label || `${photoRetentionHours} hours`}.`
                  : ' It will be deleted when the next parking location is confirmed.'}
              </div>
            </>
          )}
        </section>
      )}

      {photoViewerUrl && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="parking-photo-dialog-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePhotoViewer();
          }}
        >
          <div className="relative max-h-full max-w-3xl">
            <div id="parking-photo-dialog-title" className="sr-only">Saved parking photo</div>
            <button
              ref={photoViewerCloseRef}
              type="button"
              aria-label="Close parking photo"
              onClick={closePhotoViewer}
              className="absolute right-2 top-2 rounded-full bg-black/70 p-2 text-white"
            >
              <X className="h-5 w-5" />
            </button>
            <img src={photoViewerUrl} alt="Full parking reference" className="max-h-[85vh] rounded-2xl object-contain" />
          </div>
        </div>
      )}

      {Object.keys(vehicleParkingStates).length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="font-semibold">Current parking by vehicle</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Each vehicle keeps its own latest protected state. The selected record is mirrored to the Android widget.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {Object.entries(vehicleParkingStates).map(([storedVehicleId, record]) => {
              const active = parkingStateRevision(record) === parkingStateRevision(parkingState);
              const location = record.status === 'saved' ? record.location : null;
              const vehicleReminder = vehicleReminders[storedVehicleId] || null;
              return (
                <div key={storedVehicleId} className="rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">
                        {record.vehicle_name || location?.vehicle_name || 'Vehicle'}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {record.status === 'private'
                          ? 'Parked privately · coordinates protected'
                          : location?.indoor_estimated
                            ? 'Indoor parking estimate'
                            : `Public parking · ${relativeTime(record.timestamp)}`}
                      </div>
                    </div>
                    {active && (
                      <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary">
                        In widget
                      </span>
                    )}
                  </div>
                  {record.status === 'saved' && (
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-semibold">
                      {record.note && <span className="rounded-full border border-border px-2 py-0.5">Note</span>}
                      {(record.photo_data_url || record.photo_file_id) && (
                        <span className="rounded-full border border-border px-2 py-0.5">Photo</span>
                      )}
                      {location?.indoor_estimated && (
                        <span className="rounded-full border border-border px-2 py-0.5">Garage</span>
                      )}
                    </div>
                  )}
                  {vehicleReminder && Number(vehicleReminder.reminderAt) > reminderClock && (
                    <div className="mt-2 rounded-lg bg-primary/10 px-2 py-1.5 text-xs font-semibold text-primary">
                      Reminder {parkingReminderRemaining(vehicleReminder.reminderAt, reminderClock)} remaining
                    </div>
                  )}
                  {record.status === 'saved' && !active && (
                    <button
                      type="button"
                      onClick={() => selectParkingRecordForWidget(record)}
                      className="mt-3 min-h-9 rounded-lg border border-primary px-3 text-xs font-semibold text-primary"
                    >
                      Show this vehicle in widget
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-semibold">
            <History className="h-4 w-4" />
            Recent parking history
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {vehicles.length > 1 && (
              <select
                aria-label="Filter parking history by vehicle"
                value={vehicleHistoryFilter}
                onChange={(event) => setVehicleHistoryFilter(event.target.value)}
                className="min-h-9 rounded-lg border border-border bg-background px-2 text-xs font-semibold"
              >
                <option value="all">All vehicles</option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>{vehicle.name || 'Vehicle'}</option>
                ))}
              </select>
            )}
            {viewingHistoryId && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={useViewedParkingForWidget}
                  className="text-xs font-semibold text-primary"
                >
                  Use for widget
                </button>
                <button
                  type="button"
                  onClick={showCurrentParking}
                  className="text-xs font-semibold text-primary"
                >
                  Show current parking and details
                </button>
              </div>
            )}
            {parkingHistory.length > 0 && (
              <button
                type="button"
                onClick={deleteAllHistory}
                className="inline-flex items-center gap-1 text-xs font-semibold text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear all
              </button>
            )}
          </div>
        </div>
        {filteredParkingHistory.length ? (
          <div className="mt-3">
            <div className="grid gap-2 sm:grid-cols-2">
            {visibleParkingHistory.map((record) => (
              <div
                key={record.id}
                className={`flex items-start gap-2 rounded-xl border p-3 ${
                  record.id === viewingHistoryId ? 'border-primary bg-primary/5' : 'border-border'
                }`}
              >
                <button
                  type="button"
                  disabled={record.status !== 'saved'}
                  onClick={() => showHistoryRecord(record)}
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">
                      {record.status === 'saved'
                        ? record.rejected
                          ? 'Rejected location'
                          : record.location?.indoor_estimated
                            ? 'Indoor estimate'
                            : 'Public parking'
                        : record.status === 'private'
                          ? 'Private parking'
                          : 'Parking needs review'}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {relativeTime(record.timestamp)}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {record.status === 'saved'
                      ? record.note || record.location?.address ||
                        `${record.location?.lat.toFixed(5)}, ${record.location?.lng.toFixed(5)}`
                      : record.status === 'private'
                        ? 'Coordinates intentionally not stored'
                        : evidenceLabel(record.source)}
                  </div>
                  {record.status === 'saved' && record.location?.vehicle_name && (
                    <div className="mt-1 text-[11px] font-medium text-foreground">
                      {record.location.vehicle_name}
                    </div>
                  )}
                  {record.status === 'saved' && (
                    <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Saved parking features">
                      {record.verified && (
                        <span className="rounded-full border border-emerald-300 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                          Verified
                        </span>
                      )}
                      {record.note && (
                        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold">
                          Note
                        </span>
                      )}
                      {(record.photo_data_url || record.photo_file_id) && (
                        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold">
                          Photo
                        </span>
                      )}
                      {record.location?.indoor_estimated && (
                        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold">
                          Garage
                        </span>
                      )}
                      {String(record.source || '').startsWith('manual') && (
                        <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold">
                          Manual
                        </span>
                      )}
                      <span className="text-[10px] font-semibold text-primary">View details</span>
                    </div>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => deleteHistoryRecord(record)}
                  aria-label={`Delete parking record from ${relativeTime(record.timestamp)}`}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <div className="text-xs text-muted-foreground">
                Showing {historyWindow.start}-{historyWindow.end} of {filteredParkingHistory.length}
                {' '}| up to {MAX_PARKING_HISTORY_RECORDS} retained locally
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setHistoryPage((page) => Math.max(0, page - 1))}
                  disabled={historyWindow.page <= 0}
                  aria-label="Show previous parking history"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span
                  className="min-w-14 text-center text-xs font-semibold"
                  aria-label={`Parking history page ${historyWindow.page + 1} of ${historyWindow.pageCount}`}
                >
                  {historyWindow.page + 1} / {historyWindow.pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setHistoryPage((page) => Math.min(historyWindow.pageCount - 1, page + 1))}
                  disabled={historyWindow.page >= historyWindow.pageCount - 1}
                  aria-label="Show next parking history"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-3 text-xs text-muted-foreground">
            Parking events will appear here after a trip ends or you save one manually.
          </div>
        )}
      </section>

      <details id="parking-recovery-log" className="scroll-mt-4 rounded-2xl border border-border bg-card p-4">
        <summary className="cursor-pointer font-semibold">Parking recovery log</summary>
        <div className="mt-2 text-xs text-muted-foreground">
          Local-only evidence explaining saves, blocked confidence downgrades, synchronization, and recovery decisions.
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => Promise.all([
              clearParkingDiagnostics(),
              isNativePlatform() ? DriveSenseNative.clearNativeDiagnostics() : Promise.resolve(),
            ]).then(() => setParkingDiagnostics([]))}
            className="min-h-9 rounded-lg border border-border px-3 text-xs font-semibold"
          >
            Clear log
          </button>
        </div>
        {parkingDiagnostics.length > 0 ? (
          <div className="mt-3 max-h-72 space-y-2 overflow-auto">
            {parkingDiagnostics.slice(0, 30).map((entry) => (
              <div key={entry.id} className="rounded-xl border border-border bg-background p-3 text-xs">
                <div className="flex justify-between gap-3">
                  <span className="font-semibold">{evidenceLabel(entry.type)}</span>
                  <span className="text-muted-foreground">{relativeTime(entry.timestamp)}</span>
                </div>
                {entry.detail && <div className="mt-1 text-muted-foreground">{entry.detail}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 text-xs text-muted-foreground">No parking recovery events recorded yet.</div>
        )}
      </details>
    </div>
  );
}
