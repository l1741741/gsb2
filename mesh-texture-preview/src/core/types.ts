/**
 * Shared data model for the mesh texture preview tool.
 *
 * Fabric geometry lives in "fabric space": world units, Y pointing down, so
 * the numbers match image pixels and a Y-down screen. Texture coordinates are
 * normalised UV values with V pointing down: U maps to image X, V maps to
 * image Y. Sampling repeats over the unit square, so UVs outside [0, 1] are
 * valid and intentionally wrap (like a repeating fabric print).
 *
 * Split seams use per-corner UVs: two triangles share a fabric edge but each
 * side carries its own texel line along that edge. Continuous seams are
 * checked against the same UV line on both sides; a mismatch that was not
 * declared is reported instead of silently accepted.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** A fabric control point. `pinned` vertices are readable but cannot be dragged. */
export interface Vertex {
  x: number;
  y: number;
  pinned?: boolean;
}

/**
 * A triangle over fabric vertices. `uvs` carries one texture coordinate per
 * corner (same corner order as `vertices`), enabling split seams.
 */
export interface Triangle {
  id: number;
  vertices: [number, number, number];
  uvs: [Vec2, Vec2, Vec2];
}

export type SeamKind = 'continuous' | 'split';

/**
 * A declared seam between two triangles that share a fabric edge.
 *
 * `continuous` declares the intent "both sides sample the same texel line".
 * `split` declares the intent "the two sides deliberately sample different
 * lines", which per-corner UVs make possible. A continuous declaration whose
 * sides differ is reported as an accidental split; a split declaration whose
 * sides happen to coincide is flagged as informational (`split-equal`), so the
 * declared intent is checked rather than assumed.
 */
export interface SeamDeclaration {
  id: string;
  /** Triangle *ids* (not array indices), so a reload does not depend on ordering. */
  triangles: [number, number];
  kind: SeamKind;
}

export interface DiagnosticSettings {
  /** Maximum singular value of the texture->fabric Jacobian before flagging stretch. */
  stretchThreshold: number;
  /** Minimum singular value below which a triangle is considered collapsed. */
  collapseThreshold: number;
  /** Wrapped UV distance that still counts as "the same line" for a seam. */
  seamTolerance: number;
}

/**
 * Diagnostics recorded at export time. These are informational: importers
 * recompute diagnostics from geometry and only compare against this block, so
 * a tampered or stale block is reported instead of trusted.
 */
export interface ExportedDiagnostics {
  tool: string;
  exportedAt: string;
  documentFingerprint: string;
  diagnosticsFingerprint: string;
  triangleCount: number;
  flippedTriangles: number;
  collapsedTriangles: number;
  overStretchedTriangles: number;
  accidentalSplits: number;
  splitSeams: number;
  textureDigest: string | null;
}

export interface MeshDocument {
  format: 'fabric-mesh-preview';
  version: 1;
  /** Source texture description so an exported mesh is self-describing. */
  texture: { name: string; width: number; height: number; digest?: string };
  vertices: Vertex[];
  triangles: Triangle[];
  seams: SeamDeclaration[];
  diagnostics: DiagnosticSettings;
  /** Present only on exported documents; recomputed diagnostics are compared to it. */
  exported?: ExportedDiagnostics;
}

/** A resolved seam: declaration or shared edge plus derived fabric/UV side data. */
export interface ResolvedSeam {
  id: string;
  kind: SeamKind;
  declared: boolean;
  valid: boolean;
  /** Indices into MeshDocument.triangles. */
  triangleIndexA: number;
  triangleIndexB: number;
  /** Triangle ids (stable across a save/reload). */
  triangleIdA: number;
  triangleIdB: number;
  /**
   * Welded edge endpoints (weld ids), ascending. Welding is by fabric
   * position, so a split seam's two sides share these ids while keeping
   * different vertex indices and UVs.
   */
  edgeWelds: [number, number];
  /** Vertex indices used by side A (triangle A) for the two endpoints. */
  edgeVertexA: [number, number];
  /** Vertex indices used by side B (triangle B) for the two endpoints. */
  edgeVertexB: [number, number];
  p0: Vec2;
  p1: Vec2;
  /** UV line used by triangle A, from p0 to p1. */
  uvA: [Vec2, Vec2];
  /** UV line used by triangle B, from p0 to p1. */
  uvB: [Vec2, Vec2];
  invalidReason?: string;
}

export interface BoundaryEdge {
  vertices: [number, number];
  p0: Vec2;
  p1: Vec2;
  triangleId: number;
}

