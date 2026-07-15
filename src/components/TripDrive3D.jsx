// @ts-check
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  Activity,
  Camera,
  Film,
  Flag,
  Gauge,
  LocateFixed,
  Maximize2,
  Minimize2,
  Mountain,
  Pause,
  Play,
  RotateCcw,
  Route,
  SkipBack,
  Sparkles,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import {
  SPEED_BANDS,
  advancePlaybackElapsed,
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
import usePlaybackScreenAwake from '@/hooks/usePlaybackScreenAwake';

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
const IDLE_SPEED_KMH = 5;
const ROAD_WIDTH = 3.25;
const ROAD_SHOULDER_WIDTH = 4.35;
const ROAD_EDGE_OFFSET = ROAD_WIDTH * 0.48;
const CAMERA_LOOKAHEAD_SECONDS = 2.2;
const CAMERA_BASE_FOV = 48;
const BASE_REPLAY_SPEED_KMH = 45;
const MIN_REPLAY_SECONDS = 45;
const MAX_REPLAY_SECONDS = 150;
const MAX_BASE_REPLAY_RATE = 12;
const SPEED_TRAIL_MIN_KMH = 32;
const SPEED_TRAIL_FULL_KMH = 95;
const CAMERA_MODES = [
  { id: 'cinematic', label: 'Cinema' },
  { id: 'chase', label: 'Chase' },
  { id: 'hood', label: 'Hood' },
  { id: 'top', label: 'Top' },
  { id: 'side', label: 'Side' },
  { id: 'event', label: 'Event' },
  { id: 'free', label: 'Free' },
];
const RENDER_QUALITIES = [
  { id: 'auto', label: 'Auto', pixelRatio: 1.2, shadows: true, shadowSize: 1024, environmentCount: 70, maxEvents: 80 },
  { id: 'low', label: 'Low', pixelRatio: 0.8, shadows: false, shadowSize: 512, environmentCount: 24, maxEvents: 36 },
  { id: 'medium', label: 'Med', pixelRatio: 1.2, shadows: true, shadowSize: 1024, environmentCount: 70, maxEvents: 80 },
  { id: 'high', label: 'High', pixelRatio: 1.8, shadows: true, shadowSize: 2048, environmentCount: 120, maxEvents: 120 },
];
const GAP_TRANSITION_SECONDS = 0.8;
const ROUTE_VISUAL_MODES = [
  { id: 'speedBand', label: 'Speed' },
  { id: 'speedLimit', label: 'Limits' },
  { id: 'dynamics', label: 'Dynamics' },
  { id: 'confidence', label: 'GPS' },
];
const STREAM_DISTANCE_SCENE_UNITS = 68;
const SCENE_THEMES = [
  {
    id: 'night', label: 'Night', background: '#081426', fog: '#0c1b2f',
    skyTop: '#020817', skyHorizon: '#1d3f61', skyGround: '#081426',
    ground: '#102033', hemisphereSky: '#b9d9ff', hemisphereGround: '#10294a',
    hemisphereIntensity: 1.45, sun: '#dcecff', sunIntensity: 1.65,
  },
  {
    id: 'dusk', label: 'Dusk', background: '#1e293b', fog: '#26364d',
    skyTop: '#172554', skyHorizon: '#c56a55', skyGround: '#172033',
    ground: '#243142', hemisphereSky: '#ffe4cf', hemisphereGround: '#253858',
    hemisphereIntensity: 1.8, sun: '#ffd0a8', sunIntensity: 2,
  },
  {
    id: 'day', label: 'Day', background: '#8cc8ee', fog: '#9fcbe3',
    skyTop: '#2f83c6', skyHorizon: '#d7efff', skyGround: '#7fa5aa',
    ground: '#385c52', hemisphereSky: '#ffffff', hemisphereGround: '#315e52',
    hemisphereIntensity: 2, sun: '#fff5dc', sunIntensity: 2.35,
  },
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

const chapterKey = (chapter) => `${chapter.kind}:${Math.round(chapter.offsetSeconds || 0)}:${chapter.label}`;

function buildProjection(points = []) {
  const valid = points.map(validLatLngPoint).filter(Boolean);
  if (!valid.length) return null;
  const reliableAltitudes = valid
    .filter((point) => {
      const altitude = finiteCoordinate(point.altitude ?? point.altitude_m);
      const accuracy = finiteCoordinate(point.altitude_accuracy ?? point.altitudeAccuracy);
      return altitude != null && (accuracy == null || accuracy <= 40);
    })
    .map((point) => finiteCoordinate(point.altitude ?? point.altitude_m))
    .sort((a, b) => a - b);
  const altitudeCoverage = valid.length ? reliableAltitudes.length / valid.length : 0;
  const useElevation = reliableAltitudes.length >= 3 && altitudeCoverage >= 0.45;

  const groups = [];
  let active = [];
  valid.forEach((point, index) => {
    if (index > 0 && (point.tracking_gap === true || point.route_gap === true)) {
      if (active.length) groups.push(active);
      active = [];
    }
    active.push(point);
  });
  if (active.length) groups.push(active);

  const rawByKey = new Map();
  const keyForPoint = (point) => `${point?.lat}:${point?.lng}:${point?.timestamp || point?.time || ''}`;
  let packedCursorX = 0;
  const packedGapMeters = 18;
  groups.forEach((group) => {
    const centerLat = group.reduce((sum, point) => sum + point.lat, 0) / group.length;
    const origin = group[0];
    const lngMeters = LAT_METERS * Math.max(0.2, Math.cos(centerLat * Math.PI / 180));
    const raw = group.map((point) => ({
      point,
      x: (point.lng - origin.lng) * lngMeters,
      z: -(point.lat - origin.lat) * LAT_METERS,
      // Phone altitude is retained for telemetry/profile display, but it is not
      // stable enough to deform the road without a matching terrain surface.
      y: 0,
    }));
    const minX = Math.min(...raw.map((item) => item.x));
    const maxX = Math.max(...raw.map((item) => item.x));
    const groupWidth = Math.max(2, maxX - minX);
    raw.forEach((item) => {
      rawByKey.set(keyForPoint(item.point), {
        x: item.x - minX + packedCursorX,
        z: item.z,
        y: item.y,
      });
    });
    packedCursorX += groupWidth + packedGapMeters;
  });

  const packed = [...rawByKey.values()];
  const minX = Math.min(...packed.map((point) => point.x));
  const maxX = Math.max(...packed.map((point) => point.x));
  const minZ = Math.min(...packed.map((point) => point.z));
  const maxZ = Math.max(...packed.map((point) => point.z));
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const spanMeters = Math.max(24, maxX - minX, maxZ - minZ);
  const sceneScale = Math.min(1.1, MAX_SCENE_SPAN / spanMeters);
  const objectScale = Math.max(0.4, Math.min(1.15, 0.4 + sceneScale * 0.6));

  const project = (point) => {
    const lat = finiteCoordinate(point?.lat);
    const lng = finiteCoordinate(point?.lng);
    if (lat == null || lng == null) return null;
    const packedPoint = rawByKey.get(keyForPoint(point));
    if (!packedPoint) return null;
    return new THREE.Vector3(
      (packedPoint.x - centerX) * sceneScale,
      packedPoint.y * sceneScale,
      (packedPoint.z - centerZ) * sceneScale
    );
  };

  return {
    project,
    scale: sceneScale,
    objectScale,
    span: spanMeters * sceneScale,
    elevation: {
      available: useElevation,
      coverage: altitudeCoverage,
      minMeters: reliableAltitudes[0] ?? null,
      maxMeters: reliableAltitudes.at(-1) ?? null,
    },
  };
}

function vectorHeading(from, to) {
  if (!from || !to) return 0;
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function angleDeltaRadians(from = 0, to = 0) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function lerpAngleRadians(from = 0, to = 0, alpha = 1) {
  return from + angleDeltaRadians(from, to) * Math.max(0, Math.min(1, alpha));
}

function dampAlpha(speed = 8, delta = 0.016) {
  return 1 - Math.exp(-Math.max(0, speed) * Math.max(0, delta));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function angleDeltaDegrees(from = 0, to = 0) {
  let delta = ((to - from + 540) % 360) - 180;
  if (!Number.isFinite(delta)) delta = 0;
  return delta;
}

function segmentForPlaybackPosition(timeline = {}, position = {}) {
  const segments = Array.isArray(timeline.segments) ? timeline.segments : [];
  return segments.find((item) => (
    item.fromIndex === position.fromIndex && item.toIndex === position.toIndex
  )) || segments.find((item) => item.toIndex >= position.toIndex) || null;
}

function speedKmhAtPlaybackPosition(timeline = {}, position = {}) {
  const segment = segmentForPlaybackPosition(timeline, position);
  const segmentSpeed = Number(segment?.speedKmh);
  const reportedSpeed = Number(position.point?.speed_kmh);

  if (!Number.isFinite(reportedSpeed)) {
    return Number.isFinite(segmentSpeed) ? Math.max(0, segmentSpeed) : 0;
  }

  if (reportedSpeed <= IDLE_SPEED_KMH && Number.isFinite(segmentSpeed) && segmentSpeed >= SPEED_BANDS[1].min) {
    return Math.max(0, segmentSpeed);
  }

  return Math.max(0, reportedSpeed);
}

function speedEffectStrength(speedKmh = 0) {
  const speed = Math.max(0, Number(speedKmh) || 0);
  return clampNumber((speed - SPEED_TRAIL_MIN_KMH) / (SPEED_TRAIL_FULL_KMH - SPEED_TRAIL_MIN_KMH), 0, 1);
}

function dynamicsAtPlaybackPosition(timeline = {}, position = {}) {
  const segments = Array.isArray(timeline.segments) ? timeline.segments : [];
  const segment = segmentForPlaybackPosition(timeline, position);
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
  const currentSpeed = speedKmhAtPlaybackPosition(timeline, position);
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
    materials.filter(Boolean).forEach((material) => {
      material.map?.dispose?.();
      material.dispose?.();
    });
  });
}

function offsetPolyline(points = [], offset = 0) {
  if (!points.length || Math.abs(offset) < 0.001) return points.map((point) => point.clone());
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const heading = vectorHeading(previous, next);
    const right = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)).multiplyScalar(offset);
    return point.clone().add(right);
  });
}

