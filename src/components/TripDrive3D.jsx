// @ts-check
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Camera, Flag, Gauge, LocateFixed, Pause, Play, RotateCcw, Route, SkipBack, Zap } from 'lucide-react';
import {
  SPEED_BANDS,
  buildPlaybackPositionIndex,
  buildPlaybackTimeline,
  playbackPositionAtElapsed,
  prepareMapRoutePoints,
  routeDistanceAtPlaybackPosition,
} from '@/lib/mapPlaybackInsights';
import { formatDistance, formatDuration, formatSpeed } from '@/lib/tripEngine';
import { HEIGHTENED_PRIVACY_MODE_KEY } from '@/lib/privacyMode';
import { maskEventsForPrivacy, maskRoutePointsForPrivacy } from '@/lib/privacyZones';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import useLocalSettings from '@/hooks/useLocalSettings';
import usePrivacyZonesRevision from '@/hooks/usePrivacyZonesRevision';

const SPEEDS = [1, 2, 4, 8];
const EVENT_COLORS = {
  harsh_brake: '#ef4444',
  rapid_acceleration: '#f59e0b',
  sharp_turn: '#3b82f6',
  speeding: '#f97316',
  idle: '#64748b',
  heading_deviation: '#0ea5e9',
  heading_deviation_legacy: '#0ea5e9',
  aggressive_overtake: '#f97316',
  near_miss: '#dc2626',
  close_proximity: '#dc2626',
  phone_use: '#dc2626',
  voice_speed_limit_marker: '#2563eb',
  possible_crash: '#991b1b',
};
const LAT_METERS = 111320;
const MAX_SCENE_SPAN = 92;
const DYNAMICS_LOOKBACK_SEGMENTS = 2;
const CAMERA_MODES = [
  { id: 'chase', label: 'Chase' },
  { id: 'top', label: 'Top' },
  { id: 'side', label: 'Side' },
  { id: 'event', label: 'Event' },
  { id: 'free', label: 'Free' },
];
const RENDER_QUALITIES = [
  { id: 'low', label: 'Low', pixelRatio: 0.85 },
  { id: 'medium', label: 'Med', pixelRatio: 1.2 },
  { id: 'high', label: 'High', pixelRatio: 2 },
];

const finiteCoordinate = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const validLatLngPoint = (point) => {
  const lat = finiteCoordinate(point?.lat);
  const lng = finiteCoordinate(point?.lng);
  if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { ...point, lat, lng };
};

const colorForEvent = (event = {}) => EVENT_COLORS[event.type] || '#475569';

const titleCase = (value = '') => String(value)
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

function buildProjection(points = []) {
  const valid = points.map(validLatLngPoint).filter(Boolean);
  if (!valid.length) return null;

  const minLat = Math.min(...valid.map((point) => point.lat));
  const maxLat = Math.max(...valid.map((point) => point.lat));
  const minLng = Math.min(...valid.map((point) => point.lng));
  const maxLng = Math.max(...valid.map((point) => point.lng));
  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;
  const lngMeters = LAT_METERS * Math.max(0.2, Math.cos(centerLat * Math.PI / 180));
  const spanMeters = Math.max(
    24,
    (maxLat - minLat) * LAT_METERS,
    (maxLng - minLng) * lngMeters
  );
  const sceneScale = Math.min(1.1, MAX_SCENE_SPAN / spanMeters);

  const project = (point) => {
    const lat = finiteCoordinate(point?.lat);
    const lng = finiteCoordinate(point?.lng);
    if (lat == null || lng == null) return null;
    return new THREE.Vector3(
      (lng - centerLng) * lngMeters * sceneScale,
      0,
      -(lat - centerLat) * LAT_METERS * sceneScale
    );
  };

  return {
    project,
    scale: sceneScale,
    span: spanMeters * sceneScale,
  };
}

