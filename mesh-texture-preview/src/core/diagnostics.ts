/**
 * Diagnostics: per-triangle distortion metrics, seam consistency, and
 * boundary/manifold analysis.
 *
 * Everything here is a pure function of the MeshDocument — no editor state, no
 * history, no view options. That is what makes export → reload produce the
 * same diagnostics regardless of how the mesh was reached.
 *
 * Topology is derived by *welding vertices by fabric position*, not by vertex
 * index. Using indices would make a split seam impossible: both sides of a
 * seam must be able to carry different UVs at the same fabric point, which in
 * any real UV layout means two vertices at one position. Welding restores the
 * shared edge, while keeping each triangle's own UVs.
 *
 * Weld tolerance is fixed at 1e-6 fabric units, matching the precision used in
 * exports and fingerprints, so welding is identical before and after a reload.
 */

import { cross, dist, len, stableNumber, sub } from './geometry.ts';
import type {
  BoundaryEdge,
  DiagnosticsSnapshot,
  DiagnosticSettings,
  MeshDocument,
  ResolvedSeam,
  SeamDeclaration,
  SeamMetrics,
  SeamSample,
  SeamStatus,
  Triangle,
  TriangleMetrics,
  Vec2,
  Vertex,
} from './types.ts';

/** Number of samples taken along each shared edge. */
export const SEAM_SAMPLE_COUNT = 9;

/** Fabric-space distance within which two vertices are the same point. */
export const WELD_EPSILON = 1e-6;

interface Jacobian {
  /** Columns: d(fabric)/du (a, c) and d(fabric)/dv (b, d). */
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * Solves the texture → fabric affine map of a triangle:
 *   P(u, v) = J · (u, v) + t
 * Returns null when the UV triangle has zero area.
 */
export function triangleJacobian(
  points: readonly [Vec2, Vec2, Vec2],
  uvs: readonly [Vec2, Vec2, Vec2],
): Jacobian | null {
  const [p0, p1, p2] = points;
  const [u0, u1, u2] = uvs;
  const d1 = sub(p1, p0);
  const d2 = sub(p2, p0);
  const e1 = sub(u1, u0);
  const e2 = sub(u2, u0);
  const det = cross(e1, e2);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) return null;
  // [e1 e2] · Jᵀ = [d1 d2]ᵀ, so J's columns are the images of du and dv.
  const inv = 1 / det;
  const ju = { x: (d1.x * e2.y - d2.x * e1.y) * inv, y: (d1.y * e2.y - d2.y * e1.y) * inv };
  const jv = { x: (-d1.x * e2.x + d2.x * e1.x) * inv, y: (-d1.y * e2.x + d2.y * e1.x) * inv };
  return { a: ju.x, b: jv.x, c: ju.y, d: jv.y };
}

/** Singular values of the 2×2 Jacobian (closed form). */
export function singularValues(j: Jacobian): { max: number; min: number; det: number } {
  const det = j.a * j.d - j.b * j.c;
  const s1 = j.a * j.a + j.b * j.b + j.c * j.c + j.d * j.d;
  const disc = Math.max(0, s1 * s1 - 4 * det * det);
  const root = Math.sqrt(disc);
  return {
    max: Math.sqrt(Math.max(0, (s1 + root) / 2)),
    min: Math.sqrt(Math.max(0, (s1 - root) / 2)),
    det,
  };
}

/** Wraps a UV delta into [-0.5, 0.5), matching a repeating texture. */
export function wrapUvDelta(d: Vec2): Vec2 {
  const wrap = (v: number): number => v - Math.floor(v + 0.5);
  return { x: wrap(d.x), y: wrap(d.y) };
}

function uvAt(uv0: Vec2, uv1: Vec2, t: number): Vec2 {
  return { x: uv0.x + (uv1.x - uv0.x) * t, y: uv0.y + (uv1.y - uv0.y) * t };
}