function addRouteRibbon(scene, centerPoints = [], {
  width,
  y,
  color,
  opacity = 1,
  roughness = 0.72,
  metalness = 0.02,
}) {
  if (centerPoints.length < 2) return null;

  const vertices = [];
  const indices = [];
  centerPoints.forEach((point, index) => {
    const previous = centerPoints[Math.max(0, index - 1)];
    const next = centerPoints[Math.min(centerPoints.length - 1, index + 1)];
    const heading = vectorHeading(previous, next);
    const right = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)).multiplyScalar(width / 2);
    const leftPoint = point.clone().sub(right);
    const rightPoint = point.clone().add(right);
    vertices.push(leftPoint.x, leftPoint.y + y, leftPoint.z, rightPoint.x, rightPoint.y + y, rightPoint.z);
    if (index > 0) {
      const base = index * 2;
      indices.push(base - 2, base - 1, base, base - 1, base + 1, base);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function projectedRoadGroups(segments = [], projection) {
  const groups = [];
  let active = [];
  segments.forEach((segment) => {
    const from = projection.project(segment.from);
    const to = projection.project(segment.to);
    if (!from || !to) return;
    const projected = { segment, from, to };
    const previous = active.at(-1);
    if (previous && previous.segment.toIndex !== segment.fromIndex) {
      groups.push(active);
      active = [];
    }
    active.push(projected);
  });
  if (active.length) groups.push(active);
  return groups;
}

function buildRoadModels(segments = [], projection) {
  return projectedRoadGroups(segments, projection).map((group) => {
    const rawPoints = [group[0].from, ...group.map((item) => item.to)];
    const length = rawPoints.reduce((sum, point, index) => (
      index === 0 ? 0 : sum + point.distanceTo(rawPoints[index - 1])
    ), 0);
    const sampleCount = Math.ceil(Math.max(group.length * 2.4, length * 1.35));
    const curve = rawPoints.length > 2
      ? new THREE.CatmullRomCurve3(rawPoints, false, 'centripetal', 0.35)
      : new THREE.LineCurve3(rawPoints[0], rawPoints.at(-1));
    const centerline = curve.getPoints(Math.max(2, Math.min(1100, sampleCount)));
    return {
      group,
      curve,
      centerline,
      startIndex: group[0].segment.fromIndex,
      endIndex: group.at(-1).segment.toIndex,
      renderGroup: null,
    };
  });
}

function roadPoseForPlayback(models = [], position = {}) {
  if (position?.isGap) return null;
  const model = models.find((item) => (
    position.fromIndex >= item.startIndex && position.toIndex <= item.endIndex
  ));
  if (!model) return null;
  const denominator = Math.max(1, model.endIndex - model.startIndex);
  const localProgress = (
    (position.fromIndex - model.startIndex) + clampNumber(position.ratio, 0, 1)
  ) / denominator;
  const t = clampNumber(localProgress, 0, 1);
  const point = model.curve.getPoint(t);
  const tangent = model.curve.getTangent(clampNumber(t, 0.0001, 0.9999)).normalize();
  return {
    model,
    point,
    tangent,
    heading: Math.atan2(tangent.x, tangent.z),
    t,
  };
}

function addColoredRouteRibbon(scene, model, colorMode, width, y) {
  const centerPoints = model.centerline;
  if (centerPoints.length < 2) return null;
  const vertices = [];
  const colors = [];
  const indices = [];
  centerPoints.forEach((point, index) => {
    const previous = centerPoints[Math.max(0, index - 1)];
    const next = centerPoints[Math.min(centerPoints.length - 1, index + 1)];
    const heading = vectorHeading(previous, next);
    const right = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)).multiplyScalar(width / 2);
    const leftPoint = point.clone().sub(right);
    const rightPoint = point.clone().add(right);
    vertices.push(leftPoint.x, leftPoint.y + y, leftPoint.z, rightPoint.x, rightPoint.y + y, rightPoint.z);
    const segmentProgress = index / Math.max(1, centerPoints.length - 1);
    const segmentIndex = Math.min(model.group.length - 1, Math.floor(segmentProgress * model.group.length));
    const segment = model.group[segmentIndex]?.segment;
    const previousSegment = model.group[Math.max(0, segmentIndex - 1)]?.segment;
    const acceleration = previousSegment
      ? (Number(segment?.speedKmh) || 0) - (Number(previousSegment.speedKmh) || 0)
      : 0;
    const accuracy = Number(segment?.to?.accuracy ?? segment?.from?.accuracy);
    const colorValue = colorMode === 'speedLimit' && segment?.speedLimitColor
      ? segment.speedLimitColor
      : colorMode === 'dynamics'
        ? acceleration <= -7
          ? '#ef4444'
          : acceleration >= 7
            ? '#f59e0b'
            : Math.abs(Number(segment?.heading) - Number(previousSegment?.heading)) > 18
              ? '#8b5cf6'
              : '#22c55e'
        : colorMode === 'confidence'
          ? !Number.isFinite(accuracy)
            ? '#64748b'
            : accuracy <= 12
              ? '#22c55e'
              : accuracy <= 30
                ? '#f59e0b'
                : '#ef4444'
          : segment?.color || '#3b82f6';
    const color = new THREE.Color(colorValue);
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    if (index > 0) {
      const base = index * 2;
      indices.push(base - 2, base - 1, base, base - 1, base + 1, base);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.02,
    transparent: true,
    opacity: 0.62,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function addDashedCenterline(scene, points = [], y = 0.16) {
  if (points.length < 2) return null;
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map((point) => (
    new THREE.Vector3(point.x, point.y + y, point.z)
  )));
  const material = new THREE.LineDashedMaterial({
    color: '#f8fafc',
    dashSize: 0.72,
    gapSize: 0.58,
    transparent: true,
    opacity: 0.82,
  });
  const line = new THREE.Line(geometry, material);
  line.computeLineDistances();
  scene.add(line);
  return line;
}

function addCurvedRoad(scene, models = [], colorMode, objectScale = 1) {
  const scale = Math.max(0.01, Number(objectScale) || 1);
  const roadWidth = ROAD_WIDTH * scale;
  const roadShoulderWidth = ROAD_SHOULDER_WIDTH * scale;
  const roadEdgeOffset = ROAD_EDGE_OFFSET * scale;

  models.forEach((model) => {
    const routeGroup = new THREE.Group();
    routeGroup.userData.isStreamedRouteGroup = true;
    routeGroup.userData.streamCenter = new THREE.Box3()
      .setFromPoints(model.centerline)
      .getCenter(new THREE.Vector3());
    model.renderGroup = routeGroup;
    scene.add(routeGroup);
    addRouteRibbon(routeGroup, model.centerline, {
      width: roadShoulderWidth * 3.8,
      y: -0.035 * scale,
      color: '#142d2a',
      roughness: 0.96,
    });
    addRouteRibbon(routeGroup, model.centerline, {
      width: roadShoulderWidth,
      y: 0.025 * scale,
      color: '#111827',
      roughness: 0.82,
    });
    addRouteRibbon(routeGroup, model.centerline, {
      width: roadWidth,
      y: 0.09 * scale,
      color: '#273449',
      roughness: 0.72,
    });
    addRouteRibbon(routeGroup, offsetPolyline(model.centerline, -roadEdgeOffset), {
      width: 0.055 * scale,
      y: 0.15 * scale,
      color: '#cbd5e1',
      opacity: 0.62,
      roughness: 0.42,
    });
    addRouteRibbon(routeGroup, offsetPolyline(model.centerline, roadEdgeOffset), {
      width: 0.055 * scale,
      y: 0.15 * scale,
      color: '#cbd5e1',
      opacity: 0.62,
      roughness: 0.42,
    });
    addColoredRouteRibbon(routeGroup, model, colorMode, roadWidth * 0.84, 0.145 * scale);
    addDashedCenterline(routeGroup, model.centerline, 0.168 * scale);
  });
}

function buildMiniMapData(points = [], projection) {
  if (!projection || points.length < 2) return null;
  const projected = points.map((point) => projection.project(point));
  const valid = projected.filter(Boolean);
  if (valid.length < 2) return null;
  const minX = Math.min(...valid.map((point) => point.x));
  const maxX = Math.max(...valid.map((point) => point.x));
  const minZ = Math.min(...valid.map((point) => point.z));
  const maxZ = Math.max(...valid.map((point) => point.z));
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);
  const positions = projected.map((point) => point ? ({
    x: 6 + ((point.x - minX) / spanX) * 88,
    y: 6 + ((point.z - minZ) / spanZ) * 48,
  }) : null);
  const paths = [];
  let active = [];
  positions.forEach((position, index) => {
    if (!position) return;
    if (index > 0 && (points[index]?.tracking_gap || points[index]?.route_gap)) {
      if (active.length > 1) paths.push(active);
      active = [];
    }
    active.push(position);
  });
  if (active.length > 1) paths.push(active);
  return { positions, paths };
}

function buildElevationProfile(points = []) {
  const samples = points.map((point, index) => ({
    index,
    altitude: finiteCoordinate(point?.altitude ?? point?.altitude_m),
    accuracy: finiteCoordinate(point?.altitude_accuracy ?? point?.altitudeAccuracy),
  })).filter((sample) => sample.altitude != null && (sample.accuracy == null || sample.accuracy <= 40));
  if (samples.length < 3) return null;
  const min = Math.min(...samples.map((sample) => sample.altitude));
  const max = Math.max(...samples.map((sample) => sample.altitude));
  const span = Math.max(1, max - min);
  return {
    min,
    max,
    path: samples.map((sample, index) => {
      const x = (sample.index / Math.max(1, points.length - 1)) * 100;
      const y = 28 - ((sample.altitude - min) / span) * 24;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' '),
  };
}

function telemetryForPlayback(dynamics = {}, speedKmh = 0) {
  const duration = Math.max(0.25, Number(dynamics.segment?.durationSeconds) || 1);
  const longitudinalG = (Number(dynamics.accelerationKmhPerSecond) || 0) / 35.30394;
  const yawRadiansPerSecond = THREE.MathUtils.degToRad(Number(dynamics.turnDeltaDegrees) || 0) / duration;
  const lateralG = ((Math.max(0, speedKmh) / 3.6) * yawRadiansPerSecond) / 9.80665;
  return {
    longitudinalG: clampNumber(longitudinalG, -2, 2),
    lateralG: clampNumber(lateralG, -2, 2),
    combinedG: clampNumber(Math.hypot(longitudinalG, lateralG), 0, 2.5),
    gradePercent: Number(dynamics.segment?.gradePercent) || 0,
  };
}

function deterministicUnit(seed = 1) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function createSkyDome(span = 100, theme = SCENE_THEMES[0]) {
  const geometry = new THREE.SphereGeometry(Math.max(150, span * 2.4), 28, 18);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(theme.skyTop) },
      horizonColor: { value: new THREE.Color(theme.skyHorizon) },
      groundColor: { value: new THREE.Color(theme.skyGround) },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldPosition;
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 groundColor;
      void main() {
        float heightMix = smoothstep(-0.08, 0.48, normalize(vWorldPosition).y);
        vec3 lower = mix(groundColor, horizonColor, smoothstep(-0.12, 0.08, normalize(vWorldPosition).y));
        gl_FragColor = vec4(mix(lower, topColor, heightMix), 1.0);
      }
    `,
  });
  return new THREE.Mesh(geometry, material);
}

function addProceduralEnvironment(scene, models = [], projection, quality = RENDER_QUALITIES[2]) {
  const count = Math.max(0, Number(quality.environmentCount) || 0);
  if (!count || !models.length) return;
  const scale = Math.max(0.32, Number(projection.objectScale) || 1);
  const span = Math.max(30, projection.span);
  const roadSamples = models.flatMap((model) => model.centerline.filter((_, index) => index % 8 === 0));
  const isRoadClear = (x, z, clearance) => roadSamples.every((point) => (
    ((point.x - x) ** 2 + (point.z - z) ** 2) > clearance ** 2
  ));
  const dummy = new THREE.Object3D();

  const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  const buildingMaterial = new THREE.MeshStandardMaterial({
    color: '#5b708b',
    roughness: 0.82,
    metalness: 0.04,
    vertexColors: true,
  });
  const buildings = new THREE.InstancedMesh(buildingGeometry, buildingMaterial, count);
  buildings.castShadow = quality.shadows;
  buildings.receiveShadow = true;
  let buildingCount = 0;

  const treeCountLimit = Math.ceil(count * 0.72);
  const treeGeometry = new THREE.ConeGeometry(0.7, 2.2, 7);
  const treeMaterial = new THREE.MeshStandardMaterial({ color: '#174b3a', roughness: 0.92 });
  const trees = new THREE.InstancedMesh(treeGeometry, treeMaterial, treeCountLimit);
  trees.castShadow = quality.shadows;
  let treeCount = 0;

  for (let attempt = 0; attempt < count * 5 && (buildingCount < count || treeCount < treeCountLimit); attempt++) {
    const angle = deterministicUnit(attempt + 11) * Math.PI * 2;
    const radius = (0.18 + deterministicUnit(attempt + 29) * 0.58) * span;
    const x = Math.cos(angle) * radius + (deterministicUnit(attempt + 43) - 0.5) * span * 0.24;
    const z = Math.sin(angle) * radius + (deterministicUnit(attempt + 61) - 0.5) * span * 0.24;
    // Keep the full follow-camera envelope clear, not only the road surface.
    // This prevents buildings or trees from clipping across chase/cinematic views.
    if (!isRoadClear(x, z, Math.max(5.5, 18 * scale))) continue;

    const useTree = deterministicUnit(attempt + 79) > 0.57;
    if (useTree && treeCount < treeCountLimit) {
      const size = (0.72 + deterministicUnit(attempt + 91) * 0.8) * scale;
      dummy.position.set(x, size * 1.08, z);
      dummy.rotation.set(0, deterministicUnit(attempt + 103) * Math.PI, 0);
      dummy.scale.set(size, size, size);
      dummy.updateMatrix();
      trees.setMatrixAt(treeCount++, dummy.matrix);
      continue;
    }

    if (buildingCount < count) {
      const width = (1.4 + deterministicUnit(attempt + 113) * 3.4) * scale;
      const depth = (1.4 + deterministicUnit(attempt + 127) * 3.2) * scale;
      const height = (1.8 + deterministicUnit(attempt + 139) * 8.6) * scale;
      dummy.position.set(x, height / 2 - 0.02, z);
      dummy.rotation.set(0, Math.round(deterministicUnit(attempt + 151) * 3) * Math.PI / 2, 0);
      dummy.scale.set(width, height, depth);
      dummy.updateMatrix();
      buildings.setMatrixAt(buildingCount, dummy.matrix);
      const shade = 0.48 + deterministicUnit(attempt + 163) * 0.34;
      buildings.setColorAt(buildingCount, new THREE.Color().setHSL(0.58, 0.2, shade));
      buildingCount++;
    }
  }

  buildings.count = buildingCount;
  trees.count = treeCount;
  buildings.instanceMatrix.needsUpdate = true;
  trees.instanceMatrix.needsUpdate = true;
  if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
  scene.add(buildings, trees);
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

function addSpeedLimitSign(scene, from, to, limit, index, objectScale = 1) {
  const texture = createSpeedLimitTexture(limit);
  if (!texture) return;
  const scale = Math.max(0.01, Number(objectScale) || 1);
  const heading = vectorHeading(from, to);
  const right = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
  const base = from.clone().lerp(to, 0.62).add(right.multiplyScalar((index % 2 === 0 ? 2.15 : -2.15) * scale));

  const group = new THREE.Group();
  group.position.copy(base);
  group.rotation.y = heading + (index % 2 === 0 ? -0.18 : Math.PI + 0.18);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035 * scale, 0.035 * scale, 1.35 * scale, 10),
    new THREE.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.62 })
  );
  pole.position.y = 0.72 * scale;
  group.add(pole);

  const sign = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  );
  sign.position.y = 1.55 * scale;
  sign.scale.set(0.95 * scale, 0.95 * scale, 1);
  group.add(sign);

  scene.add(group);
}

function createTaperedCabinGeometry() {
  const bottomX = 0.78;
  const topX = 0.56;
  const bottomFront = 0.78;
  const bottomRear = -0.8;
  const topFront = 0.44;
  const topRear = -0.5;
  const height = 0.62;
  const vertices = new Float32Array([
    -bottomX, 0, bottomFront,
    bottomX, 0, bottomFront,
    bottomX, 0, bottomRear,
    -bottomX, 0, bottomRear,
    -topX, height, topFront,
    topX, height, topFront,
    topX, height, topRear,
    -topX, height, topRear,
  ]);
  const indices = [
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addCarMesh(group, geometry, material, position, rotation = null) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function createSpeedTrail() {
  const group = new THREE.Group();
  const trailGeometry = new THREE.BoxGeometry(0.78, 0.018, 1.35);
  const glowGeometry = new THREE.BoxGeometry(1.35, 0.012, 2.3);
  const trailSpecs = [
    { geometry: glowGeometry, z: -2.1, width: 1.1, opacity: 0.22, color: '#38bdf8' },
    { geometry: trailGeometry, z: -2.6, width: 0.72, opacity: 0.34, color: '#93c5fd' },
    { geometry: trailGeometry, z: -3.75, width: 0.56, opacity: 0.22, color: '#60a5fa' },
    { geometry: trailGeometry, z: -4.8, width: 0.42, opacity: 0.13, color: '#2563eb' },
  ];

  trailSpecs.forEach((spec, index) => {
    const material = new THREE.MeshBasicMaterial({
      color: spec.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(spec.geometry, material);
    mesh.position.set(0, 0.18 + index * 0.006, spec.z);
    mesh.scale.x = spec.width;
    mesh.userData.baseOpacity = spec.opacity;
    mesh.userData.baseZ = spec.z;
    group.add(mesh);
  });

  group.visible = false;
  return group;
}

function updateSpeedTrail(trail, scenePoint, heading, speedStrength, objectScale = 1) {
  if (!trail) return;
  const strength = clampNumber(speedStrength, 0, 1);
  const scale = Math.max(0.01, Number(objectScale) || 1);
  trail.visible = strength > 0.03;
  trail.position.copy(scenePoint);
  trail.position.y += 0.15 * scale;
  trail.rotation.set(0, heading, 0);
  trail.scale.set((1 + strength * 0.28) * scale, scale, (1 + strength * 0.55) * scale);
  trail.children.forEach((mesh, index) => {
    if (mesh.material) {
      const fade = Math.max(0, strength - index * 0.08);
      mesh.material.opacity = (mesh.userData.baseOpacity || 0.15) * fade;
    }
    mesh.position.z = (mesh.userData.baseZ || -2.5) - strength * (0.7 + index * 0.22);
  });
}

function createCarModel(objectScale = 1) {
  const scale = Math.max(0.01, Number(objectScale) || 1);
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: '#1d4ed8',
    metalness: 0.38,
    roughness: 0.28,
    envMapIntensity: 0.6,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: '#0b1220', metalness: 0.24, roughness: 0.34 });
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: '#172554',
    metalness: 0.04,
    roughness: 0.08,
    transparent: true,
    opacity: 0.74,
  });
  const tireMaterial = new THREE.MeshStandardMaterial({ color: '#050816', roughness: 0.72, metalness: 0.03 });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: '#cbd5e1', roughness: 0.2, metalness: 0.62 });
  const headlightMaterial = new THREE.MeshStandardMaterial({
    color: '#f8fafc',
    emissive: '#fde68a',
    emissiveIntensity: 0.9,
    roughness: 0.12,
  });
  const brakeMaterial = new THREE.MeshStandardMaterial({
    color: '#7f1d1d',
    emissive: '#450a0a',
    emissiveIntensity: 0.12,
    roughness: 0.22,
  });

  addCarMesh(group, new RoundedBoxGeometry(1.92, 0.48, 3.72, 5, 0.18), bodyMaterial, [0, 0.5, 0]);
  addCarMesh(group, new RoundedBoxGeometry(1.72, 0.28, 1.1, 4, 0.14), bodyMaterial, [0, 0.74, 0.95]);
  addCarMesh(group, new RoundedBoxGeometry(1.78, 0.22, 0.82, 4, 0.12), bodyMaterial, [0, 0.66, -1.24]);
  addCarMesh(group, new RoundedBoxGeometry(2.02, 0.2, 0.28, 4, 0.08), accentMaterial, [0, 0.34, 1.9]);
  addCarMesh(group, new RoundedBoxGeometry(2.02, 0.22, 0.28, 4, 0.08), accentMaterial, [0, 0.36, -1.9]);
  addCarMesh(group, new RoundedBoxGeometry(1.42, 0.08, 0.14, 3, 0.04), accentMaterial, [0, 0.61, 1.91]);

  const cabin = addCarMesh(group, createTaperedCabinGeometry(), glassMaterial, [0, 0.78, -0.14]);
  cabin.castShadow = true;

  const hoodLine = addCarMesh(group, new THREE.BoxGeometry(1.35, 0.018, 0.04), accentMaterial, [0, 0.91, 1.03]);
  hoodLine.material = accentMaterial;
  [-0.62, 0.62].forEach((x) => {
    addCarMesh(group, new RoundedBoxGeometry(0.28, 0.08, 0.05, 3, 0.025), headlightMaterial, [x, 0.58, 1.92]);
  });

  const brakeLights = [];
  [-0.62, 0.62].forEach((x) => {
    const light = addCarMesh(group, new RoundedBoxGeometry(0.3, 0.1, 0.06, 3, 0.025), brakeMaterial.clone(), [x, 0.58, -1.92]);
    light.userData.isBrakeLight = true;
    brakeLights.push(light);
  });

  const sideWindowGeometry = new THREE.PlaneGeometry(1.02, 0.34);
  [-1, 1].forEach((side) => {
    const sideWindow = new THREE.Mesh(sideWindowGeometry, glassMaterial);
    sideWindow.position.set(side * 0.792, 1.12, -0.18);
    sideWindow.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    sideWindow.castShadow = false;
    group.add(sideWindow);

    addCarMesh(group, new RoundedBoxGeometry(0.06, 0.06, 1.34, 2, 0.025), accentMaterial, [side * 1.02, 0.55, 0]);
  });

  const wheelGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.28, 32);
  wheelGeometry.rotateZ(Math.PI / 2);
  const rimGeometry = new THREE.CylinderGeometry(0.19, 0.19, 0.3, 24);
  rimGeometry.rotateZ(Math.PI / 2);
  [-1.06, 1.06].forEach((x) => {
    [-1.12, 1.12].forEach((z) => {
      const isFrontWheel = z > 0;
      const wheel = new THREE.Mesh(wheelGeometry, tireMaterial);
      wheel.position.set(x, 0.31, z);
      wheel.castShadow = true;
      wheel.userData.isWheel = true;
      wheel.userData.isFrontWheel = isFrontWheel;
      group.add(wheel);

      const rim = new THREE.Mesh(rimGeometry, rimMaterial);
      rim.position.copy(wheel.position);
      rim.userData.isWheel = true;
      rim.userData.isFrontWheel = isFrontWheel;
      group.add(rim);
    });
  });

  const headlightGlow = new THREE.PointLight('#bfdbfe', 0.75, 12);
  headlightGlow.position.set(0, 0.8, 1.85);
  group.add(headlightGlow);

  group.scale.setScalar(0.92 * scale);
  group.position.y = 0.14 * scale;
  group.userData.brakeLights = brakeLights;
  return group;
}

function addEventMarker(scene, projection, event, index) {
  const position = projection.project(event);
  if (!position) return;

  const objectScale = Math.max(0.01, Number(projection.objectScale) || 1);
  const color = colorForEvent(event);
  const severityScale = event.severity === 'high' || event.type === 'possible_crash' ? 1.5 : 1;
  const sizeScale = objectScale * severityScale;
  const group = new THREE.Group();
  group.position.copy(position);
  group.position.y += 0.12 * objectScale;

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035 * objectScale, 0.035 * objectScale, 1.65 * sizeScale, 10),
    new THREE.MeshStandardMaterial({ color: '#475569', roughness: 0.72 })
  );
  pole.position.y = 0.82 * sizeScale;
  group.add(pole);

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.26 * sizeScale, 18, 18),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.35 })
  );
  marker.position.y = 1.68 * sizeScale;
  marker.userData.label = titleCase(event.type || 'event');
  marker.userData.isEventBeacon = true;
  marker.userData.baseScale = severityScale;
  group.add(marker);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.34 * sizeScale, 0.54 * sizeScale, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 0.05 * objectScale;
  halo.userData.isEventHalo = true;
  halo.userData.baseOpacity = 0.18;
  group.add(halo);

  group.userData.eventIndex = index;
  scene.add(group);
  return group;
}

function addStopMarker(scene, projection, stop, index) {
  const position = projection.project(stop.point);
  if (!position) return;
  const objectScale = Math.max(0.01, Number(projection.objectScale) || 1);
  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5 * objectScale, 0.5 * objectScale, 0.16 * objectScale, 28),
    new THREE.MeshStandardMaterial({ color: index % 2 ? '#64748b' : '#334155', roughness: 0.7 })
  );
  marker.position.copy(position);
  marker.position.y += 0.16 * objectScale;
  marker.receiveShadow = true;
  scene.add(marker);
}

function buildReplayChapters(timeline = {}) {
  const segments = Array.isArray(timeline.segments) ? timeline.segments : [];
  const events = Array.isArray(timeline.events) ? timeline.events : [];
  const stops = Array.isArray(timeline.stops) ? timeline.stops : [];
  const chapters = [];

  if (segments.length) {
    chapters.push({
      kind: 'start',
      label: 'Start',
      detail: 'Begin replay',
      offsetSeconds: 0,
      color: '#38bdf8',
      cameraMode: 'cinematic',
    });
  }

  const fastest = segments.reduce((best, segment) => (
    Number(segment.speedKmh) > Number(best?.speedKmh || 0) ? segment : best
  ), null);
  if (fastest?.speedKmh > 0) {
    chapters.push({
      kind: 'speed',
      label: 'Fastest',
      detail: `${Math.round(fastest.speedKmh)} km/h`,
      offsetSeconds: fastest.startOffsetSeconds || 0,
      color: fastest.color || '#f97316',
      cameraMode: 'chase',
    });
  }

  const firstViolation = segments.find((segment) => Number(segment.overLimitKmh) > 0);
  if (firstViolation) {
    chapters.push({
      kind: 'limit',
      label: 'Over limit',
      detail: `${Math.round(firstViolation.overLimitKmh)} km/h over`,
      offsetSeconds: firstViolation.startOffsetSeconds || 0,
      color: '#ef4444',
      cameraMode: 'cinematic',
    });
  }

  const longestStop = stops.reduce((best, stop) => (
    Number(stop.durationSeconds) > Number(best?.durationSeconds || 0) ? stop : best
  ), null);
  if (longestStop) {
    chapters.push({
      kind: 'stop',
      label: 'Longest stop',
      detail: formatDuration(Math.round(longestStop.durationSeconds || 0)),
      offsetSeconds: segments.find((segment) => segment.fromIndex === longestStop.startIndex)?.startOffsetSeconds || 0,
      color: '#94a3b8',
      cameraMode: 'top',
    });
  }

  events.slice(0, 8).forEach((event) => {
    chapters.push({
      kind: 'event',
      label: titleCase(event.type || 'Event'),
      detail: formatDuration(Math.round(event.offsetSeconds || 0)),
      offsetSeconds: Number(event.offsetSeconds) || 0,
      color: colorForEvent(event),
      cameraMode: 'event',
      event,
    });
  });

  return chapters
    .filter((chapter, index, list) => (
      list.findIndex((item) => chapterKey(item) === chapterKey(chapter)) === index
    ))
    .sort((a, b) => (a.offsetSeconds || 0) - (b.offsetSeconds || 0))
    .slice(0, 12);
}

export default function TripDrive3D({ trip, events = [], height = '430px', colorMode = 'speedBand' }) {
  const shellRef = useRef(null);
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
  const lastKnownSpeedRef = useRef(0);
  const directorRef = useRef(false);
  const reducedMotionRef = useRef(false);
  const audioRef = useRef(null);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  usePlaybackScreenAwake(playing);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [followVehicle, setFollowVehicle] = useState(true);
  const [cameraMode, setCameraMode] = useState('chase');
  const [displayMode, setDisplayMode] = useState(colorMode);
  const [qualityIdx, setQualityIdx] = useState(0);
  const [adaptiveQualityId, setAdaptiveQualityId] = useState('medium');
  const [webglFailed, setWebglFailed] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [measuredFps, setMeasuredFps] = useState(null);
  const [directorEnabled, setDirectorEnabled] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [themeIdx, setThemeIdx] = useState(2);
  const qualityIdxRef = useRef(qualityIdx);

  const settings = useLocalSettings();
  usePrivacyZonesRevision();
  const heightenedPrivacy = settings?.[HEIGHTENED_PRIVACY_MODE_KEY] === true;
  const privacySettings = useMemo(() => ({
    privacy_zones: settings.privacy_zones,
    show_privacy_circles: settings.show_privacy_circles,
  }), [settings.privacy_zones, settings.show_privacy_circles]);

  const preparedPoints = useMemo(() => prepareMapRoutePoints(
    maskRoutePointsForPrivacy(trip?.route_points || [], privacySettings),
    { maxPoints: 720 }
  ).map(validLatLngPoint).filter(Boolean), [privacySettings, trip?.route_points]);

  const visibleEvents = useMemo(() => maskEventsForPrivacy(events, privacySettings)
    .map(validLatLngPoint)
    .filter(Boolean), [events, privacySettings]);

  const sourceTimeline = useMemo(() => buildPlaybackTimeline(preparedPoints, visibleEvents), [preparedPoints, visibleEvents]);
  const points = sourceTimeline.points;
  const positionIndex = useMemo(() => buildPlaybackPositionIndex(points, {
    alreadyClean: true,
    compressGaps: true,
    gapTransitionSeconds: GAP_TRANSITION_SECONDS,
  }), [points]);
  const timeline = useMemo(() => {
    const offsetForPointIndex = (index) => {
      const timeMs = positionIndex.timesMs?.[Math.max(0, Math.min(points.length - 1, index))];
      return Number.isFinite(timeMs) && Number.isFinite(positionIndex.firstMs)
        ? Math.max(0, (timeMs - positionIndex.firstMs) / 1000)
        : 0;
    };
    return {
      ...sourceTimeline,
      segments: sourceTimeline.segments.map((segment) => ({
        ...segment,
        startOffsetSeconds: offsetForPointIndex(segment.fromIndex),
        endOffsetSeconds: offsetForPointIndex(segment.toIndex),
      })),
      events: sourceTimeline.events.map((event) => ({
        ...event,
        offsetSeconds: offsetForPointIndex(event.playbackIndex),
      })),
      stats: {
        ...sourceTimeline.stats,
        sourceDurationSeconds: sourceTimeline.stats.durationSeconds,
        durationSeconds: positionIndex.durationSeconds || sourceTimeline.stats.durationSeconds,
      },
    };
  }, [points.length, positionIndex, sourceTimeline]);
  const replayChapters = useMemo(() => buildReplayChapters(timeline), [timeline]);
  const projection = useMemo(() => buildProjection(points), [points]);
  const durationSeconds = positionIndex.durationSeconds || timeline.stats.durationSeconds || Math.max(1, points.length - 1);
  const playbackPosition = useMemo(
    () => playbackPositionAtElapsed(points, elapsedSeconds, positionIndex),
    [elapsedSeconds, points, positionIndex]
  );
  const currentDynamics = useMemo(
    () => playbackPosition.isGap
      ? {
        segment: null,
        accelerationKmhPerSecond: 0,
        braking: false,
        accelerating: false,
        turnDeltaDegrees: 0,
        overLimitKmh: 0,
        intensity: 0,
      }
      : dynamicsAtPlaybackPosition(timeline, playbackPosition),
    [playbackPosition, timeline]
  );
  const currentSpeedKmh = playbackPosition.isGap ? 0 : speedKmhAtPlaybackPosition(timeline, playbackPosition);
  const currentDistanceKm = routeDistanceAtPlaybackPosition(timeline, playbackPosition, playbackPosition.index);
  const currentEvent = timeline.events
    .map((event) => ({ event, delta: Math.abs((Number(event.offsetSeconds) || 0) - elapsedSeconds) }))
    .filter((item) => item.delta <= 5)
    .sort((a, b) => a.delta - b.delta)[0]?.event || null;
  const routeDistanceKm = Number(trip?.distance_km) > 0 ? Number(trip.distance_km) : timeline.stats.distanceKm;
  const targetReplaySeconds = clampNumber(
    (Math.max(0.05, routeDistanceKm) / BASE_REPLAY_SPEED_KMH) * 3600,
    MIN_REPLAY_SECONDS,
    MAX_REPLAY_SECONDS
  );
  const baseReplayRate = clampNumber(
    durationSeconds / Math.max(1, targetReplaySeconds),
    1,
    MAX_BASE_REPLAY_RATE
  );
  const progress = durationSeconds > 0 ? Math.max(0, Math.min(100, (elapsedSeconds / durationSeconds) * 100)) : 0;
  const selectedQuality = RENDER_QUALITIES[qualityIdx] || RENDER_QUALITIES[0];
  const effectiveQuality = selectedQuality.id === 'auto'
    ? RENDER_QUALITIES.find((quality) => quality.id === adaptiveQualityId) || RENDER_QUALITIES[2]
    : selectedQuality;
  const sceneTheme = SCENE_THEMES[themeIdx] || SCENE_THEMES[0];
  const miniMap = useMemo(() => buildMiniMapData(points, projection), [points, projection]);
  const elevationProfile = useMemo(() => buildElevationProfile(points), [points]);
  const currentMiniPoint = miniMap?.positions?.[Math.max(0, playbackPosition.toIndex)] || null;
  const currentAltitude = (() => {
    const from = finiteCoordinate(points[playbackPosition.fromIndex]?.altitude ?? points[playbackPosition.fromIndex]?.altitude_m);
    const to = finiteCoordinate(points[playbackPosition.toIndex]?.altitude ?? points[playbackPosition.toIndex]?.altitude_m);
    if (from == null && to == null) return null;
    if (from == null) return to;
    if (to == null) return from;
    return THREE.MathUtils.lerp(from, to, clampNumber(playbackPosition.ratio, 0, 1));
  })();
  const telemetry = useMemo(
    () => telemetryForPlayback(currentDynamics, currentSpeedKmh),
    [currentDynamics, currentSpeedKmh]
  );

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    speedMultiplierRef.current = SPEEDS[speedIdx] * baseReplayRate;
  }, [baseReplayRate, speedIdx]);

  useEffect(() => {
    followRef.current = followVehicle;
  }, [followVehicle]);

  useEffect(() => {
    directorRef.current = directorEnabled;
  }, [directorEnabled]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const sync = () => { reducedMotionRef.current = media?.matches === true; };
    sync();
    media?.addEventListener?.('change', sync);
    return () => media?.removeEventListener?.('change', sync);
  }, []);

  useEffect(() => () => {
    const audio = audioRef.current;
    audioRef.current = null;
    audio?.context?.close?.().catch?.(() => {});
  }, []);

  useEffect(() => {
    cameraModeRef.current = cameraMode;
    followRef.current = cameraMode !== 'free';
    setFollowVehicle(cameraMode !== 'free');
  }, [cameraMode]);

  useEffect(() => {
    elapsedRef.current = elapsedSeconds;
  }, [elapsedSeconds]);

  useEffect(() => {
    setDisplayMode(colorMode);
  }, [colorMode]);

  useEffect(() => {
    elapsedRef.current = 0;
    setElapsedSeconds(0);
    setPlaying(false);
    setFollowVehicle(true);
    setCameraMode('chase');
    setDirectorEnabled(false);
    setWebglFailed(false);
    setContextLost(false);
    setAdaptiveQualityId('medium');
    setMeasuredFps(null);
    completedLoggedRef.current = '';
    lastKnownSpeedRef.current = 0;
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
    qualityIdxRef.current = qualityIdx;
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, effectiveQuality.pixelRatio));
  }, [effectiveQuality, qualityIdx]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || !projection || points.length < 2) return undefined;

    const quality = effectiveQuality;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: quality.id !== 'low',
        alpha: false,
        powerPreference: 'high-performance',
      });
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(sceneTheme.background);
    scene.fog = new THREE.Fog(sceneTheme.fog, 42, 155);
    scene.add(createSkyDome(Math.max(90, projection.span), sceneTheme));

    const camera = new THREE.PerspectiveCamera(CAMERA_BASE_FOV, 1, 0.1, 320);
    const span = Math.max(28, projection.span);
    const objectScale = projection.objectScale ?? 1;
    camera.position.set(
      0,
      Math.min(42 * objectScale, span * 0.48),
      Math.max(30 * objectScale, span * 0.68)
    );

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = 8 * objectScale;
    controls.maxDistance = Math.max(44 * objectScale, span * 1.8);
    controls.target.set(0, 0, 0);
    controls.enabled = false;
    controls.update();
    controlsRef.current = controls;

    const renderLogKey = `${trip?.id || 'trip'}:${displayMode}:${points.length}:${timeline.events.length}`;
    if (renderLoggedRef.current !== renderLogKey) {
      renderLoggedRef.current = renderLogKey;
      recordSystemEvent('trip_3d_playback_loaded', {
        trip_id: trip?.id || null,
        point_count: points.length,
        event_count: timeline.events.length,
        stop_count: timeline.stops.length,
        duration_seconds: durationSeconds,
        color_mode: displayMode,
      }, {
        category: 'diagnostics',
        title: '3D drive loaded',
      });
    }

    scene.add(new THREE.HemisphereLight(
      sceneTheme.hemisphereSky,
      sceneTheme.hemisphereGround,
      sceneTheme.hemisphereIntensity
    ));
    const sun = new THREE.DirectionalLight(sceneTheme.sun, sceneTheme.sunIntensity);
    sun.position.set(-18, 26, 22);
    sun.castShadow = quality.shadows;
    sun.shadow.mapSize.width = quality.shadowSize;
    sun.shadow.mapSize.height = quality.shadowSize;
    const shadowSpan = Math.max(50, span * 1.3);
    sun.shadow.camera.left = -shadowSpan;
    sun.shadow.camera.right = shadowSpan;
    sun.shadow.camera.top = shadowSpan;
    sun.shadow.camera.bottom = -shadowSpan;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = shadowSpan * 4;
    sun.shadow.bias = -0.0015;
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(90, span * 2.2), Math.max(90, span * 2.2), 1, 1),
      new THREE.MeshStandardMaterial({ color: sceneTheme.ground, roughness: 0.94, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(Math.max(90, span * 2), 32, '#334155', '#1e293b');
    grid.position.y = 0.01;
    scene.add(grid);

    const animatedEventMeshes = [];
    const roadModels = buildRoadModels(timeline.segments, projection);
    addCurvedRoad(scene, roadModels, displayMode, objectScale);
    addProceduralEnvironment(scene, roadModels, projection, quality);
    let lastSignLimit = null;
    let lastSignIndex = -Infinity;
    timeline.segments.forEach((segment, index) => {
      const from = roadPoseForPlayback(roadModels, {
        fromIndex: segment.fromIndex,
        toIndex: segment.toIndex,
        ratio: 0,
      })?.point;
      const to = roadPoseForPlayback(roadModels, {
        fromIndex: segment.fromIndex,
        toIndex: segment.toIndex,
        ratio: 1,
      })?.point;
      if (!from || !to) return;
      const limit = Number(segment.speedLimitKmh);
      if (
        Number.isFinite(limit) &&
        limit > 0 &&
        (lastSignLimit !== Math.round(limit) || index - lastSignIndex > 18)
      ) {
        addSpeedLimitSign(scene, from, to, limit, index, objectScale);
        lastSignLimit = Math.round(limit);
        lastSignIndex = index;
      }
    });

    timeline.stops.forEach((stop, index) => {
      const pose = roadPoseForPlayback(roadModels, {
        fromIndex: stop.startIndex,
        toIndex: Math.min(stop.startIndex + 1, points.length - 1),
        ratio: 0,
      });
      addStopMarker(scene, { ...projection, project: () => pose?.point || null }, stop, index);
    });
    timeline.events.slice(0, quality.maxEvents).forEach((event, index) => {
      const playbackIndex = Math.max(0, Number(event.playbackIndex) || 0);
      const pose = roadPoseForPlayback(roadModels, {
        fromIndex: Math.max(0, playbackIndex - 1),
        toIndex: playbackIndex,
        ratio: 1,
      });
      const group = addEventMarker(scene, { ...projection, project: () => pose?.point || null }, event, index);
      group?.traverse((child) => {
        if (child.userData?.isEventBeacon || child.userData?.isEventHalo) animatedEventMeshes.push(child);
      });
    });

    const car = createCarModel(objectScale);
    carRef.current = car;
    scene.add(car);
    const contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.45 * objectScale, 28),
      new THREE.MeshBasicMaterial({
        color: '#020617',
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
      })
    );
    contactShadow.rotation.x = -Math.PI / 2;
    scene.add(contactShadow);
    const speedTrail = createSpeedTrail();
    scene.add(speedTrail);

    let contextAvailable = true;
    const handleContextLost = (event) => {
      event.preventDefault?.();
      contextAvailable = false;
      logSystemFailure('trip_3d_webgl_context_lost', new Error('WebGL context lost'), {
        trip_id: trip?.id,
        elapsed_seconds: Math.round(elapsedRef.current),
      });
      setContextLost(true);
    };
    const handleContextRestored = () => {
      contextAvailable = true;
      setContextLost(false);
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
    let sceneVisible = true;
    const intersectionObserver = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => {
        sceneVisible = entry?.isIntersecting !== false;
      }, { threshold: 0.01 })
      : null;
    intersectionObserver?.observe(container);

    let smoothedHeading = null;
    let smoothedCarY = null;
    let smoothedPitch = 0;
    let smoothedRoll = 0;
    let smoothedSteer = 0;
    const cinematicSide = 1;
    const smoothedCameraTarget = new THREE.Vector3();
    let hasSmoothedCameraTarget = false;

    const updateCar = (delta = 0) => {
      const position = playbackPositionAtElapsed(points, elapsedRef.current, positionIndex);
      const pose = roadPoseForPlayback(roadModels, position);
      if (position.isGap || !pose) {
        car.visible = false;
        contactShadow.visible = false;
        speedTrail.visible = false;
        lastKnownSpeedRef.current = 0;
        smoothedCarY = null;
        return;
      }
      car.visible = true;
      contactShadow.visible = true;
      const scenePoint = pose.point;
      const overviewMode = ['top', 'free'].includes(cameraModeRef.current);
      roadModels.forEach((model) => {
        if (!model.renderGroup) return;
        model.renderGroup.visible = overviewMode || model === pose.model ||
          model.renderGroup.userData.streamCenter.distanceTo(scenePoint) <= STREAM_DISTANCE_SCENE_UNITS;
      });

      const dynamics = dynamicsAtPlaybackPosition(timeline, position);
      const speed = speedKmhAtPlaybackPosition(timeline, position);
      const speedStrength = speedEffectStrength(speed);
      const lookAheadElapsed = Math.min(
        durationSeconds,
        elapsedRef.current + CAMERA_LOOKAHEAD_SECONDS + Math.min(2.4, speed / 95)
      );
      const lookAheadPosition = playbackPositionAtElapsed(points, lookAheadElapsed, positionIndex);
      const lookAheadPose = roadPoseForPlayback(roadModels, lookAheadPosition);
      const lookAheadPoint = lookAheadPose?.point || null;
      const rawHeading = lookAheadPose?.heading ?? pose.heading;
      const headingAlpha = dampAlpha(playingRef.current ? 7.2 : 16, delta);
      smoothedHeading = smoothedHeading == null
        ? rawHeading
        : lerpAngleRadians(smoothedHeading, rawHeading, headingAlpha);

      const targetCarY = scenePoint.y + 0.24 * objectScale;
      smoothedCarY = smoothedCarY == null
        ? targetCarY
        : smoothedCarY + (targetCarY - smoothedCarY) * dampAlpha(6, delta);
      car.position.set(scenePoint.x, smoothedCarY, scenePoint.z);
      contactShadow.position.copy(scenePoint);
      contactShadow.position.y += 0.175 * objectScale;
      car.rotation.y = smoothedHeading;
      const roadPitch = clampNumber(
        Math.atan2(pose.tangent.y, Math.hypot(pose.tangent.x, pose.tangent.z)),
        -0.16,
        0.16
      );
      const turnBank = clampNumber(-dynamics.turnDeltaDegrees / 260, -0.08, 0.08);
      const brakePitch = dynamics.braking ? -0.045 * Math.max(0.25, dynamics.intensity) : 0;
      const accelPitch = dynamics.accelerating ? 0.032 * Math.max(0.2, dynamics.intensity) : 0;
      const bodyAlpha = dampAlpha(10, delta);
      smoothedPitch += ((roadPitch + brakePitch + accelPitch) - smoothedPitch) * bodyAlpha;
      smoothedRoll += (turnBank - smoothedRoll) * bodyAlpha;
      car.rotation.x = smoothedPitch;
      car.rotation.z = smoothedRoll;
      const steerSpeedScale = clampNumber(speed / 30, 0, 1);
      const targetSteer = clampNumber(THREE.MathUtils.degToRad(dynamics.turnDeltaDegrees) * 0.55, -0.42, 0.42) * steerSpeedScale;
      smoothedSteer += (targetSteer - smoothedSteer) * dampAlpha(12, delta);
      car.traverse((child) => {
        if (child.userData?.isWheel) {
          child.rotation.x -= (speed / 55) * delta * 12;
          child.rotation.y = child.userData.isFrontWheel ? smoothedSteer : 0;
        }
        if (child.userData?.isBrakeLight && child.material) {
          const active = dynamics.braking || dynamics.overLimitKmh > 15;
          child.material.color.set(active ? '#ef4444' : '#7f1d1d');
          child.material.emissive.set(active ? '#ef4444' : '#450a0a');
          child.material.emissiveIntensity = active ? 1.9 : 0.12;
        }
      });
      updateSpeedTrail(
        speedTrail,
        scenePoint,
        smoothedHeading,
        reducedMotionRef.current ? 0 : speedStrength,
        objectScale
      );
      const audio = audioRef.current;
      if (audio?.context?.state === 'running') {
        const now = audio.context.currentTime;
        const engineFrequency = 38 + speed * 0.72;
        audio.engine.frequency.setTargetAtTime(engineFrequency, now, 0.12);
        audio.harmonic.frequency.setTargetAtTime(engineFrequency * 2.01, now, 0.12);
        audio.filter.frequency.setTargetAtTime(180 + speed * 7.5, now, 0.16);
        audio.gain.gain.setTargetAtTime(playingRef.current ? 0.012 + speedStrength * 0.008 : 0.002, now, 0.14);
      }
      const targetFov = cameraModeRef.current === 'top'
        ? CAMERA_BASE_FOV
        : CAMERA_BASE_FOV + speedStrength * 5.5;
      if (Math.abs(camera.fov - targetFov) > 0.01) {
        camera.fov += (targetFov - camera.fov) * dampAlpha(5.5, delta);
        camera.updateProjectionMatrix();
      }

      if (followRef.current) {
        let mode = cameraModeRef.current;
        controls.enabled = false;
        const forward = new THREE.Vector3(Math.sin(smoothedHeading), 0, Math.cos(smoothedHeading));
        const right = new THREE.Vector3(Math.cos(smoothedHeading), 0, -Math.sin(smoothedHeading));
        const cameraAnchorAlpha = dampAlpha(playingRef.current ? 9.5 : 18, delta);
        if (!hasSmoothedCameraTarget) {
          smoothedCameraTarget.copy(scenePoint);
          hasSmoothedCameraTarget = true;
        } else {
          smoothedCameraTarget.lerp(scenePoint, cameraAnchorAlpha);
        }
        const lookTarget = lookAheadPoint && lookAheadPoint.distanceTo(smoothedCameraTarget) > 0.5
          ? smoothedCameraTarget.clone().lerp(lookAheadPoint, 0.58)
          : smoothedCameraTarget;
        const cameraTarget = lookTarget.clone().add(new THREE.Vector3(0, 1.2 * objectScale, 0));
        const activeEvent = timeline.events.find((event) => (
          Math.abs((Number(event.offsetSeconds) || 0) - elapsedRef.current) <= 8
        ));
        if (directorRef.current && mode === 'cinematic') {
          if (activeEvent) mode = 'event';
          else if (Math.abs(dynamics.turnDeltaDegrees) > 22) mode = 'side';
          else if (speed > 82) mode = 'chase';
          else if (speed <= IDLE_SPEED_KMH) mode = 'top';
        }
        const eventPlaybackIndex = Math.max(0, Number(activeEvent?.playbackIndex) || 0);
        const eventPoint = activeEvent
          ? roadPoseForPlayback(roadModels, {
            fromIndex: Math.max(0, eventPlaybackIndex - 1),
            toIndex: eventPlaybackIndex,
            ratio: 1,
          })?.point || null
          : null;
        const cinematicEventFocus = mode === 'cinematic' && eventPoint;
        const desiredTarget = (mode === 'event' || cinematicEventFocus) && eventPoint
          ? eventPoint.clone().add(new THREE.Vector3(0, 1.4 * objectScale, 0))
          : cameraTarget;
        const speedPullback = Math.min(4.5, speed / 28) * objectScale;
        const desiredCamera = mode === 'top'
          ? cameraTarget.clone().add(new THREE.Vector3(0, Math.max(24 * objectScale, projection.span * 0.62), 0.1 * objectScale))
          : mode === 'hood'
            ? scenePoint.clone()
              .add(forward.clone().multiplyScalar(1.15 * objectScale))
              .add(new THREE.Vector3(0, 1.42 * objectScale, 0))
          : mode === 'side'
            ? cameraTarget.clone()
              .add(right.multiplyScalar(12 * objectScale + speedPullback * 0.35))
              .add(new THREE.Vector3(0, 5.2 * objectScale + speedPullback * 0.18, 0))
            : mode === 'event' && eventPoint
              ? cameraTarget.clone()
                .add(forward.clone().multiplyScalar(-8 * objectScale - speedPullback * 0.4))
                .add(right.multiplyScalar(7 * objectScale))
                .add(new THREE.Vector3(0, 6.5 * objectScale, 0))
              : mode === 'cinematic' && eventPoint
                ? cameraTarget.clone()
                  .add(forward.clone().multiplyScalar(-8.4 * objectScale - speedPullback * 0.45))
                  .add(right.multiplyScalar(cinematicSide * ((5.8 + dynamics.intensity * 2.4) * objectScale)))
                  .add(new THREE.Vector3(0, (5.7 + dynamics.intensity * 1.6) * objectScale, 0))
                : mode === 'cinematic'
                  ? cameraTarget.clone()
                    .add(forward.clone().multiplyScalar(-9.2 * objectScale - speedPullback * 0.9))
                    .add(right.multiplyScalar(cinematicSide * ((2.8 + Math.min(2.2, Math.abs(dynamics.turnDeltaDegrees) / 16)) * objectScale)))
                    .add(new THREE.Vector3(0, (4.8 + dynamics.intensity * 0.7) * objectScale + speedPullback * 0.16, 0))
              : cameraTarget.clone()
                .add(forward.clone().multiplyScalar(-10.5 * objectScale - speedPullback))
                .add(new THREE.Vector3(0, 5.6 * objectScale + speedPullback * 0.22, 0));
        camera.position.lerp(desiredCamera, dampAlpha(mode === 'event' || mode === 'cinematic' ? 5.8 : 4.4, delta));
        controls.target.lerp(desiredTarget, dampAlpha(mode === 'event' || mode === 'cinematic' ? 7.5 : 6, delta));
      } else {
        controls.enabled = true;
      }
      lastKnownSpeedRef.current = speed;
    };

    const clock = new THREE.Clock();
    let frameId = 0;
    let fpsFrameCount = 0;
    let fpsSampleStartedAt = performance.now();
    let lowFpsSamples = 0;
    const animate = () => {
      const delta = Math.min(0.08, clock.getDelta());
      const shouldRender = contextAvailable && sceneVisible && !document.hidden;
      if (shouldRender && playingRef.current) {
        const nextElapsed = advancePlaybackElapsed(
          elapsedRef.current,
          delta,
          speedMultiplierRef.current,
          durationSeconds
        );
        elapsedRef.current = nextElapsed;
        if (nextElapsed >= durationSeconds) {
          playingRef.current = false;
          setPlaying(false);
          setElapsedSeconds(durationSeconds);
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
      if (shouldRender) {
        updateCar(delta);
        const pulse = reducedMotionRef.current
          ? 0
          : (Math.sin(performance.now() * 0.0055) + 1) * 0.5;
        animatedEventMeshes.forEach((mesh) => {
          if (mesh.userData?.isEventBeacon) {
            const baseScale = mesh.userData.baseScale || 1;
            const scale = baseScale * (1 + pulse * 0.16);
            mesh.scale.setScalar(scale);
            if (mesh.material) mesh.material.emissiveIntensity = 0.25 + pulse * 0.55;
          }
          if (mesh.userData?.isEventHalo && mesh.material) {
            mesh.material.opacity = (mesh.userData.baseOpacity || 0.18) + pulse * 0.18;
            const scale = 1 + pulse * 0.55;
            mesh.scale.set(scale, scale, scale);
          }
        });
        controls.update();
        renderer.render(scene, camera);

        fpsFrameCount++;
        const sampleNow = performance.now();
        const sampleDuration = sampleNow - fpsSampleStartedAt;
        if (sampleDuration >= 2500) {
          const fps = Math.round((fpsFrameCount * 1000) / sampleDuration);
          setMeasuredFps(fps);
          lowFpsSamples = fps < 27 ? lowFpsSamples + 1 : 0;
          if (selectedQuality.id === 'auto' && lowFpsSamples >= 3 && adaptiveQualityId !== 'low') {
            setAdaptiveQualityId('low');
          }
          fpsFrameCount = 0;
          fpsSampleStartedAt = sampleNow;
        }
      }
      frameId = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      canvas.removeEventListener('webglcontextlost', handleContextLost, false);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored, false);
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      carRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
    };
  }, [adaptiveQualityId, displayMode, durationSeconds, effectiveQuality, points, positionIndex, projection, sceneTheme, selectedQuality.id, timeline, trip?.id]);

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
    setCameraMode('cinematic');
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
      const next = mode === 'free' ? 'cinematic' : 'free';
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

  const jumpToChapter = (chapter) => {
    const elapsed = Math.max(0, Number(chapter.offsetSeconds) || 0);
    seekToElapsed(elapsed, { log: false });
    setCameraMode(chapter.cameraMode || 'cinematic');
    recordSystemEvent('trip_3d_chapter_selected', {
      trip_id: trip?.id || null,
      chapter_kind: chapter.kind || 'chapter',
      chapter_label: chapter.label || null,
      elapsed_seconds: Math.round(elapsed),
      camera_mode: chapter.cameraMode || 'cinematic',
    }, {
      category: 'user_action',
      title: '3D drive chapter selected',
    });
  };

  const toggleDisplayMode = () => {
    setDisplayMode((value) => {
      const currentIndex = ROUTE_VISUAL_MODES.findIndex((mode) => mode.id === value);
      const next = ROUTE_VISUAL_MODES[(currentIndex + 1) % ROUTE_VISUAL_MODES.length].id;
      recordSystemEvent('trip_3d_color_mode_changed', {
        trip_id: trip?.id || null,
        color_mode: next,
      }, {
        category: 'user_action',
        title: '3D route color changed',
      });
      return next;
    });
  };

  const toggleDirector = () => {
    setDirectorEnabled((value) => !value);
    setCameraMode('chase');
    setDirectorEnabled(false);
  };

  const cycleTheme = () => {
    setThemeIdx((value) => (value + 1) % SCENE_THEMES.length);
  };

  const toggleSound = async () => {
    const active = audioRef.current;
    if (active) {
      audioRef.current = null;
      setSoundEnabled(false);
      try {
        await active.context.close();
      } catch {
        // The context may already be closed by the browser lifecycle.
      }
      return;
    }

    try {
      const browserWindow = /** @type {Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }} */ (window);
      const AudioContextCtor = browserWindow.AudioContext || browserWindow.webkitAudioContext;
      if (!AudioContextCtor) return;
      const context = new AudioContextCtor({ latencyHint: 'interactive' });
      const engine = context.createOscillator();
      const harmonic = context.createOscillator();
      const engineGain = context.createGain();
      const harmonicGain = context.createGain();
      const filter = context.createBiquadFilter();
      const compressor = context.createDynamicsCompressor();
      const gain = context.createGain();
      engine.type = 'sine';
      engine.frequency.value = 38;
      harmonic.type = 'triangle';
      harmonic.frequency.value = 76;
      engineGain.gain.value = 0.78;
      harmonicGain.gain.value = 0.12;
      filter.type = 'lowpass';
      filter.frequency.value = 220;
      filter.Q.value = 0.7;
      compressor.threshold.value = -28;
      compressor.knee.value = 20;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.02;
      compressor.release.value = 0.24;
      gain.gain.value = 0.002;
      engine.connect(engineGain);
      harmonic.connect(harmonicGain);
      engineGain.connect(filter);
      harmonicGain.connect(filter);
      filter.connect(compressor);
      compressor.connect(gain);
      gain.connect(context.destination);
      engine.start();
      harmonic.start();
      await context.resume();
      audioRef.current = { context, engine, harmonic, filter, compressor, gain };
      setSoundEnabled(true);
    } catch (error) {
      logSystemFailure('trip_3d_local_audio', error, { trip_id: trip?.id || null });
      setSoundEnabled(false);
    }
  };

  const toggleFullscreen = async () => {
    const shell = shellRef.current;
    if (!shell) return;
    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen?.();
      } else {
        await shell.requestFullscreen?.();
      }
    } catch (error) {
      logSystemFailure('trip_3d_fullscreen', error, { trip_id: trip?.id || null });
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        seekToElapsed(elapsedRef.current - 10, { log: false });
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        seekToElapsed(elapsedRef.current + 10, { log: false });
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        toggleFullscreen();
      } else if (/^[1-7]$/.test(event.key)) {
        const mode = CAMERA_MODES[Number(event.key) - 1];
        if (mode) setCameraModeWithLog(mode.id);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

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
    <div ref={shellRef} className={`space-y-3 ${fullscreen ? 'overflow-auto bg-slate-950 p-3' : ''}`}>
      <div
        ref={containerRef}
        className="relative overflow-hidden rounded-2xl border border-border bg-slate-950 shadow-sm"
        style={{ height: fullscreen ? 'calc(100dvh - 14rem)' : height }}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />

        {contextLost && (
          <div className="absolute inset-0 z-20 grid place-items-center bg-slate-950/85 px-6 text-center text-sm font-semibold text-white backdrop-blur-sm">
            Restoring the 3D graphics context…
          </div>
        )}

        {playbackPosition.isGap && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-slate-950/38">
            <div className="rounded-full border border-amber-300/30 bg-amber-400/15 px-4 py-2 text-xs font-bold text-amber-100 backdrop-blur">
              GPS gap — continuing at the next recorded point
            </div>
          </div>
        )}

        {miniMap && (
          <div
            data-testid="trip-3d-minimap"
            className="pointer-events-none absolute bottom-3 right-3 z-[5] hidden w-36 rounded-xl border border-white/10 bg-slate-950/72 p-2 shadow backdrop-blur sm:block"
          >
            <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-slate-300">Route position</div>
            <svg viewBox="0 0 100 60" className="h-16 w-full" role="img" aria-label="3D replay route overview">
              {miniMap.paths.map((path, index) => (
                <polyline
                  key={index}
                  points={path.map((point) => `${point.x},${point.y}`).join(' ')}
                  fill="none"
                  stroke="#60a5fa"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {currentMiniPoint && <circle cx={currentMiniPoint.x} cy={currentMiniPoint.y} r="3.2" fill="#f8fafc" stroke="#2563eb" strokeWidth="1.8" />}
            </svg>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-2 top-2 grid grid-cols-4 gap-1.5 sm:inset-x-3 sm:top-3 sm:gap-2">
          <div className="min-w-0 rounded-lg border border-white/10 bg-slate-950/78 px-2 py-1.5 text-white shadow backdrop-blur sm:rounded-xl sm:px-3 sm:py-2">
            <div className="flex min-w-0 items-center gap-1 text-[8px] font-semibold uppercase tracking-normal text-slate-300 sm:text-[10px]">
              <Gauge className="h-3 w-3" /> Speed
            </div>
            <div className="truncate font-grotesk text-sm font-bold sm:text-lg">{formatSpeed(currentSpeedKmh)}</div>
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
          <div
            className="pointer-events-none absolute right-3 top-[5.5rem] max-w-[min(20rem,calc(100%-1.5rem))] rounded-full border border-amber-200/80 bg-amber-50/92 px-3 py-1.5 text-[11px] font-semibold text-amber-950 shadow backdrop-blur sm:top-[7.25rem] sm:rounded-xl sm:py-2 sm:text-xs"
            title="Heightened privacy is masking protected route areas before 3D rendering."
          >
            <span className="sm:hidden">Privacy masking active</span>
            <span className="hidden sm:inline">Heightened privacy is masking protected route areas before 3D rendering.</span>
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
              {SPEEDS[speedIdx]}x replay
            </button>
            <button
              type="button"
              onClick={cycleQuality}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/15"
              title="Change 3D render quality"
            >
              <Zap className="h-3.5 w-3.5" />
              {selectedQuality.id === 'auto' ? `Auto · ${effectiveQuality.label}` : selectedQuality.label}
            </button>
            <button
              type="button"
              onClick={toggleDisplayMode}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/15"
              title="Change route coloring"
            >
              <Route className="h-3.5 w-3.5" />
              {ROUTE_VISUAL_MODES.find((mode) => mode.id === displayMode)?.label || 'Speed'}
            </button>
            <button
              type="button"
              onClick={toggleDirector}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-colors ${directorEnabled ? 'bg-violet-500 text-white' : 'bg-white/10 text-white hover:bg-white/15'}`}
              title="Toggle automatic cinematic camera direction"
            >
              <Sparkles className="h-3.5 w-3.5" /> Director
            </button>
            <button
              type="button"
              onClick={cycleTheme}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/15"
              title="Change local scene lighting"
            >
              <Mountain className="h-3.5 w-3.5" /> {sceneTheme.label}
            </button>
            <button
              type="button"
              onClick={toggleSound}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-colors ${soundEnabled ? 'bg-cyan-500 text-slate-950' : 'bg-white/10 text-white hover:bg-white/15'}`}
              title="Toggle locally generated drive audio"
              aria-label={soundEnabled ? 'Disable local drive sound' : 'Enable local drive sound'}
            >
              {soundEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              Sound
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
            <button
              type="button"
              onClick={toggleFullscreen}
              title={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              aria-label={fullscreen ? 'Exit 3D fullscreen' : 'Enter 3D fullscreen'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/15"
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
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
              <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5" title="How quickly the recorded speed is changing">
                {Math.abs(currentDynamics.accelerationKmhPerSecond) < 0.1
                  ? 'Speed steady'
                  : `Speed ${currentDynamics.accelerationKmhPerSecond > 0 ? '+' : ''}${currentDynamics.accelerationKmhPerSecond.toFixed(1)} km/h/s`}
              </span>
              {currentDynamics.overLimitKmh > 0 && (
                <span className="shrink-0 rounded-full bg-red-500/25 px-2 py-0.5 text-red-100">
                  {Math.round(currentDynamics.overLimitKmh)} over
                </span>
              )}
              {measuredFps != null && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-0.5">
                  <Sparkles className="h-3 w-3" /> {measuredFps} FPS
                </span>
              )}
              <span className="ml-auto shrink-0">{Math.round(progress)}%</span>
            </div>
            <div
              aria-label="3D telemetry"
              className="mt-2 grid grid-cols-2 gap-1.5 text-[10px] text-slate-200 sm:grid-cols-5"
            >
              <span className="inline-flex items-center gap-1 rounded-lg bg-white/7 px-2 py-1" title="Forward or braking force. Steady means there is no meaningful speed change.">
                <Activity className="h-3 w-3 text-cyan-300" /> Accel {Math.abs(telemetry.longitudinalG) < 0.01 ? 'steady' : `${telemetry.longitudinalG >= 0 ? '+' : ''}${telemetry.longitudinalG.toFixed(2)} g`}
              </span>
              <span className="rounded-lg bg-white/7 px-2 py-1" title="Side force inferred from the current corner.">Cornering {Math.abs(telemetry.lateralG) < 0.01 ? 'straight' : `${telemetry.lateralG >= 0 ? '+' : ''}${telemetry.lateralG.toFixed(2)} g`}</span>
              <span className="rounded-lg bg-white/7 px-2 py-1" title="The total inferred acceleration and cornering force.">Total force {telemetry.combinedG < 0.01 ? 'low' : `${telemetry.combinedG.toFixed(2)} g`}</span>
              <span className="rounded-lg bg-white/7 px-2 py-1" title="Current GPS altitude when the trip recorded a reliable value.">
                Altitude {currentAltitude == null ? 'not recorded' : `${Math.round(currentAltitude)} m`}
              </span>
              <span className="rounded-lg bg-white/7 px-2 py-1" title="Optimized renders nearby route sections; Full route is shown in overview cameras.">Scene {cameraMode === 'top' || cameraMode === 'free' ? 'full route' : 'optimized'}</span>
            </div>
            {elevationProfile && (
              <div className="mt-2 rounded-lg bg-white/5 px-2 py-1" title={`Elevation ${Math.round(elevationProfile.min)} to ${Math.round(elevationProfile.max)} metres`}>
                <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full" role="img" aria-label="Trip elevation profile">
                  <path d={elevationProfile.path} fill="none" stroke="#38bdf8" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                </svg>
              </div>
            )}
            {replayChapters.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase text-slate-400">
                  <Film className="h-3 w-3" />
                  Drive chapters
                </div>
                <div className="flex gap-1 overflow-x-auto text-[11px] thin-scrollbar">
                  {replayChapters.map((chapter) => (
                    <button
                      key={chapterKey(chapter)}
                      type="button"
                      onClick={() => jumpToChapter(chapter)}
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 font-semibold transition-colors ${
                        Math.abs((Number(chapter.offsetSeconds) || 0) - elapsedSeconds) <= 6
                          ? 'bg-white text-slate-950'
                          : 'bg-white/10 text-white hover:bg-white/15'
                      }`}
                      title={`${chapter.label} at ${formatDuration(Math.round(chapter.offsetSeconds || 0))}`}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: chapter.color }} />
                      {chapter.label}
                      <span className="text-[10px] opacity-70">{chapter.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
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