function vectorHeading(from, to) {
  if (!from || !to) return 0;
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function angleDeltaDegrees(from = 0, to = 0) {
  let delta = ((to - from + 540) % 360) - 180;
  if (!Number.isFinite(delta)) delta = 0;
  return delta;
}

function dynamicsAtPlaybackPosition(timeline = {}, position = {}) {
  const segments = Array.isArray(timeline.segments) ? timeline.segments : [];
  const segment = segments.find((item) => (
    item.fromIndex === position.fromIndex && item.toIndex === position.toIndex
  )) || segments.find((item) => item.toIndex >= position.toIndex) || null;
  if (!segment) {
    return {
      segment: null,
      accelerationKmhPerSecond: 0,
      braking: false,
      accelerating: false,
      turnDeltaDegrees: 0,
      overLimitKmh: 0,
      intensity: 0,
    };
  }

  const previousSegments = segments
    .filter((item) => item.toIndex <= segment.fromIndex)
    .slice(-DYNAMICS_LOOKBACK_SEGMENTS);
  const previous = previousSegments.at(-1) || null;
  const previousSpeed = previous ? Number(previous.speedKmh) || 0 : Number(segment.from?.speed_kmh) || Number(segment.speedKmh) || 0;
  const currentSpeed = Number(position.point?.speed_kmh ?? segment.speedKmh) || 0;
  const durationSeconds = Math.max(1, Number(segment.durationSeconds) || 1);
  const accelerationKmhPerSecond = (currentSpeed - previousSpeed) / durationSeconds;
  const turnDeltaDegrees = previous ? angleDeltaDegrees(previous.heading, segment.heading) : 0;
  const overLimitKmh = Number(segment.overLimitKmh) || 0;
  const braking = accelerationKmhPerSecond <= -0.45 || ['harsh_brake', 'possible_crash'].includes(String(segment.to?.type || ''));
  const accelerating = accelerationKmhPerSecond >= 0.35 || currentSpeed > previousSpeed + 8;
  const intensity = Math.max(
    Math.min(1, Math.abs(accelerationKmhPerSecond) / 3.2),
    Math.min(1, Math.abs(turnDeltaDegrees) / 55),
    Math.min(1, overLimitKmh / 25)
  );

  return {
    segment,
    accelerationKmhPerSecond,
    braking,
    accelerating,
    turnDeltaDegrees,
    overLimitKmh,
    intensity,
  };
}

function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => material.dispose?.());
  });
}

function createSpeedLimitTexture(limit) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(64, 64, 54, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#ef4444';
  ctx.stroke();
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 42px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(limit)), 64, 58);
  ctx.font = 'bold 18px Inter, Arial, sans-serif';
  ctx.fillText('km/h', 64, 88);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function addSmoothRouteGuide(scene, projection, points = []) {
  const projected = points
    .map((point) => projection.project(point))
    .filter(Boolean);
  if (projected.length < 3) return;
  const curve = new THREE.CatmullRomCurve3(projected);
  const smoothPoints = curve.getPoints(Math.min(420, projected.length * 8));
  const geometry = new THREE.BufferGeometry().setFromPoints(smoothPoints.map((point) => point.clone().setY(0.22)));
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color: '#e0f2fe', transparent: true, opacity: 0.38 })
  );
  scene.add(line);
}

function addSpeedLimitSign(scene, from, to, limit, index) {
  const texture = createSpeedLimitTexture(limit);
  if (!texture) return;
  const heading = vectorHeading(from, to);
  const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
  const right = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
  const base = from.clone().lerp(to, 0.62).add(right.multiplyScalar(index % 2 === 0 ? 2.15 : -2.15));

  const group = new THREE.Group();
  group.position.copy(base);
  group.rotation.y = heading + (index % 2 === 0 ? -0.18 : Math.PI + 0.18);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 1.35, 10),
    new THREE.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.62 })
  );
  pole.position.y = 0.72;
  group.add(pole);

  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 0.95),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide })
  );
  sign.position.y = 1.55;
  sign.position.add(forward.multiplyScalar(0.02));
  group.add(sign);

  scene.add(group);
}

function createCarModel() {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#2563eb', metalness: 0.18, roughness: 0.36 });
  const roofMaterial = new THREE.MeshStandardMaterial({ color: '#93c5fd', metalness: 0.05, roughness: 0.2, transparent: true, opacity: 0.86 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: '#0f172a', roughness: 0.55 });
  const lightMaterial = new THREE.MeshStandardMaterial({ color: '#fef3c7', emissive: '#f59e0b', emissiveIntensity: 0.9 });
  const brakeMaterial = new THREE.MeshStandardMaterial({ color: '#7f1d1d', emissive: '#450a0a', emissiveIntensity: 0.12 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.55, 3.15), bodyMaterial);
  body.position.y = 0.48;
  body.castShadow = true;
  group.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.52, 1.42), roofMaterial);
  cabin.position.set(0, 0.95, -0.16);
  cabin.castShadow = true;
  group.add(cabin);

  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.2, 0.78), bodyMaterial);
  hood.position.set(0, 0.78, 1.08);
  hood.castShadow = true;
  group.add(hood);

  const headlightGeometry = new THREE.BoxGeometry(0.36, 0.12, 0.08);
  [-0.48, 0.48].forEach((x) => {
    const light = new THREE.Mesh(headlightGeometry, lightMaterial);
    light.position.set(x, 0.55, 1.62);
    group.add(light);
  });

  const brakeLightGeometry = new THREE.BoxGeometry(0.34, 0.13, 0.08);
  const brakeLights = [];
  [-0.48, 0.48].forEach((x) => {
    const light = new THREE.Mesh(brakeLightGeometry, brakeMaterial.clone());
    light.position.set(x, 0.55, -1.62);
    light.userData.isBrakeLight = true;
    brakeLights.push(light);
    group.add(light);
  });

  const wheelGeometry = new THREE.CylinderGeometry(0.28, 0.28, 0.26, 20);
  wheelGeometry.rotateZ(Math.PI / 2);
  [-0.98, 0.98].forEach((x) => {
    [-0.96, 0.96].forEach((z) => {
      const wheel = new THREE.Mesh(wheelGeometry, darkMaterial);
      wheel.position.set(x, 0.28, z);
      wheel.castShadow = true;
      wheel.userData.isWheel = true;
      group.add(wheel);
    });
  });

  const beacon = new THREE.PointLight('#93c5fd', 0.9, 16);
  beacon.position.set(0, 1.6, 0.7);
  group.add(beacon);

  group.position.y = 0.14;
  group.userData.brakeLights = brakeLights;
  return group;
}