/** Median of a numeric list. */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function triangleMetrics(
  doc: MeshDocument,
  triangleIndex: number,
  settings: DiagnosticSettings,
  referenceStretch = 0,
): TriangleMetrics {
  const tri = doc.triangles[triangleIndex];
  const points: [Vec2, Vec2, Vec2] = [
    doc.vertices[tri.vertices[0]],
    doc.vertices[tri.vertices[1]],
    doc.vertices[tri.vertices[2]],
  ];
  const uvs: [Vec2, Vec2, Vec2] = [tri.uvs[0], tri.uvs[1], tri.uvs[2]];
  const areaFabric = Math.abs(cross(sub(points[1], points[0]), sub(points[2], points[0])) * 0.5);
  const areaTex = Math.abs(cross(sub(uvs[1], uvs[0]), sub(uvs[2], uvs[0])) * 0.5);
  const jacobian = triangleJacobian(points, uvs);

  let stretch = 0;
  let minStretch = 0;
  let determinant = 0;
  if (jacobian) {
    const sv = singularValues(jacobian);
    stretch = sv.max;
    minStretch = sv.min;
    determinant = sv.det;
  }

  const anisotropy = minStretch > 0 ? stretch / minStretch : Number.POSITIVE_INFINITY;
  // Thresholds are relative to the mesh's own median density. Absolute
  // "fabric units per UV unit" depends on how large the mesh was authored.
  const stretchRatio = referenceStretch > 0 ? stretch / referenceStretch : 1;
  const deformation = Math.max(anisotropy, stretchRatio);

  const flipped = jacobian !== null && determinant < 0;
  const collapsed = jacobian === null || minStretch < settings.collapseThreshold;
  const expanded = jacobian !== null && !flipped && deformation > settings.stretchThreshold;
  const compressed =
    jacobian !== null && !flipped && stretchRatio > 0 && stretchRatio < 1 / settings.stretchThreshold;
  const overStretched = expanded || compressed;
  const invalid = flipped || collapsed;

  return {
    id: tri.id,
    uvs,
    points,
    areaTex,
    areaFabric,
    determinant,
    stretch,
    minStretch,
    anisotropy,
    stretchRatio,
    deformation,
    compressed,
    flipped,
    collapsed,
    overStretched,
    invalid,
    bad: invalid || overStretched,
  };
}

/* ------------------------------------------------------------------ welding */

export interface WeldedTopology {
  /** vertex index → weld id. */
  vertexWeld: number[];
  /** weld id → canonical representative vertex index. */
  weldVertex: number[];
  /** weld id → position (representative vertex). */
  weldPosition: Vec2[];
}

/**
 * Welds vertices at identical (6-decimal rounded) positions. Rounding matches
 * the precision used by exports and fingerprints, so welding is the same on
 * both sides of a save/reload.
 */
