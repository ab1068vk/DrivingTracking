// @ts-check
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Camera, Film, Flag, Gauge, LocateFixed, Pause, Play, RotateCcw, Route, SkipBack, Zap } from 'lucide-react';
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
const IDLE_SPEED_KMH = 5;
const ROAD_WIDTH = 2.78;
const ROAD_SHOULDER_WIDTH = 3.84;
const ROAD_EDGE_OFFSET = ROAD_WIDTH * 0.48;
const CAMERA_LOOKAHEAD_SECONDS = 2.2;
const CAMERA_BASE_FOV = 48;
const VISUAL_REFERENCE_SPEED_KMH = 35;
const MIN_VISUAL_PLAYBACK_RATE = 0.22;
const MAX_VISUAL_PLAYBACK_RATE = 3.1;
const SPEED_TRAIL_MIN_KMH = 32;
const SPEED_TRAIL_FULL_KMH = 95;
const CAMERA_MODES = [
  { id: 'cinematic', label: 'Cinema' },
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

const chapterKey = (chapter) => `${chapter.kind}:${Math.round(chapter.offsetSeconds || 0)}:${chapter.label}`;

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

function visualPlaybackRateForSpeed(speedKmh = 0) {
  const speed = Math.max(0, Number(speedKmh) || 0);
  if (speed <= IDLE_SPEED_KMH) return MIN_VISUAL_PLAYBACK_RATE;
  return clampNumber(speed / VISUAL_REFERENCE_SPEED_KMH, MIN_VISUAL_PLAYBACK_RATE, MAX_VISUAL_PLAYBACK_RATE);
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

function addSegmentBox(scene, {
  from,
  to,
  width,
  height,
  color,
  y,
  roughness = 0.7,
  metalness = 0.02,
  opacity = 1,
}) {
  const length = from.distanceTo(to);
  if (length < 0.08) return null;

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    transparent: opacity < 1,
    opacity,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), material);
  mesh.position.copy(from).lerp(to, 0.5);
  mesh.position.y = y;
  mesh.rotation.y = vectorHeading(from, to);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function addRoadLine(scene, from, to, offset, color, opacity = 0.86) {
  const length = from.distanceTo(to);
  if (length < 0.24) return null;
  const heading = vectorHeading(from, to);
  const right = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)).multiplyScalar(offset);
  const lineFrom = from.clone().add(right);
  const lineTo = to.clone().add(right);
  return addSegmentBox(scene, {
    from: lineFrom,
    to: lineTo,
    width: Math.abs(offset) < 0.1 ? 0.08 : 0.055,
    height: 0.035,
    color,
    y: 0.16,
    roughness: 0.42,
    opacity,
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
    vertices.push(leftPoint.x, y, leftPoint.z, rightPoint.x, y, rightPoint.z);
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

function smoothCenterline(points = [], segmentCount = 0) {
  if (points.length < 3) return points.map((point) => point.clone());
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.35);
  return curve.getPoints(Math.max(points.length - 1, Math.min(900, segmentCount)));
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

function addCurvedRoad(scene, groups = [], colorMode) {
  groups.forEach((group) => {
    const rawPoints = [group[0].from, ...group.map((item) => item.to)];
    const length = rawPoints.reduce((sum, point, index) => (
      index === 0 ? 0 : sum + point.distanceTo(rawPoints[index - 1])
    ), 0);
    const sampleCount = Math.ceil(Math.max(group.length * 1.8, length * 1.1));
    const centerline = smoothCenterline(rawPoints, sampleCount);

    addRouteRibbon(scene, centerline, {
      width: ROAD_SHOULDER_WIDTH,
      y: 0.025,
      color: '#1f2937',
      roughness: 0.82,
    });
    addRouteRibbon(scene, centerline, {
      width: ROAD_WIDTH,
      y: 0.09,
      color: '#263244',
      roughness: 0.72,
    });
    addRouteRibbon(scene, offsetPolyline(centerline, -ROAD_EDGE_OFFSET), {
      width: 0.055,
      y: 0.15,
      color: '#cbd5e1',
      opacity: 0.62,
      roughness: 0.42,
    });
    addRouteRibbon(scene, offsetPolyline(centerline, ROAD_EDGE_OFFSET), {
      width: 0.055,
      y: 0.15,
      color: '#cbd5e1',
      opacity: 0.62,
      roughness: 0.42,
    });

    group.forEach(({ segment, from, to }, index) => {
      const color = colorMode === 'speedLimit' && segment.speedLimitColor
        ? segment.speedLimitColor
        : segment.color || '#3b82f6';
      const overLimit = Number(segment.overLimitKmh) || 0;
      addSegmentBox(scene, {
        from,
        to,
        width: ROAD_WIDTH * 0.84,
        height: 0.026,
        color,
        y: 0.145,
        roughness: 0.62,
        opacity: overLimit > 0 ? 0.76 : 0.45,
      });

      if (overLimit > 10 && from.distanceTo(to) > 0.8) {
        addSegmentBox(scene, {
          from,
          to,
          width: ROAD_WIDTH + 0.3,
          height: 0.02,
          color: '#ef4444',
          y: 0.18,
          roughness: 0.48,
          opacity: 0.2,
        });
      }

      if (index % 2 === 0 && from.distanceTo(to) > 1.2) {
        const heading = vectorHeading(from, to);
        const dashLength = Math.min(2.1, Math.max(0.5, from.distanceTo(to) * 0.34));
        const midpoint = from.clone().lerp(to, 0.5);
        const dashFrom = midpoint.clone().add(new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(-dashLength / 2));
        const dashTo = midpoint.clone().add(new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(dashLength / 2));
        addRoadLine(scene, dashFrom, dashTo, 0, '#f8fafc', 0.9);
      }
    });
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

  const sign = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  );
  sign.position.y = 1.55;
  sign.scale.set(0.95, 0.95, 1);
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

function updateSpeedTrail(trail, scenePoint, heading, speedStrength) {
  if (!trail) return;
  const strength = clampNumber(speedStrength, 0, 1);
  trail.visible = strength > 0.03;
  trail.position.copy(scenePoint);
  trail.position.y = 0.15;
  trail.rotation.set(0, heading, 0);
  trail.scale.set(1 + strength * 0.28, 1, 1 + strength * 0.55);
  trail.children.forEach((mesh, index) => {
    if (mesh.material) {
      const fade = Math.max(0, strength - index * 0.08);
      mesh.material.opacity = (mesh.userData.baseOpacity || 0.15) * fade;
    }
    mesh.position.z = (mesh.userData.baseZ || -2.5) - strength * (0.7 + index * 0.22);
  });
}

function createCarModel() {
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

  group.scale.setScalar(0.92);
  group.position.y = 0.14;
  group.userData.brakeLights = brakeLights;
  return group;
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
  marker.userData.isEventBeacon = true;
  marker.userData.baseScale = severityScale;
  group.add(marker);

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.34 * severityScale, 0.54 * severityScale, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 0.05;
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
  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 0.16, 28),
    new THREE.MeshStandardMaterial({ color: index % 2 ? '#64748b' : '#334155', roughness: 0.7 })
  );
  marker.position.copy(position);
  marker.position.y = 0.16;
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
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const carRef = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const elapsedRef = useRef(0);
  const playingRef = useRef(false);
  const followRef = useRef(true);
  const cameraModeRef = useRef('cinematic');
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
  const [cameraMode, setCameraMode] = useState('cinematic');
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
  const replayChapters = useMemo(() => buildReplayChapters(timeline), [timeline]);
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
  const currentSpeedKmh = speedKmhAtPlaybackPosition(timeline, playbackPosition);
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
    setCameraMode('cinematic');
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

    const camera = new THREE.PerspectiveCamera(CAMERA_BASE_FOV, 1, 0.1, 320);
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
    const animatedEventMeshes = [];
    const roadGroups = projectedRoadGroups(timeline.segments, projection);
    addCurvedRoad(scene, roadGroups, colorMode);
    let lastSignLimit = null;
    let lastSignIndex = -Infinity;
    timeline.segments.forEach((segment, index) => {
      const from = projection.project(segment.from);
      const to = projection.project(segment.to);
      if (!from || !to) return;
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
    timeline.events.slice(0, 120).forEach((event, index) => {
      const group = addEventMarker(scene, projection, event, index);
      group?.traverse((child) => {
        if (child.userData?.isEventBeacon || child.userData?.isEventHalo) animatedEventMeshes.push(child);
      });
    });

    const car = createCarModel();
    carRef.current = car;
    scene.add(car);
    const speedTrail = createSpeedTrail();
    scene.add(speedTrail);

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

    let smoothedHeading = null;
    let smoothedPitch = 0;
    let smoothedRoll = 0;
    let smoothedSteer = 0;
    const smoothedCameraTarget = new THREE.Vector3();
    let hasSmoothedCameraTarget = false;

    const updateCar = (delta = 0) => {
      const position = playbackPositionAtElapsed(points, elapsedRef.current, positionIndex);
      const scenePoint = projection.project(position.point);
      const from = projection.project(points[position.fromIndex]);
      const to = projection.project(points[position.toIndex]);
      if (!scenePoint || !from || !to) return;

      const dynamics = dynamicsAtPlaybackPosition(timeline, position);
      const speed = speedKmhAtPlaybackPosition(timeline, position);
      const speedStrength = speedEffectStrength(speed);
      const lookAheadElapsed = Math.min(
        durationSeconds,
        elapsedRef.current + CAMERA_LOOKAHEAD_SECONDS + Math.min(2.4, speed / 95)
      );
      const lookAheadPosition = playbackPositionAtElapsed(points, lookAheadElapsed, positionIndex);
      const lookAheadPoint = projection.project(lookAheadPosition.point);
      const rawHeading = lookAheadPoint && lookAheadPoint.distanceTo(scenePoint) > 0.28
        ? vectorHeading(scenePoint, lookAheadPoint)
        : vectorHeading(from, to);
      const headingAlpha = dampAlpha(playingRef.current ? 7.2 : 16, delta);
      smoothedHeading = smoothedHeading == null
        ? rawHeading
        : lerpAngleRadians(smoothedHeading, rawHeading, headingAlpha);

      car.position.copy(scenePoint);
      car.position.y = 0.24;
      car.rotation.y = smoothedHeading;
      const turnBank = clampNumber(-dynamics.turnDeltaDegrees / 260, -0.08, 0.08);
      const brakePitch = dynamics.braking ? -0.045 * Math.max(0.25, dynamics.intensity) : 0;
      const accelPitch = dynamics.accelerating ? 0.032 * Math.max(0.2, dynamics.intensity) : 0;
      const bodyAlpha = dampAlpha(10, delta);
      smoothedPitch += ((brakePitch + accelPitch) - smoothedPitch) * bodyAlpha;
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
      updateSpeedTrail(speedTrail, scenePoint, smoothedHeading, speedStrength);
      const targetFov = cameraModeRef.current === 'top'
        ? CAMERA_BASE_FOV
        : CAMERA_BASE_FOV + speedStrength * 5.5;
      if (Math.abs(camera.fov - targetFov) > 0.01) {
        camera.fov += (targetFov - camera.fov) * dampAlpha(5.5, delta);
        camera.updateProjectionMatrix();
      }

      if (followRef.current) {
        const mode = cameraModeRef.current;
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
          ? smoothedCameraTarget.clone().lerp(lookAheadPoint, 0.38)
          : smoothedCameraTarget;
        const cameraTarget = lookTarget.clone().add(new THREE.Vector3(0, 1.2, 0));
        const activeEvent = timeline.events.find((event) => (
          Math.abs((Number(event.offsetSeconds) || 0) - elapsedRef.current) <= 8
        ));
        const eventPoint = activeEvent ? projection.project(activeEvent) : null;
        const cinematicEventFocus = mode === 'cinematic' && eventPoint;
        const desiredTarget = (mode === 'event' || cinematicEventFocus) && eventPoint
          ? eventPoint.clone().add(new THREE.Vector3(0, 1.4, 0))
          : cameraTarget;
        const speedPullback = Math.min(4.5, speed / 28);
        const cinematicSide = Math.sin(elapsedRef.current * 0.18) >= 0 ? 1 : -1;
        const desiredCamera = mode === 'top'
          ? cameraTarget.clone().add(new THREE.Vector3(0, Math.max(24, projection.span * 0.62), 0.1))
          : mode === 'side'
            ? cameraTarget.clone().add(right.multiplyScalar(12 + speedPullback * 0.35)).add(new THREE.Vector3(0, 5.2 + speedPullback * 0.18, 0))
            : mode === 'event' && eventPoint
              ? cameraTarget.clone().add(forward.clone().multiplyScalar(-8 - speedPullback * 0.4)).add(right.multiplyScalar(7)).add(new THREE.Vector3(0, 6.5, 0))
              : mode === 'cinematic' && eventPoint
                ? cameraTarget.clone()
                  .add(forward.clone().multiplyScalar(-8.4 - speedPullback * 0.45))
                  .add(right.multiplyScalar(cinematicSide * (5.8 + dynamics.intensity * 2.4)))
                  .add(new THREE.Vector3(0, 5.7 + dynamics.intensity * 1.6, 0))
                : mode === 'cinematic'
                  ? cameraTarget.clone()
                    .add(forward.clone().multiplyScalar(-9.2 - speedPullback * 0.9))
                    .add(right.multiplyScalar(cinematicSide * (2.8 + Math.min(2.2, Math.abs(dynamics.turnDeltaDegrees) / 16))))
                    .add(new THREE.Vector3(0, 4.8 + speedPullback * 0.16 + dynamics.intensity * 0.7, 0))
              : cameraTarget.clone()
                .add(forward.clone().multiplyScalar(-10.5 - speedPullback))
                .add(new THREE.Vector3(0, 5.6 + speedPullback * 0.22, 0));
        camera.position.lerp(desiredCamera, dampAlpha(mode === 'event' || mode === 'cinematic' ? 5.8 : 4.4, delta));
        controls.target.lerp(desiredTarget, dampAlpha(mode === 'event' || mode === 'cinematic' ? 7.5 : 6, delta));
      }
    };

    const clock = new THREE.Clock();
    let frameId = 0;
    const animate = () => {
      const delta = Math.min(0.08, clock.getDelta());
      if (playingRef.current) {
        const playbackPosition = playbackPositionAtElapsed(points, elapsedRef.current, positionIndex);
        const speed = speedKmhAtPlaybackPosition(timeline, playbackPosition);
        const visualRate = visualPlaybackRateForSpeed(speed);
        const nextElapsed = Math.min(durationSeconds, elapsedRef.current + delta * speedMultiplierRef.current * visualRate);
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
      const pulse = (Math.sin(performance.now() * 0.0055) + 1) * 0.5;
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
