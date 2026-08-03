const EARTH_RADIUS_M = 6371000;

const finitePoint = (point) => (
  point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))
);

const pointsFor = (section = {}) => {
  const candidates = section.sectionPoints || section.points || section.geometry || section.routePoints || [];
  return (Array.isArray(candidates) ? candidates : []).filter(finitePoint).map((point) => ({
    lat: Number(point.lat),
    lng: Number(point.lng),
  }));
};

const radians = (value) => Number(value) * Math.PI / 180;
export const corridorDistanceMeters = (a, b) => {
  if (!finitePoint(a) || !finitePoint(b)) return Infinity;
  const dLat = radians(Number(b.lat) - Number(a.lat));
  const dLng = radians(Number(b.lng) - Number(a.lng));
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const bearing = (a, b) => {
  const y = Math.sin(radians(b.lng - a.lng)) * Math.cos(radians(b.lat));
  const x = Math.cos(radians(a.lat)) * Math.sin(radians(b.lat)) -
    Math.sin(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.cos(radians(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};
const bearingDelta = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b), Math.abs(Math.abs(a - b) - 180));
const authority = (section) => section.source === 'user_confirmed_posted_sign'
  ? 4
  : section.saved
    ? 3
    : section.operational || section.stage === 'operational'
      ? 2
      : 1;
const identity = (section, index) => String(section.id || section.ruleId || section.sectionKey || section.geohash || `edge-${index}`);

export function buildLocalCorridorGraph(sections = []) {
  const nodes = [];
  const edges = [];
  const nodeFor = (point) => {
    let best = null;
    let bestDistance = Infinity;
    nodes.forEach((node) => {
      const distance = corridorDistanceMeters(node, point);
      if (distance < 35 && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    });
    if (best) {
      best.samples += 1;
      return best;
    }
    const node = { id: `node-${nodes.length + 1}`, ...point, samples: 1, edges: [] };
    nodes.push(node);
    return node;
  };

  sections.forEach((section, index) => {
    const points = pointsFor(section);
    if (points.length < 2) return;
    const start = nodeFor(points[0]);
    const end = nodeFor(points[points.length - 1]);
    const middle = points[Math.floor(points.length / 2)];
    const edge = {
      id: identity(section, index),
      section,
      points,
      start,
      end,
      middle,
      bearing: bearing(points[0], points[points.length - 1]),
      limitKmh: Number(section.effectiveLimitKmh ?? section.limitKmh) || null,
      authority: authority(section),
      boundary: false,
      parallelProtected: false,
      duplicateOf: null,
    };
    edges.push(edge);
    start.edges.push(edge);
    end.edges.push(edge);
  });

  nodes.forEach((node) => {
    const limits = node.edges.map((edge) => edge.limitKmh).filter(Number.isFinite);
    const boundary = limits.some((limit) => limits.some((other) => Math.abs(limit - other) >= 10));
    if (boundary) node.edges.forEach((edge) => { edge.boundary = true; });
  });

  for (let leftIndex = 0; leftIndex < edges.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < edges.length; rightIndex += 1) {
      const left = edges[leftIndex];
      const right = edges[rightIndex];
      const sharedNode = left.start === right.start || left.start === right.end || left.end === right.start || left.end === right.end;
      const middleDistance = corridorDistanceMeters(left.middle, right.middle);
      const aligned = bearingDelta(left.bearing, right.bearing) <= 18;
      const sameEndpoints = (
        corridorDistanceMeters(left.points[0], right.points[0]) <= 35 &&
        corridorDistanceMeters(left.points[left.points.length - 1], right.points[right.points.length - 1]) <= 35
      ) || (
        corridorDistanceMeters(left.points[0], right.points[right.points.length - 1]) <= 35 &&
        corridorDistanceMeters(left.points[left.points.length - 1], right.points[0]) <= 35
      );
      if (sameEndpoints && aligned && middleDistance <= 45 && left.limitKmh === right.limitKmh) {
        const winner = left.authority >= right.authority ? left : right;
        const duplicate = winner === left ? right : left;
        duplicate.duplicateOf = winner.id;
        continue;
      }
      if (!sameEndpoints && !sharedNode && aligned && middleDistance <= 75) {
        left.parallelProtected = true;
        right.parallelProtected = true;
      }
    }
  }

  const annotatedSections = edges.map((edge) => ({
    ...edge.section,
    corridorEdgeId: edge.id,
    speedBoundary: edge.boundary,
    parallelProtected: edge.parallelProtected,
    graphDuplicateOf: edge.duplicateOf,
  }));
  const passthrough = sections.filter((section, index) => !edges.some((edge) => edge.id === identity(section, index)));
  return { nodes, edges, sections: [...annotatedSections, ...passthrough] };
}

export function summarizeLocalCorridorGraph(graph = {}) {
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  return {
    corridors: edges.length,
    junctions: (graph.nodes || []).filter((node) => node.edges.length >= 3).length,
    boundaries: edges.filter((edge) => edge.boundary).length,
    parallelProtected: edges.filter((edge) => edge.parallelProtected).length,
    duplicateEvidence: edges.filter((edge) => edge.duplicateOf).length,
  };
}