function addRoadSegment(scene, from, to, color, index) {
  const length = from.distanceTo(to);
  if (length < 0.08) return null;

  const shoulder = new THREE.Mesh(
    new THREE.BoxGeometry(3.5, 0.08, length),
    new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.78 })
  );
  const pavement = new THREE.Mesh(
    new THREE.BoxGeometry(2.55, 0.11, length),
    new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.02 })
  );
  const marker = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.04, Math.min(2.4, Math.max(0.4, length * 0.35))),
    new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.4 })
  );

  const midpoint = from.clone().lerp(to, 0.5);
  const heading = vectorHeading(from, to);
  [shoulder, pavement].forEach((mesh) => {
    mesh.position.copy(midpoint);
    mesh.position.y = mesh === pavement ? 0.05 : 0;
    mesh.rotation.y = heading;
    mesh.receiveShadow = true;
    scene.add(mesh);
  });

  if (index % 2 === 0 && length > 1.2) {
    marker.position.copy(midpoint);
    marker.position.y = 0.13;
    marker.rotation.y = heading;
    scene.add(marker);
  }

  return pavement;
}

function addEventMarker(scene, projection, event, index) {
  const position = projection.project(event);
  if (!position) return;

  const color = colorForEvent(event);
  const severityScale = event.severity === 'high' || event.type === 'possible_crash' ? 1.5 : 1;
  const group = new THREE.Group();
  group.position.copy(position);
  group.position.y = 0.12;

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 1.65 * severityScale, 10),
    new THREE.MeshStandardMaterial({ color: '#475569', roughness: 0.72 })
  );
  pole.position.y = 0.82 * severityScale;
  group.add(pole);

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.26 * severityScale, 18, 18),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.35 })
  );
  marker.position.y = 1.68 * severityScale;
  marker.userData.label = titleCase(event.type || 'event');
  group.add(marker);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.34 * severityScale, 0.54 * severityScale, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 0.05;
  group.add(halo);

  group.userData.eventIndex = index;
  scene.add(group);
}

function addStopMarker(scene, projection, stop, index) {
  const position = projection.project(stop.point);
  if (!position) return;
  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 0.16, 28),
    new THREE.MeshStandardMaterial({ color: index % 2 ? '#64748b' : '#334155', roughness: 0.7 })
  );
  marker.position.copy(position);
  marker.position.y = 0.16;
  marker.receiveShadow = true;
  scene.add(marker);
}

