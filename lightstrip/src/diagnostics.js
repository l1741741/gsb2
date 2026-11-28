import { angleBetween, cross, distance, dot, lerp, normalize, sub } from './vec3.js';

const EPS = 1e-9;

// --- triangle/triangle intersection (interval method + coplanar fallback) ---

function coplanarOverlap(t1, t2, normal) {
  // Project onto the plane's dominant 2D axes and run edge/edge + containment.
  const axis = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])].indexOf(
    Math.max(Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])),
  );
  const proj = (p) => (axis === 0 ? [p[1], p[2]] : axis === 1 ? [p[0], p[2]] : [p[0], p[1]]);
  const a = t1.map(proj);
  const b = t2.map(proj);
  const segHit = (p1, p2, p3, p4) => {
    const d = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const d1 = d(p3, p4, p1);
    const d2 = d(p3, p4, p2);
    const d3 = d(p1, p2, p3);
    const d4 = d(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (segHit(a[i], a[(i + 1) % 3], b[j], b[(j + 1) % 3])) return true;
    }
  }
  const inside = (p, tri) => {
    let sign = 0;
    for (let i = 0; i < 3; i++) {
      const [x1, y1] = tri[i];
      const [x2, y2] = tri[(i + 1) % 3];
      const c = (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1);
      if (Math.abs(c) < EPS) continue;
      const s = Math.sign(c);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  };
  return inside(a[0], b) || inside(b[0], a);
}

export function trianglesIntersect(t1, t2) {
  const n1 = cross(sub(t1[1], t1[0]), sub(t1[2], t1[0]));
  const n2 = cross(sub(t2[1], t2[0]), sub(t2[2], t2[0]));
  const d1 = t2.map((p) => dot(n1, sub(p, t1[0]))); // t2 vertices vs plane of t1
  const d2 = t1.map((p) => dot(n2, sub(p, t2[0]))); // t1 vertices vs plane of t2
  if (d1.every((d) => d > EPS) || d1.every((d) => d < -EPS)) return false;
  if (d2.every((d) => d > EPS) || d2.every((d) => d < -EPS)) return false;

  const line = cross(n1, n2);
  if (dot(line, line) < 1e-18) {
    // Parallel planes: only coplanar triangles can intersect.
    const nn1 = normalize(n1);
    const nn2 = normalize(n2);
    if (!nn1 || !nn2 || Math.abs(dot(nn1, nn2)) < 0.999999) return false;
    if (Math.abs(d1[0]) > 1e-7 && Math.abs(d1[1]) > 1e-7) return false;
    return coplanarOverlap(t1, t2, nn1);
  }

  const axis = [Math.abs(line[0]), Math.abs(line[1]), Math.abs(line[2])].indexOf(
    Math.max(Math.abs(line[0]), Math.abs(line[1]), Math.abs(line[2])),
  );
  const interval = (tri, dists) => {
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = e;
      const b = (e + 1) % 3;
      const da = dists[a];
      const db = dists[b];
      if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
        pts.push(lerp(tri[a], tri[b], da / (da - db))[axis]);
      } else if (Math.abs(da) <= EPS) {
        pts.push(tri[a][axis]);
      }
    }
    if (pts.length < 2) return null;
    return [Math.min(...pts), Math.max(...pts)];
  };
  const i1 = interval(t1, d2);
  const i2 = interval(t2, d1);
  if (!i1 || !i2) return false;
  return i1[1] >= i2[0] - EPS && i2[1] >= i1[0] - EPS;
}

// Broadphase (sweep on x over triangle AABBs) + exact test. Triangle pairs
// that share a vertex — by index or by position (texture-seam and cap
// vertices are duplicated in place) — are neighbours and are skipped.
export function findSelfIntersections(positions, faces, { maxReported = 20 } = {}) {
  const weldKey = positions.map((p) => p.map((v) => Math.round(v * 1e7)).join(','));
  const welded = faces.map((f) => new Set(f.indices.map((i) => weldKey[i])));
  const boxes = faces.map((f) => {
    const [a, b, c] = f.indices.map((i) => positions[i]);
    return {
      min: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])],
      max: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])],
    };
  });
  const order = faces.map((_, i) => i).sort((p, q) => boxes[p].min[0] - boxes[q].min[0]);
  const pairs = [];
  let count = 0;
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (boxes[j].min[0] > boxes[i].max[0]) break;
      const bi = boxes[i];
      const bj = boxes[j];
      if (
        bj.min[1] > bi.max[1] || bi.min[1] > bj.max[1] ||
        bj.min[2] > bi.max[2] || bi.min[2] > bj.max[2]
      ) continue;
      const fi = faces[i].indices;
      const fj = faces[j].indices;
      if (fi.some((v) => fj.includes(v))) continue;
      if ([...welded[i]].some((k) => welded[j].has(k))) continue;
      const t1 = fi.map((v) => positions[v]);
      const t2 = fj.map((v) => positions[v]);
      if (trianglesIntersect(t1, t2)) {
        count++;
        if (pairs.length < maxReported) {
          pairs.push({ faceA: i, faceB: j, ringA: faces[i].ring, ringB: faces[j].ring });
        }
      }
    }
  }
  return { count, pairs };
}

