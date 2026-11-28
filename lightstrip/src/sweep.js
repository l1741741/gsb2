import { normalizeCase } from './case.js';
import { samplePath } from './path.js';
import { buildFrames } from './frames.js';
import { analyzeGeometry } from './diagnostics.js';
import { triangulatePolygon } from './triangulate.js';
import { cross, sub } from './vec3.js';

// Build the swept mesh for a case definition.
//
// Returns positions / uvs / normals (parallel arrays), faces as
// { indices, material } ('strip' for the swept surface, 'cap' for open-path
// end caps), plus path data for preview markers and a diagnostics report.
export function buildSweep(caseDef) {
  const c = normalizeCase(caseDef);
  const pathData = samplePath(
    c.points.map((p) => p.position),
    { samplesPerSegment: c.samplesPerSegment, closed: c.closed },
  );
  const { samples, sampleSegment, sampleT, arcLengths } = pathData;
  const ringCount = samples.length;

  // Width per sample: linear in the segment parameter between neighbouring
  // control points, hence continuous at every joint by construction.
  const widths = samples.map((_, i) => {
    const k = sampleSegment[i];
    const w0 = c.points[k].width;
    const w1 = c.points[(k + 1) % c.points.length].width;
    return w0 + (w1 - w0) * sampleT[i];
  });

  const frames = buildFrames(samples, { closed: c.closed });

  const prof = c.profile.points;
  const P = prof.length;
  // u follows the unit-profile perimeter so texture seams stay put when the
  // width changes; v follows arc length (scaled by uvScale).
  const perimeter = [0];
  for (let j = 0; j < P; j++) {
    const [x1, y1] = prof[j];
    const [x2, y2] = prof[(j + 1) % P];
    perimeter.push(perimeter[j] + Math.hypot(x2 - x1, y2 - y1));
  }
  const totalPerimeter = perimeter[P];

  const ringSize = P + 1; // extra seam vertex (same position, u = 1)
  const positions = [];
  const uvs = [];
  for (let i = 0; i < ringCount; i++) {
    const ctr = samples[i];
    const n = frames.normals[i];
    const b = frames.binormals[i];
    const w = widths[i];
    for (let j = 0; j <= P; j++) {
      const [px, py] = prof[j % P];
      positions.push([
        ctr[0] + n[0] * px * w + b[0] * py,
        ctr[1] + n[1] * px * w + b[1] * py,
        ctr[2] + n[2] * px * w + b[2] * py,
      ]);
      uvs.push([j === P ? 1 : perimeter[j] / totalPerimeter, arcLengths[i] / c.uvScale]);
    }
  }

  const faces = [];
  const spanCount = c.closed ? ringCount : ringCount - 1;
  for (let i = 0; i < spanCount; i++) {
    const next = (i + 1) % ringCount;
    for (let j = 0; j < P; j++) {
      const a = i * ringSize + j;
      const b = i * ringSize + j + 1;
      const d = next * ringSize + j;
      const e = next * ringSize + j + 1;
      // Winding chosen so face normals point away from the path (outward).
      faces.push({ indices: [a, e, d], material: 'strip', ring: i });
      faces.push({ indices: [a, b, e], material: 'strip', ring: i });
    }
  }

  // Open paths get distinguishable end caps (own material, own vertices so
  // shading stays crisp). Closed loops have no caps and no seam gap.
  // Caps are ear-clipped so concave profiles (e.g. t-profile) triangulate
  // correctly instead of fanning outside the outline.
  if (!c.closed) {
    const capTriangles = triangulatePolygon(prof);
    for (const [ringIndex, forward] of [[0, false], [ringCount - 1, true]]) {
      const base = positions.length;
      for (let j = 0; j < P; j++) {
        positions.push([...positions[ringIndex * ringSize + j]]);
        uvs.push([prof[j][0] + 0.5, prof[j][1]]);
      }
      for (const tri of capTriangles) {
        const [i0, i1, i2] = tri.map((j) => base + j);
        faces.push({ indices: forward ? [i0, i1, i2] : [i0, i2, i1], material: 'cap', ring: ringIndex });
      }
    }
  }

  // Area-weighted vertex normals from face normals.
  const normals = positions.map(() => [0, 0, 0]);
  for (const f of faces) {
    const [ia, ib, ic] = f.indices;
    const fn = cross(sub(positions[ib], positions[ia]), sub(positions[ic], positions[ia]));
    for (const idx of f.indices) {
      normals[idx][0] += fn[0];
      normals[idx][1] += fn[1];
      normals[idx][2] += fn[2];
    }
  }
  for (let i = 0; i < normals.length; i++) {
    const l = Math.hypot(normals[i][0], normals[i][1], normals[i][2]) || 1;
    normals[i] = [normals[i][0] / l, normals[i][1] / l, normals[i][2] / l];
  }
  // Keep the texture seam vertices shaded identically to their twins.
  for (let i = 0; i < ringCount; i++) {
    normals[i * ringSize + P] = [...normals[i * ringSize]];
  }

  const diagnostics = analyzeGeometry({
    positions,
    faces,
    samples,
    tangents: frames.tangents,
    widths,
    profile: prof,
    closed: c.closed,
    degenerateSegments: pathData.degenerateSegments,
    frameEvents: frames.events,
    twistDegrees: frames.twistDegrees,
    sharpTurnDeg: c.sharpTurnDeg,
  });

  return {
    name: c.name,
    closed: c.closed,
    positions,
    uvs,
    normals,
    faces,
    ringCount,
    ringSize,
    pathSamples: samples,
    widths,
    controlPoints: c.points.map((p, i) => ({
      position: p.position,
      width: p.width,
      sampleIndex: pathData.controlIndices[i],
    })),
    diagnostics,
  };
}