export function weldTopology(vertices: readonly Vertex[]): WeldedTopology {
  const vertexWeld: number[] = new Array(vertices.length);
  const weldVertex: number[] = [];
  const weldPosition: Vec2[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    const key = `${stableNumber(v.x)}|${stableNumber(v.y)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = weldVertex.length;
      seen.set(key, id);
      weldVertex.push(i);
      weldPosition.push({ x: v.x, y: v.y });
    }
    vertexWeld[i] = id;
  }
  return { vertexWeld, weldVertex, weldPosition };
}

/** Order-independent key for a welded fabric edge. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

interface EdgeSide {
  triangleIndex: number;
  /** Vertex indices within the triangle, ordered (weldA endpoint, weldB endpoint). */
  vertexIndices: [number, number];
}

interface EdgeEntry {
  a: number;
  b: number;
  sides: EdgeSide[];
}

/**
 * Builds the welded edge index. Each edge records which triangle touches it
 * and which of that triangle's vertices sit on each endpoint (they may differ
 * between sides when the seam is split).
 */
export function buildEdgeIndex(
  doc: MeshDocument,
  topology: WeldedTopology = weldTopology(doc.vertices),
): Map<string, EdgeEntry> {
  const edges = new Map<string, EdgeEntry>();
  for (let ti = 0; ti < doc.triangles.length; ti++) {
    const tri = doc.triangles[ti];
    for (let k = 0; k < 3; k++) {
      const va = tri.vertices[k];
      const vb = tri.vertices[(k + 1) % 3];
      const wa = topology.vertexWeld[va];
      const wb = topology.vertexWeld[vb];
      if (wa === wb) continue; // degenerate edge between welded points
      const key = edgeKey(wa, wb);
      let entry = edges.get(key);
      if (!entry) {
        entry = { a: Math.min(wa, wb), b: Math.max(wa, wb), sides: [] };
        edges.set(key, entry);
      }
      entry.sides.push({
        triangleIndex: ti,
        vertexIndices: wa < wb ? [va, vb] : [vb, va],
      });
    }
  }
  return edges;
}

/** UVs along an welded edge from endpoint a to endpoint b, for one triangle. */
function sideUvs(tri: Triangle, vertexIndices: [number, number]): [Vec2, Vec2] {
  const uvAtVertex = (vertexIndex: number): Vec2 => {
    for (let k = 0; k < 3; k++) {
      if (tri.vertices[k] === vertexIndex) return tri.uvs[k];
    }
    throw new Error(`triangle ${tri.id} has no corner for vertex ${vertexIndex}`);
  };
  return [uvAtVertex(vertexIndices[0]), uvAtVertex(vertexIndices[1])];
}

function sharedEdge(a: EdgeEntry | undefined, triA: number, triB: number): [EdgeSide, EdgeSide] | null {
  if (!a) return null;
  const sideA = a.sides.find((s) => s.triangleIndex === triA);
  const sideB = a.sides.find((s) => s.triangleIndex === triB);
  if (!sideA || !sideB) return null;
  return [sideA, sideB];
}

/**
 * Resolves every welded edge shared by exactly two triangles into a seam, and
 * keeps declared seams that have no matching shared edge as explicitly invalid
 * (so a malformed declaration is visible instead of silently dropped).
 */
export function resolveSeams(
  doc: MeshDocument,
  topology: WeldedTopology = weldTopology(doc.vertices),
): ResolvedSeam[] {
  const edges = buildEdgeIndex(doc, topology);
  const indexById = new Map<number, number>();
  for (let i = 0; i < doc.triangles.length; i++) indexById.set(doc.triangles[i].id, i);

  const seams: ResolvedSeam[] = [];
  const covered = new Set<string>();

  for (const declaration of doc.seams) {
    const resolved = resolveSeamDeclaration(doc, declaration, indexById, edges, topology);
    if (resolved) {
      seams.push(resolved);
      covered.add(`${resolved.edgeWelds[0]}:${resolved.edgeWelds[1]}|${Math.min(declaration.triangles[0], declaration.triangles[1])}|${Math.max(declaration.triangles[0], declaration.triangles[1])}`);
    } else {
      seams.push(invalidSeam(doc, declaration, indexById, topology));
    }
  }

  // Undeclared shared edges still get a continuous seam entry, so stitching is
  // checked everywhere — not only where a designer remembered to declare it.
  for (const [, entry] of edges) {
    if (entry.sides.length !== 2) continue;
    const [sideA, sideB] = entry.sides;
    const idA = doc.triangles[sideA.triangleIndex].id;
    const idB = doc.triangles[sideB.triangleIndex].id;
    const key = `${entry.a}:${entry.b}|${Math.min(idA, idB)}|${Math.max(idA, idB)}`;
    if (covered.has(key)) continue;
    const declaration: SeamDeclaration = { id: `edge-${entry.a}-${entry.b}`, triangles: [idA, idB], kind: 'continuous' };
    const resolved = resolveSeamDeclaration(doc, declaration, indexById, edges, topology);
    if (resolved) {
      resolved.declared = false;
      seams.push(resolved);
    }
  }

  return seams;
}

function invalidSeam(
  doc: MeshDocument,
  declaration: SeamDeclaration,
  indexById: Map<number, number>,
  topology: WeldedTopology,
): ResolvedSeam {
  const ia = indexById.get(declaration.triangles[0]);
  const ib = indexById.get(declaration.triangles[1]);
  const triA = ia === undefined ? undefined : doc.triangles[ia];
  const zero: Vec2 = { x: 0, y: 0 };
  const va = triA?.vertices[0] ?? 0;
  const vb = triA?.vertices[1] ?? 0;
  return {
    id: declaration.id,
    kind: declaration.kind,
    declared: true,
    valid: false,
    triangleIndexA: ia ?? -1,
    triangleIndexB: ib ?? -1,
    triangleIdA: declaration.triangles[0],
    triangleIdB: declaration.triangles[1],
    edgeWelds: [topology.vertexWeld[va] ?? 0, topology.vertexWeld[vb] ?? 0],
    edgeVertexA: [va, vb],
    edgeVertexB: [va, vb],
    p0: zero,
    p1: zero,
    uvA: [zero, zero],
    uvB: [zero, zero],
    invalidReason: 'the two triangles do not share a fabric edge',
  };
}

function resolveSeamDeclaration(
  doc: MeshDocument,
  declaration: SeamDeclaration,
  indexById: Map<number, number>,
  edges: Map<string, EdgeEntry>,
  topology: WeldedTopology,
): ResolvedSeam | null {
  const ia = indexById.get(declaration.triangles[0]);
  const ib = indexById.get(declaration.triangles[1]);
  if (ia === undefined || ib === undefined) return null;
  const triA = doc.triangles[ia];
  const triB = doc.triangles[ib];
  if (!triA || !triB) return null;

  // Find welded edges touched by both triangles.
  let found: { entry: EdgeEntry; sideA: EdgeSide; sideB: EdgeSide } | null = null;
  for (const [, entry] of edges) {
    const pair = sharedEdge(entry, ia, ib);
    if (!pair) continue;
    if (found) return null; // triangles share more than one edge: ambiguous
    found = { entry, sideA: pair[0], sideB: pair[1] };
  }
  if (!found) return null;

  return {
    id: declaration.id,
    kind: declaration.kind,
    declared: true,
    valid: true,
    triangleIndexA: ia,
    triangleIndexB: ib,
    triangleIdA: triA.id,
    triangleIdB: triB.id,
    edgeWelds: [found.entry.a, found.entry.b],
    edgeVertexA: found.sideA.vertexIndices,
    edgeVertexB: found.sideB.vertexIndices,
    p0: topology.weldPosition[found.entry.a],
    p1: topology.weldPosition[found.entry.b],
    uvA: sideUvs(triA, found.sideA.vertexIndices),
    uvB: sideUvs(triB, found.sideB.vertexIndices),
  };
}

export function seamMetrics(seam: ResolvedSeam, settings: DiagnosticSettings): SeamMetrics {
  if (!seam.valid) {
    return {
      id: seam.id,
      kind: seam.kind,
      valid: false,
      status: 'invalid',
      triangleIdA: seam.triangleIdA,
      triangleIdB: seam.triangleIdB,
      declared: seam.declared,
      maxSplit: Infinity,
      maxSplitRaw: Infinity,
      repeatMismatch: false,
      meanSplit: Infinity,
      uvLengthA: 0,
      uvLengthB: 0,
      lengthMismatch: 0,
      fabricLength: 0,
      samples: [],
    };
  }

  const samples: SeamSample[] = [];
  let maxSplit = 0;
  let maxSplitRaw = 0;
  let sumSplit = 0;
  for (let i = 0; i < SEAM_SAMPLE_COUNT; i++) {
    const t = i / (SEAM_SAMPLE_COUNT - 1);
    const uA = uvAt(seam.uvA[0], seam.uvA[1], t);
    const uB = uvAt(seam.uvB[0], seam.uvB[1], t);
    const rawDelta = sub(uA, uB);
    const wrapped = wrapUvDelta(rawDelta);
    const splitLength = len(wrapped);
    const rawLength = len(rawDelta);
    samples.push({
      t,
      fabricPoint: {
        x: seam.p0.x + (seam.p1.x - seam.p0.x) * t,
        y: seam.p0.y + (seam.p1.y - seam.p0.y) * t,
      },
      uvA: uA,
      uvB: uB,
      splitDistance: wrapped,
      splitDistanceLength: splitLength,
      rawDistanceLength: rawLength,
    });
    maxSplit = Math.max(maxSplit, splitLength);
    maxSplitRaw = Math.max(maxSplitRaw, rawLength);
    sumSplit += splitLength;
  }

  const uvLengthA = dist(seam.uvA[0], seam.uvA[1]);
  const uvLengthB = dist(seam.uvB[0], seam.uvB[1]);
  const continuous = maxSplit <= settings.seamTolerance;
  // Whole-repeat offsets are visually continuous but still not the same line.
  const repeatMismatch = maxSplitRaw > settings.seamTolerance && continuous;

  let status: SeamStatus;
  if (seam.kind === 'continuous') status = continuous ? 'continuous-ok' : 'accidental-split';
  else status = continuous ? 'split-equal' : 'split-ok';

  return {
    id: seam.id,
    kind: seam.kind,
    valid: true,
    status,
    triangleIdA: seam.triangleIdA,
    triangleIdB: seam.triangleIdB,
    declared: seam.declared,
    maxSplit,
    maxSplitRaw,
    repeatMismatch,
    meanSplit: sumSplit / SEAM_SAMPLE_COUNT,
    uvLengthA,
    uvLengthB,
    lengthMismatch: Math.abs(uvLengthA - uvLengthB),
    fabricLength: dist(seam.p0, seam.p1),
    samples,
  };
}

export function edgeAnalysis(
  doc: MeshDocument,
  topology: WeldedTopology = weldTopology(doc.vertices),
): { boundary: BoundaryEdge[]; nonManifold: number; welds: number } {
  const edges = buildEdgeIndex(doc, topology);
  const boundary: BoundaryEdge[] = [];
  let nonManifold = 0;
  for (const [, entry] of edges) {
    const p0 = topology.weldPosition[entry.a];
    const p1 = topology.weldPosition[entry.b];
    if (entry.sides.length === 1) {
      boundary.push({
        vertices: [entry.a, entry.b],
        p0,
        p1,
        triangleId: doc.triangles[entry.sides[0].triangleIndex].id,
      });
    } else if (entry.sides.length > 2) {
      nonManifold++;
    }
  }
  return { boundary, nonManifold, welds: topology.weldVertex.length };
}

/** Hashable text of geometry, UVs and seam declarations — order independent. */
export function documentFingerprint(doc: MeshDocument): string {
  const v = doc.vertices
    .map((p, i) => `${i}|${stableNumber(p.x)}|${stableNumber(p.y)}${p.pinned ? '|p' : ''}`)
    .join(';');
  const t = [...doc.triangles]
    .sort((x, y) => x.id - y.id)
    .map((tri) => {
      const uvs = tri.uvs.map((uv) => `${stableNumber(uv.x)},${stableNumber(uv.y)}`).join(' ');
      return `${tri.id}|${tri.vertices.join(',')}|${uvs}`;
    })
    .join(';');
  const s = doc.seams
    .map((seam) => `${seam.id}|${seam.triangles.join(',')}|${seam.kind}`)
    .sort()
    .join(';');
  const d = `${doc.diagnostics.stretchThreshold}|${doc.diagnostics.collapseThreshold}|${doc.diagnostics.seamTolerance}`;
  return `v[${v}]t[${t}]s[${s}]d[${d}]`;
}

function diagnosticsFingerprint(
  snapshot: Omit<DiagnosticsSnapshot, 'fingerprint' | 'documentFingerprint'>,
): string {
  const tris = snapshot.triangles
    .map(
      (t) =>
        `${t.id}|${stableNumber(t.determinant)}|${stableNumber(t.stretch)}|${stableNumber(t.minStretch)}|${Number(t.flipped)}${Number(t.collapsed)}${Number(t.overStretched)}`,
    )
    .join(';');
  // Invalid seams have an Infinity max split; the status alone identifies them.
  const seams = snapshot.seams
    .map((s) => `${s.id}|${s.status}|${stableNumber(s.maxSplit)}|${stableNumber(s.lengthMismatch)}`)
    .join(';');
  return `t[${tris}]s[${seams}]`;
}

/** The single entry point used by the renderer, panels and tests. */
export function buildDiagnostics(doc: MeshDocument): DiagnosticsSnapshot {
  const settings = doc.diagnostics;
  const topology = weldTopology(doc.vertices);

  // Two passes: raw Jacobians first, then a mesh-relative reference scale, then
  // classification. Thresholds stay meaningful regardless of authored size.
  const raw = doc.triangles.map((_, i) => triangleMetrics(doc, i, settings, 0));
  const reference = medianOf(raw.filter((m) => m.determinant > 0).map((m) => m.stretch));
  const triangles = doc.triangles.map((_, i) => triangleMetrics(doc, i, settings, reference));
  const triangleById = new Map<number, TriangleMetrics>();
  for (let i = 0; i < triangles.length; i++) triangleById.set(doc.triangles[i].id, triangles[i]);

  const resolved = resolveSeams(doc, topology);
  const seams = resolved.map((seam) => seamMetrics(seam, settings));
  const seamById = new Map<string, SeamMetrics>();
  for (const seam of seams) seamById.set(seam.id, seam);

  const { boundary, nonManifold, welds } = edgeAnalysis(doc, topology);

  let flipped = 0;
  let collapsed = 0;
  let overStretched = 0;
  let invalid = 0;
  for (const tri of triangles) {
    if (tri.flipped) flipped++;
    if (tri.collapsed) collapsed++;
    if (tri.overStretched) overStretched++;
    if (tri.invalid) invalid++;
  }

  const partial = {
    triangles,
    triangleById,
    seams,
    seamById,
    boundaryEdges: boundary.length,
    nonManifoldEdges: nonManifold,
    weldedVertices: welds,
    flippedTriangles: flipped,
    collapsedTriangles: collapsed,
    overStretchedTriangles: overStretched,
    invalidTriangles: invalid,
    accidentalSplits: seams.filter((s) => s.status === 'accidental-split').length,
    invalidSeams: seams.filter((s) => s.status === 'invalid').length,
    splitSeams: resolved.filter((s) => s.kind === 'split').length,
    continuousSeams: resolved.filter((s) => s.kind === 'continuous').length,
    referenceStretch: reference,
  };

  return {
    ...partial,
    fingerprint: diagnosticsFingerprint(partial),
    documentFingerprint: documentFingerprint(doc),
  };
}