export default function TripDrive3D({ trip, events = [], height = '430px', colorMode = 'speedBand' }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const carRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const elapsedRef = useRef(0);
  const playingRef = useRef(false);
  const followRef = useRef(true);
  const cameraModeRef = useRef('chase');
  const speedMultiplierRef = useRef(SPEEDS[0]);
  const lastUiUpdateRef = useRef(0);
  const renderLoggedRef = useRef('');
  const noRouteLoggedRef = useRef('');
  const completedLoggedRef = useRef('');
  const lastSeekLogRef = useRef(0);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [followVehicle, setFollowVehicle] = useState(true);
  const [cameraMode, setCameraMode] = useState('chase');
  const [qualityIdx, setQualityIdx] = useState(1);
  const [webglFailed, setWebglFailed] = useState(false);

  const settings = useLocalSettings();
  usePrivacyZonesRevision();
  const heightenedPrivacy = settings?.[HEIGHTENED_PRIVACY_MODE_KEY] === true;
  const privacySettings = useMemo(() => ({
    privacy_zones: settings.privacy_zones,
    show_privacy_circles: settings.show_privacy_circles,
  }), [settings.privacy_zones, settings.show_privacy_circles]);

  const points = useMemo(() => prepareMapRoutePoints(
    maskRoutePointsForPrivacy(trip?.route_points || [], privacySettings),
    { maxPoints: 720 }
  ).map(validLatLngPoint).filter(Boolean), [privacySettings, trip?.route_points]);

  const visibleEvents = useMemo(() => maskEventsForPrivacy(events, privacySettings)
    .map(validLatLngPoint)
    .filter(Boolean), [events, privacySettings]);

  const timeline = useMemo(() => buildPlaybackTimeline(points, visibleEvents), [points, visibleEvents]);
  const positionIndex = useMemo(() => buildPlaybackPositionIndex(points), [points]);
  const projection = useMemo(() => buildProjection(points), [points]);
  const durationSeconds = timeline.stats.durationSeconds || Math.max(1, points.length - 1);
  const playbackPosition = useMemo(
    () => playbackPositionAtElapsed(points, elapsedSeconds, positionIndex),
    [elapsedSeconds, points, positionIndex]
  );
  const currentDynamics = useMemo(
    () => dynamicsAtPlaybackPosition(timeline, playbackPosition),
    [playbackPosition, timeline]
  );
  const currentPoint = playbackPosition.point || points[0] || null;
  const currentDistanceKm = routeDistanceAtPlaybackPosition(timeline, playbackPosition, playbackPosition.index);
  const currentEvent = timeline.events.find((event) => (
    Math.abs((Number(event.offsetSeconds) || 0) - elapsedSeconds) <= 5
  ));
  const routeDistanceKm = Number(trip?.distance_km) > 0 ? Number(trip.distance_km) : timeline.stats.distanceKm;
  const progress = durationSeconds > 0 ? Math.max(0, Math.min(100, (elapsedSeconds / durationSeconds) * 100)) : 0;

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    speedMultiplierRef.current = SPEEDS[speedIdx];
  }, [speedIdx]);

  useEffect(() => {
    followRef.current = followVehicle;
  }, [followVehicle]);

  useEffect(() => {
    cameraModeRef.current = cameraMode;
    followRef.current = cameraMode !== 'free';
    setFollowVehicle(cameraMode !== 'free');
  }, [cameraMode]);

  useEffect(() => {
    elapsedRef.current = elapsedSeconds;
  }, [elapsedSeconds]);

  useEffect(() => {
    elapsedRef.current = 0;
    setElapsedSeconds(0);
    setPlaying(false);
    setFollowVehicle(true);
    setCameraMode('chase');
    setWebglFailed(false);
    completedLoggedRef.current = '';
  }, [trip?.id]);

  useEffect(() => {
    if (points.length || !trip?.id) return;
    const key = String(trip.id);
    if (noRouteLoggedRef.current === key) return;
    noRouteLoggedRef.current = key;
    recordSystemEvent('trip_3d_playback_unavailable', {
      trip_id: trip.id,
      reason: 'no_route_points',
      saved_route_point_count: Array.isArray(trip?.route_points) ? trip.route_points.length : 0,
    }, {
      category: 'diagnostics',
      title: '3D drive unavailable',
    });
  }, [points.length, trip?.id, trip?.route_points]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || !projection || points.length < 2) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (error) {
      console.error('3D trip renderer failed to initialize', error);
      logSystemFailure('trip_3d_webgl_initialize', error, {
        trip_id: trip?.id,
        point_count: points.length,
        event_count: timeline.events.length,
      });
      setWebglFailed(true);
      return undefined;
    }

    rendererRef.current = renderer;
    const quality = RENDER_QUALITIES[qualityIdx] || RENDER_QUALITIES[1];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0f172a');
    scene.fog = new THREE.Fog('#0f172a', 42, 155);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 320);
    const span = Math.max(28, projection.span);
    camera.position.set(0, Math.min(42, span * 0.48), Math.max(30, span * 0.68));

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = 8;
    controls.maxDistance = Math.max(44, span * 1.8);
    controls.target.set(0, 0, 0);
    controls.update();
    controlsRef.current = controls;

    const renderLogKey = `${trip?.id || 'trip'}:${colorMode}:${points.length}:${timeline.events.length}`;
    if (renderLoggedRef.current !== renderLogKey) {
      renderLoggedRef.current = renderLogKey;
      recordSystemEvent('trip_3d_playback_loaded', {
        trip_id: trip?.id || null,
        point_count: points.length,
        event_count: timeline.events.length,
        stop_count: timeline.stops.length,
        duration_seconds: durationSeconds,
        color_mode: colorMode,
      }, {
        category: 'diagnostics',
        title: '3D drive loaded',
      });
    }

    scene.add(new THREE.HemisphereLight('#dbeafe', '#172554', 1.8));
    const sun = new THREE.DirectionalLight('#ffffff', 2.1);
    sun.position.set(-18, 26, 22);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 1024;
    sun.shadow.mapSize.height = 1024;
    scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(90, span * 2.2), Math.max(90, span * 2.2), 1, 1),
      new THREE.MeshStandardMaterial({ color: '#172033', roughness: 0.9, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(Math.max(90, span * 2), 32, '#334155', '#1e293b');
    grid.position.y = 0.01;
    scene.add(grid);

    addSmoothRouteGuide(scene, projection, points);
    let lastSignLimit = null;
    let lastSignIndex = -Infinity;
    timeline.segments.forEach((segment, index) => {
      const from = projection.project(segment.from);
      const to = projection.project(segment.to);
      if (!from || !to) return;
      const color = colorMode === 'speedLimit' && segment.speedLimitColor
        ? segment.speedLimitColor
        : segment.color || '#3b82f6';
      addRoadSegment(scene, from, to, color, index);
      const limit = Number(segment.speedLimitKmh);
      if (
        Number.isFinite(limit) &&
        limit > 0 &&
        (lastSignLimit !== Math.round(limit) || index - lastSignIndex > 18)
      ) {
        addSpeedLimitSign(scene, from, to, limit, index);
        lastSignLimit = Math.round(limit);
        lastSignIndex = index;
      }
    });

    timeline.stops.forEach((stop, index) => addStopMarker(scene, projection, stop, index));
    timeline.events.slice(0, 120).forEach((event, index) => addEventMarker(scene, projection, event, index));

    const car = createCarModel();
    carRef.current = car;
    scene.add(car);

    const handleContextLost = (event) => {
      event.preventDefault?.();
      logSystemFailure('trip_3d_webgl_context_lost', new Error('WebGL context lost'), {
        trip_id: trip?.id,
        elapsed_seconds: Math.round(elapsedRef.current),
      });
      setWebglFailed(true);
    };
    const handleContextRestored = () => {
      recordSystemEvent('trip_3d_webgl_context_restored', {
        trip_id: trip?.id || null,
      }, {
        category: 'diagnostics',
        severity: 'warn',
        title: '3D drive WebGL restored',
      });
    };
    canvas.addEventListener('webglcontextlost', handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

    const resize = () => {
      const { width, height: measuredHeight } = container.getBoundingClientRect();
      const safeWidth = Math.max(1, width);
      const safeHeight = Math.max(1, measuredHeight);
      renderer.setSize(safeWidth, safeHeight, false);
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    const updateCar = (delta = 0) => {
      const position = playbackPositionAtElapsed(points, elapsedRef.current, positionIndex);
      const scenePoint = projection.project(position.point);
      const from = projection.project(points[position.fromIndex]);
      const to = projection.project(points[position.toIndex]);
      if (!scenePoint || !from || !to) return;

      const heading = vectorHeading(from, to);
      const dynamics = dynamicsAtPlaybackPosition(timeline, position);
      car.position.copy(scenePoint);
      car.position.y = 0.24 + Math.sin(performance.now() * 0.008) * 0.015;
      car.rotation.y = heading;
      const speed = Number(position.point?.speed_kmh) || 0;
      const turnBank = Math.max(-0.2, Math.min(0.2, -dynamics.turnDeltaDegrees / 180));
      const brakePitch = dynamics.braking ? -0.12 * Math.max(0.25, dynamics.intensity) : 0;
      const accelPitch = dynamics.accelerating ? 0.08 * Math.max(0.2, dynamics.intensity) : 0;
      car.rotation.x = brakePitch + accelPitch;
      car.rotation.z = turnBank + Math.sin(performance.now() * 0.006) * Math.min(0.04, speed / 1800);
      car.traverse((child) => {
        if (child.userData?.isWheel) child.rotation.x -= Math.max(0.02, speed / 55) * delta * 12;
        if (child.userData?.isBrakeLight && child.material) {
          const active = dynamics.braking || dynamics.overLimitKmh > 15;
          child.material.color.set(active ? '#ef4444' : '#7f1d1d');
          child.material.emissive.set(active ? '#ef4444' : '#450a0a');
          child.material.emissiveIntensity = active ? 1.9 : 0.12;
        }
      });

      if (followRef.current) {
        const mode = cameraModeRef.current;
        const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
        const right = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
        const cameraTarget = scenePoint.clone().add(new THREE.Vector3(0, 1.2, 0));
        const activeEvent = timeline.events.find((event) => (
          Math.abs((Number(event.offsetSeconds) || 0) - elapsedRef.current) <= 8
        ));
        const eventPoint = activeEvent ? projection.project(activeEvent) : null;
        const desiredTarget = mode === 'event' && eventPoint
          ? eventPoint.clone().add(new THREE.Vector3(0, 1.4, 0))
          : cameraTarget;
        const desiredCamera = mode === 'top'
          ? cameraTarget.clone().add(new THREE.Vector3(0, Math.max(24, projection.span * 0.62), 0.1))
          : mode === 'side'
            ? cameraTarget.clone().add(right.multiplyScalar(12)).add(new THREE.Vector3(0, 5.2, 0))
            : mode === 'event' && eventPoint
              ? cameraTarget.clone().add(forward.clone().multiplyScalar(-8)).add(right.multiplyScalar(7)).add(new THREE.Vector3(0, 6.5, 0))
              : cameraTarget.clone()
                .add(forward.clone().multiplyScalar(-10.5))
                .add(new THREE.Vector3(0, 5.6, 0));
        camera.position.lerp(desiredCamera, 0.075);
        controls.target.lerp(desiredTarget, 0.12);
      }
    };

    const clock = new THREE.Clock();
    let frameId = 0;
    const animate = () => {
      const delta = Math.min(0.08, clock.getDelta());
      if (playingRef.current) {
        const nextElapsed = Math.min(durationSeconds, elapsedRef.current + delta * speedMultiplierRef.current);
        elapsedRef.current = nextElapsed;
        if (nextElapsed >= durationSeconds) {
          playingRef.current = false;
          setPlaying(false);
          const completeKey = `${trip?.id || 'trip'}:${durationSeconds}`;
          if (completedLoggedRef.current !== completeKey) {
            completedLoggedRef.current = completeKey;
            recordSystemEvent('trip_3d_playback_completed', {
              trip_id: trip?.id || null,
              duration_seconds: durationSeconds,
              speed_multiplier: speedMultiplierRef.current,
            }, {
              category: 'diagnostics',
              title: '3D drive completed',
            });
          }
        }
        const now = performance.now();
        if (now - lastUiUpdateRef.current > 110) {
          lastUiUpdateRef.current = now;
          setElapsedSeconds(nextElapsed);
        }
      }
      updateCar(delta);
      controls.update();
      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      canvas.removeEventListener('webglcontextlost', handleContextLost, false);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored, false);
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      carRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
    };
  }, [colorMode, durationSeconds, points, positionIndex, projection, qualityIdx, timeline, trip?.id]);

  const seekToElapsed = (seconds, { log = true } = {}) => {
    const safeElapsed = Math.max(0, Math.min(durationSeconds, seconds));
    elapsedRef.current = safeElapsed;
    setElapsedSeconds(safeElapsed);
    setPlaying(false);
    if (log) {
      const now = Date.now();
      if (now - lastSeekLogRef.current > 2500) {
        lastSeekLogRef.current = now;
        recordSystemEvent('trip_3d_playback_seeked', {
          trip_id: trip?.id || null,
          elapsed_seconds: Math.round(safeElapsed),
          duration_seconds: durationSeconds,
        }, {
          category: 'user_action',
          title: '3D drive seeked',
        });
      }
    }
  };

  const resetPlayback = () => {
    seekToElapsed(0);
    setCameraMode('chase');
    recordSystemEvent('trip_3d_playback_restarted', {
      trip_id: trip?.id || null,
      duration_seconds: durationSeconds,
    }, {
      category: 'user_action',
      title: '3D drive restarted',
    });
  };

  const togglePlayback = () => {
    setPlaying((value) => {
      const next = !value;
      recordSystemEvent(next ? 'trip_3d_playback_started' : 'trip_3d_playback_paused', {
        trip_id: trip?.id || null,
        elapsed_seconds: Math.round(elapsedRef.current),
        duration_seconds: durationSeconds,
        speed_multiplier: SPEEDS[speedIdx],
      }, {
        category: 'user_action',
        title: next ? '3D drive started' : '3D drive paused',
      });
      return next;
    });
  };

  const cycleSpeed = () => {
    setSpeedIdx((value) => {
      const next = (value + 1) % SPEEDS.length;
      recordSystemEvent('trip_3d_playback_speed_changed', {
        trip_id: trip?.id || null,
        speed_multiplier: SPEEDS[next],
      }, {
        category: 'user_action',
        title: '3D drive speed changed',
      });
      return next;
    });
  };

  const cycleQuality = () => {
    setQualityIdx((value) => {
      const next = (value + 1) % RENDER_QUALITIES.length;
      recordSystemEvent('trip_3d_quality_changed', {
        trip_id: trip?.id || null,
        render_quality: RENDER_QUALITIES[next].id,
      }, {
        category: 'user_action',
        title: '3D drive quality changed',
      });
      return next;
    });
  };

  const toggleFollow = () => {
    setCameraMode((mode) => {
      const next = mode === 'free' ? 'chase' : 'free';
      recordSystemEvent('trip_3d_camera_follow_changed', {
        trip_id: trip?.id || null,
        follow_vehicle: next !== 'free',
        camera_mode: next,
      }, {
        category: 'user_action',
        title: '3D drive camera changed',
      });
      return next;
    });
  };

  const resetCamera = () => {
    setCameraMode('free');
    controlsRef.current?.reset?.();
    recordSystemEvent('trip_3d_camera_reset', {
      trip_id: trip?.id || null,
    }, {
      category: 'user_action',
      title: '3D drive camera reset',
    });
  };

  const setCameraModeWithLog = (mode) => {
    setCameraMode(mode);
    recordSystemEvent('trip_3d_camera_mode_changed', {
      trip_id: trip?.id || null,
      camera_mode: mode,
    }, {
      category: 'user_action',
      title: '3D drive camera mode changed',
    });
  };

  const jumpToEvent = (event) => {
    const elapsed = Math.max(0, Number(event.offsetSeconds) || 0);
    seekToElapsed(elapsed, { log: false });
    setCameraMode('event');
    recordSystemEvent('trip_3d_event_selected', {
      trip_id: trip?.id || null,
      event_type: event.type || 'event',
      elapsed_seconds: Math.round(elapsed),
    }, {
      category: 'user_action',
      title: '3D drive event selected',
    });
  };

  if (!points.length || !projection) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-border bg-secondary/30 px-6 text-center text-sm text-muted-foreground" style={{ height }}>
        3D drive animation needs saved route coordinates for this trip.
      </div>
    );
  }

  if (webglFailed) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-border bg-secondary/30 px-6 text-center text-sm text-muted-foreground" style={{ height }}>
        3D drive animation is unavailable because WebGL could not start on this device.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        ref={containerRef}
        className="relative overflow-hidden rounded-2xl border border-border bg-slate-950 shadow-sm"
        style={{ height }}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />

        <div className="pointer-events-none absolute inset-x-2 top-2 grid grid-cols-4 gap-1.5 sm:inset-x-3 sm:top-3 sm:gap-2">
          <div className="min-w-0 rounded-lg border border-white/10 bg-slate-950/78 px-2 py-1.5 text-white shadow backdrop-blur sm:rounded-xl sm:px-3 sm:py-2">
            <div className="flex min-w-0 items-center gap-1 text-[8px] font-semibold uppercase tracking-normal text-slate-300 sm:text-[10px]">
              <Gauge className="h-3 w-3" /> Speed
            </div>
            <div className="truncate font-grotesk text-sm font-bold sm:text-lg">{formatSpeed(Number(currentPoint?.speed_kmh) || 0)}</div>
          </div>
          <div className="min-w-0 rounded-lg border border-white/10 bg-slate-950/78 px-2 py-1.5 text-white shadow backdrop-blur sm:rounded-xl sm:px-3 sm:py-2">
            <div className="flex min-w-0 items-center gap-1 text-[8px] font-semibold uppercase tracking-normal text-slate-300 sm:text-[10px]">
              <Route className="h-3 w-3" /> Traveled
            </div>
            <div className="truncate font-grotesk text-sm font-bold sm:text-lg">{formatDistance(currentDistanceKm)}</div>
          </div>
          <div className="min-w-0 rounded-lg border border-white/10 bg-slate-950/78 px-2 py-1.5 text-white shadow backdrop-blur sm:rounded-xl sm:px-3 sm:py-2">
            <div className="flex min-w-0 items-center gap-1 text-[8px] font-semibold uppercase tracking-normal text-slate-300 sm:text-[10px]">
              <Zap className="h-3 w-3" /> Motion
            </div>
            <div className="truncate font-grotesk text-sm font-bold sm:text-lg">
              {currentDynamics.braking
                ? 'Braking'
                : currentDynamics.accelerating
                  ? 'Accel'
                  : Math.abs(currentDynamics.turnDeltaDegrees) > 12
                    ? 'Corner'
                : 'Cruise'}
            </div>
          </div>
          <div className="min-w-0 rounded-lg border border-white/10 bg-slate-950/78 px-2 py-1.5 text-white shadow backdrop-blur sm:rounded-xl sm:px-3 sm:py-2">
            <div className="flex min-w-0 items-center gap-1 text-[8px] font-semibold uppercase tracking-normal text-slate-300 sm:text-[10px]">
              <Camera className="h-3 w-3" /> Camera
            </div>
            <div className="truncate font-grotesk text-sm font-bold sm:text-lg">
              {CAMERA_MODES.find((mode) => mode.id === cameraMode)?.label || 'Chase'}
            </div>
          </div>
        </div>

        {currentEvent && (
          <div className="pointer-events-none absolute bottom-3 left-2 right-2 rounded-xl border border-white/10 bg-slate-950/85 px-3 py-2 text-xs font-medium text-white shadow backdrop-blur sm:left-3 sm:right-auto sm:w-[min(24rem,calc(100%-1.5rem))]">
            <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorForEvent(currentEvent) }} />
            {titleCase(currentEvent.type)} at {formatDuration(Math.round(elapsedSeconds))}
          </div>
        )}

        {heightenedPrivacy && (
          <div className="pointer-events-none absolute right-3 top-[7.25rem] max-w-[min(20rem,calc(100%-1.5rem))] rounded-xl border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs font-semibold text-amber-950 shadow">
            Heightened privacy is masking protected route areas before 3D rendering.
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-slate-950 p-2 text-white shadow-sm sm:p-3">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={resetPlayback}
              title="Restart 3D drive"
              aria-label="Restart 3D drive"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/15"
            >
              <SkipBack className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={togglePlayback}
              className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 sm:px-4"
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              onClick={cycleSpeed}
              className="inline-flex items-center gap-1 rounded-xl bg-white/10 px-2.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/15 sm:gap-1.5 sm:px-3"
            >
              <Gauge className="h-3.5 w-3.5" />
              {SPEEDS[speedIdx]}x
            </button>
            <button
              type="button"
              onClick={cycleQuality}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/15"
              title="Change 3D render quality"
            >
              <Zap className="h-3.5 w-3.5" />
              {RENDER_QUALITIES[qualityIdx]?.label || 'Med'}
            </button>
            <button
              type="button"
              onClick={toggleFollow}
              className={`inline-flex items-center gap-1 rounded-xl px-2.5 py-2 text-xs font-semibold transition-colors sm:gap-1.5 sm:px-3 ${
                cameraMode !== 'free' ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white hover:bg-white/15'
              }`}
            >
              <LocateFixed className="h-3.5 w-3.5" />
              {cameraMode === 'free' ? 'Follow' : 'Free'}
            </button>
            <button
              type="button"
              onClick={resetCamera}
              title="Reset camera"
              aria-label="Reset camera"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/15"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <div className="ml-auto text-xs text-slate-300">
              {formatDuration(Math.round(elapsedSeconds))} / {formatDuration(durationSeconds)} - {formatDistance(routeDistanceKm)}
            </div>
        </div>
        <div className="mt-2 sm:mt-3">
            <input
              type="range"
              min="0"
              max={durationSeconds}
              step="1"
              value={Math.round(elapsedSeconds)}
              onChange={(event) => seekToElapsed(Number(event.target.value))}
              aria-label="3D drive playback position"
              className="w-full accent-blue-500"
            />
            <div className="mt-1.5 flex gap-1 overflow-x-auto thin-scrollbar sm:mb-2 sm:mt-0">
              {CAMERA_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setCameraModeWithLog(mode.id)}
                  className={`shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    cameraMode === mode.id
                      ? 'bg-white text-slate-950'
                      : 'bg-white/10 text-white hover:bg-white/15'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <div className="mt-1 flex items-center gap-2 overflow-x-auto text-[10px] text-slate-300 thin-scrollbar">
              {SPEED_BANDS.map((band) => (
                <span key={band.id} className="inline-flex shrink-0 items-center gap-1">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: band.color }} />
                  {band.label}
                </span>
              ))}
              <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5">
                {currentDynamics.accelerationKmhPerSecond >= 0 ? '+' : ''}{currentDynamics.accelerationKmhPerSecond.toFixed(1)} km/h/s
              </span>
              {currentDynamics.overLimitKmh > 0 && (
                <span className="shrink-0 rounded-full bg-red-500/25 px-2 py-0.5 text-red-100">
                  {Math.round(currentDynamics.overLimitKmh)} over
                </span>
              )}
              <span className="ml-auto shrink-0">{Math.round(progress)}%</span>
            </div>
            {timeline.events.length > 0 && (
              <div className="mt-2 flex gap-1 overflow-x-auto text-[11px] thin-scrollbar">
                {timeline.events.slice(0, 10).map((event, index) => (
                  <button
                    key={`${event.type || 'event'}-${event.offsetSeconds}-${index}`}
                    type="button"
                    onClick={() => jumpToEvent(event)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-1 font-semibold text-white transition-colors hover:bg-white/15"
                    title={`Jump to ${titleCase(event.type || 'event')}`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorForEvent(event) }} />
                    <Flag className="h-3 w-3" />
                    {titleCase(event.type || 'event')} {formatDuration(Math.round(event.offsetSeconds || 0))}
                  </button>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