// Full geometry report: degenerate input, sharp turns, frame reseeds,
// closed-loop twist, bend-radius/fold risk, NaN check, self-intersections.
export function analyzeGeometry({
  positions,
  faces,
  samples,
  tangents,
  widths,
  profile,
  closed,
  degenerateSegments,
  frameEvents,
  twistDegrees,
  sharpTurnDeg = 45,
}) {
  const nanVertices = positions.reduce(
    (acc, p) => acc + (p.every((v) => Number.isFinite(v)) ? 0 : 1),
    0,
  );

  const sharpTurns = [];
  let minBendRadius = Infinity;
  let minBendRadiusSample = -1;
  const foldRisks = [];
  // Open paths have tangents.length - 1 genuine turns; only closed loops wrap.
  const turnCount = closed ? tangents.length : tangents.length - 1;
  for (let i = 0; i < turnCount; i++) {
    const t0 = tangents[i];
    const t1 = tangents[(i + 1) % tangents.length];
    const angle = angleBetween(t0, t1);
    const angleDeg = (angle * 180) / Math.PI;
    if (angleDeg > sharpTurnDeg) sharpTurns.push({ sample: i, angleDeg: Math.round(angleDeg * 10) / 10 });
    if (angle > 1e-9) {
      const chord = distance(samples[i], samples[(i + 1) % samples.length]);
      if (chord > 1e-12) {
        const radius = chord / angle;
        if (radius < minBendRadius) {
          minBendRadius = radius;
          minBendRadiusSample = i;
        }
        // Local half-extent of the scaled profile around the path centre.
        const w = widths[i];
        const halfExtent = Math.max(...profile.map(([px, py]) => Math.hypot(px * w, py)));
        if (radius < halfExtent) {
          foldRisks.push({
            sample: i,
            bendRadius: Math.round(radius * 1000) / 1000,
            profileHalfExtent: Math.round(halfExtent * 1000) / 1000,
          });
        }
      }
    }
  }

  const selfIntersections = findSelfIntersections(positions, faces);

  return {
    closed,
    vertices: positions.length,
    faces: faces.length,
    degenerateSegments,
    frameEvents,
    twistDegrees: closed ? Math.round(twistDegrees * 100) / 100 : 0,
    sharpTurns,
    minBendRadius: Number.isFinite(minBendRadius)
      ? { value: Math.round(minBendRadius * 1000) / 1000, sample: minBendRadiusSample }
      : null,
    foldRisks: foldRisks.slice(0, 20),
    foldRiskCount: foldRisks.length,
    nanVertices,
    selfIntersections,
  };
}

export function formatDiagnostics(d) {
  const lines = [];
  lines.push(`vertices: ${d.vertices}, faces: ${d.faces}, closed: ${d.closed}`);
  const problems = [];
  if (d.nanVertices > 0) problems.push(`${d.nanVertices} non-finite vertices`);
  if (d.degenerateSegments.length > 0) problems.push(`${d.degenerateSegments.length} degenerate control segment(s)`);
  if (d.frameEvents.length > 0) problems.push(`${d.frameEvents.length} frame reseed event(s)`);
  if (d.sharpTurns.length > 0) problems.push(`${d.sharpTurns.length} sharp turn(s)`);
  if (d.foldRiskCount > 0) problems.push(`${d.foldRiskCount} sample(s) where bend radius < profile half-extent (fold risk)`);
  if (d.selfIntersections.count > 0) problems.push(`${d.selfIntersections.count} self-intersecting triangle pair(s)`);
  if (d.closed) lines.push(`closed-loop seam twist distributed: ${d.twistDegrees}°`);
  if (d.minBendRadius) lines.push(`min bend radius: ${d.minBendRadius.value} (sample ${d.minBendRadius.sample})`);
  lines.push(problems.length === 0 ? 'OK: no geometry problems detected' : `PROBLEMS: ${problems.join('; ')}`);
  return lines.join('\n');
}