export interface TriangleMetrics {
  id: number;
  /** Corner UVs as authored, for the local inspector. */
  uvs: [Vec2, Vec2, Vec2];
  /** Corner fabric positions as authored, for the local inspector. */
  points: [Vec2, Vec2, Vec2];
  /** Texture-space area, |det(UV)| / 2. */
  areaTex: number;
  /** Fabric-space area, |det(P)| / 2. */
  areaFabric: number;
  /** det of the texture->fabric Jacobian; negative means inverted winding. */
  determinant: number;
  /** Largest singular value of the Jacobian, in fabric units per UV unit. */
  stretch: number;
  /** Smallest singular value. */
  minStretch: number;
  /** sv.max / sv.min: shape distortion from shearing, 1 = conformal. */
  anisotropy: number;
  /** sv.max relative to the mesh median sv.max; 1 = typical density. */
  stretchRatio: number;
  /** max(anisotropy, stretchRatio): what the over-stretch flag tests. */
  deformation: number;
  /** True when the density is below the median by the inverse threshold. */
  compressed: boolean;
  flipped: boolean;
  collapsed: boolean;
  overStretched: boolean;
  /** Flipped or collapsed: geometry that cannot be trusted, hidable while editing. */
  invalid: boolean;
  /** Any diagnostic flag set. */
  bad: boolean;
}

export type SeamStatus =
  | 'continuous-ok'
  | 'accidental-split'
  | 'split-ok'
  | 'split-equal'
  | 'invalid';

export interface SeamSample {
  /** Position along the shared fabric edge from p0, in [0, 1]. */
  t: number;
  fabricPoint: Vec2;
  uvA: Vec2;
  uvB: Vec2;
  /** Wrapped UV-space distance as sampled with a repeating texture. */
  splitDistance: Vec2;
  splitDistanceLength: number;
  /** Raw UV-space distance without wrapping (exposes whole-repeat offsets). */
  rawDistanceLength: number;
}

export interface SeamMetrics {
  id: string;
  kind: SeamKind;
  valid: boolean;
  status: SeamStatus;
  /** The two triangle ids sharing this seam (stable across a save/reload). */
  triangleIdA: number;
  triangleIdB: number;
  declared: boolean;
  /** Max wrapped UV distance between the two sides. */
  maxSplit: number;
  /** Max raw UV distance between the two sides (whole repeats not folded). */
  maxSplitRaw: number;
  /** Sides sit a whole repeat apart: visually continuous, but not the same UV line. */
  repeatMismatch: boolean;
  /** Mean wrapped UV distance between the two sides. */
  meanSplit: number;
  /** Texture-space length of side A's UV line. */
  uvLengthA: number;
  /** Texture-space length of side B's UV line. */
  uvLengthB: number;
  /** |uvLengthA - uvLengthB|: how differently the two sides traverse the texture. */
  lengthMismatch: number;
  /** Fabric-space length of the shared edge. */
  fabricLength: number;
  samples: SeamSample[];
}

export interface DiagnosticsSnapshot {
  triangles: TriangleMetrics[];
  triangleById: Map<number, TriangleMetrics>;
  seams: SeamMetrics[];
  seamById: Map<string, SeamMetrics>;
  boundaryEdges: number;
  nonManifoldEdges: number;
  /** Distinct fabric positions after welding; can exceed the input vertex count only via identical points. */
  weldedVertices: number;
  flippedTriangles: number;
  collapsedTriangles: number;
  overStretchedTriangles: number;
  invalidTriangles: number;
  accidentalSplits: number;
  invalidSeams: number;
  splitSeams: number;
  continuousSeams: number;
  /** Median sv.max of non-inverted triangles; thresholds are relative to it. */
  referenceStretch: number;
  /** Stable fingerprint of geometry, seams and diagnostics, for round-trip checks. */
  fingerprint: string;
  /** Same hash without diagnostics: identifies the mesh/UV state alone. */
  documentFingerprint: string;
}

export type BadPatchMode = 'retain' | 'disable';

export type ViewChannel = 'texture' | 'stretch' | 'wireframe';

export interface ViewOptions {
  channel: ViewChannel;
  showGrid: boolean;
  showBoundary: boolean;
  showSeams: boolean;
  showHandles: boolean;
  showUvLabels: boolean;
  badPatchMode: BadPatchMode;
}

export interface Selection {
  kind: 'none' | 'vertex' | 'triangle' | 'seam';
  vertex?: number;
  triangle?: number;
  seam?: string;
}
