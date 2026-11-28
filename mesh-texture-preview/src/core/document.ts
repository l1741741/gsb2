/**
 * Validation and normalisation for MeshDocument.
 *
 * The importer accepts both JSON documents and 2D triangle-mesh text formats
 * (OBJ with v/vt/f, and a compact "fabricmesh" text format used by the
 * samples). Validation is strict enough to make exports round-trip, and it
 * never silently repairs structure: unrepairable documents throw a
 * MeshFormatError listing every problem found.
 */

import type {
  DiagnosticSettings,
  MeshDocument,
  SeamDeclaration,
  SeamKind,
  Triangle,
  Vec2,
  Vertex,
} from './types.ts';

export class MeshFormatError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`mesh import failed:\n- ${problems.join('\n- ')}`);
    this.name = 'MeshFormatError';
    this.problems = problems;
  }
}

export const DEFAULT_DIAGNOSTICS: DiagnosticSettings = {
  stretchThreshold: 1.35,
  collapseThreshold: 0.02,
  seamTolerance: 1e-3,
};

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

function checkVec2(value: unknown, path: string, problems: string[]): Vec2 {
  if (!value || typeof value !== 'object') {
    problems.push(`${path}: expected {x, y}`);
  } else {
    const v = value as { x?: unknown; y?: unknown };
    if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y)) {
      problems.push(`${path}: x and y must be finite numbers`);
      return { x: 0, y: 0 };
    }
    return { x: v.x, y: v.y };
  }
  return { x: 0, y: 0 };
}

function checkInteger(value: unknown, path: string, problems: string[], min = 0): number {
  if (!Number.isInteger(value) || (value as number) < min) {
    problems.push(`${path}: expected an integer >= ${min}`);
    return 0;
  }
  return value as number;
}

function checkKind(value: unknown, path: string, problems: string[]): SeamKind {
  if (value !== 'continuous' && value !== 'split') {
    problems.push(`${path}: expected "continuous" or "split"`);
    return 'continuous';
  }
  return value;
}

export interface NormalizeOptions {
  /** Allows a document with zero triangles (used while scaffolding a new mesh). */
  allowEmpty?: boolean;
}

/**
 * Validates and deep-copies a parsed JSON value into a MeshDocument.
 * Structural problems throw; benign gaps (missing diagnostics, missing seam
 * kinds) are filled with documented defaults.
 */
export function normalizeDocument(input: unknown, options: NormalizeOptions = {}): MeshDocument {
  const problems: string[] = [];
  if (!input || typeof input !== 'object') {
    throw new MeshFormatError(['document must be a JSON object']);
  }
  const raw = input as Record<string, unknown>;

  if (raw.format !== 'fabric-mesh-preview') {
    problems.push(`format: expected "fabric-mesh-preview", got ${JSON.stringify(raw.format)}`);
  }
  if (raw.version !== 1) {
    problems.push(`version: expected 1, got ${JSON.stringify(raw.version)}`);
  }

  // Vertex array.
  const rawVertices = raw.vertices;
  if (!Array.isArray(rawVertices)) {
    problems.push('vertices: expected an array');
  }
  const vertices: Vertex[] = Array.isArray(rawVertices)
    ? rawVertices.map((v, i) => {
        const path = `vertices[${i}]`;
        if (!v || typeof v !== 'object') {
          problems.push(`${path}: expected {x, y}`);
          return { x: 0, y: 0 };
        }
        const pos = checkVec2(v, path, problems);
        const result: Vertex = { x: pos.x, y: pos.y };
        const pinned = (v as { pinned?: unknown }).pinned;
        if (pinned !== undefined) {
          if (typeof pinned !== 'boolean') problems.push(`${path}.pinned: expected a boolean`);
          else if (pinned) result.pinned = true;
        }
        return result;
      })
    : [];

  // Triangle array.
  const rawTriangles = raw.triangles;
  if (!Array.isArray(rawTriangles)) {
    problems.push('triangles: expected an array');
  }
  const seenIds = new Set<number>();
  const triangles: Triangle[] = Array.isArray(rawTriangles)
    ? rawTriangles.map((t, i) => {
        const path = `triangles[${i}]`;
        if (!t || typeof t !== 'object') {
          problems.push(`${path}: expected an object`);
          return { id: i, vertices: [0, 0, 0], uvs: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] };
        }
        const tri = t as Record<string, unknown>;
        const id = tri.id === undefined ? i : checkInteger(tri.id, `${path}.id`, problems);
        if (seenIds.has(id)) problems.push(`${path}.id: duplicate triangle id ${id}`);
        seenIds.add(id);

        const v = tri.vertices;
        if (!Array.isArray(v) || v.length !== 3) {
          problems.push(`${path}.vertices: expected three vertex indices`);
        }
        const verts: [number, number, number] = [0, 0, 0];
        if (Array.isArray(v) && v.length === 3) {
          for (let k = 0; k < 3; k++) {
            verts[k] = checkInteger(v[k], `${path}.vertices[${k}]`, problems, 0);
            if (verts[k] >= vertices.length) {
              problems.push(`${path}.vertices[${k}]: index ${verts[k]} is out of range (${vertices.length} vertices)`);
            }
          }
        }
        if (verts[0] === verts[1] || verts[1] === verts[2] || verts[0] === verts[2]) {
          problems.push(`${path}.vertices: triangle uses a repeated vertex`);
        }

        const uv = tri.uvs;
        if (!Array.isArray(uv) || uv.length !== 3) {
          problems.push(`${path}.uvs: expected three texture coordinates`);
        }
        const uvs: [Vec2, Vec2, Vec2] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
        if (Array.isArray(uv) && uv.length === 3) {
          for (let k = 0; k < 3; k++) uvs[k] = checkVec2(uv[k], `${path}.uvs[${k}]`, problems);
        }
        return { id, vertices: verts, uvs };
      })
    : [];

  if (!options.allowEmpty && triangles.length === 0) {
    problems.push('triangles: a mesh needs at least one triangle');
  }

  // Seam declarations.
  const rawSeams = raw.seams ?? [];
  if (!Array.isArray(rawSeams)) {
    problems.push('seams: expected an array');
  }
  const seamIds = new Set<string>();
  const seams: SeamDeclaration[] = Array.isArray(rawSeams)
    ? rawSeams.map((s, i) => {
        const path = `seams[${i}]`;
        if (!s || typeof s !== 'object') {
          problems.push(`${path}: expected an object`);
          return { id: `seam-${i}`, triangles: [0, 0], kind: 'continuous' };
        }
        const seam = s as Record<string, unknown>;
        let id: string;
        if (typeof seam.id === 'string' && seam.id.length > 0) id = seam.id;
        else {
          problems.push(`${path}.id: expected a non-empty string`);
          id = `seam-${i}`;
        }
        if (seamIds.has(id)) problems.push(`${path}.id: duplicate seam id ${JSON.stringify(id)}`);
        seamIds.add(id);

        const trianglesRef = seam.triangles;
        if (!Array.isArray(trianglesRef) || trianglesRef.length !== 2) {
          problems.push(`${path}.triangles: expected two triangle ids`);
        }
        const tris: [number, number] = [0, 0];
        if (Array.isArray(trianglesRef) && trianglesRef.length === 2) {
          for (let k = 0; k < 2; k++) {
            tris[k] = checkInteger(trianglesRef[k], `${path}.triangles[${k}]`, problems, 0);
            if (!seenIds.has(tris[k])) {
              problems.push(`${path}.triangles[${k}]: triangle id ${tris[k]} does not exist`);
            }
          }
          if (tris[0] === tris[1]) problems.push(`${path}.triangles: a seam needs two distinct triangles`);
        }
        const kind = checkKind(seam.kind, `${path}.kind`, problems);
        return { id, triangles: tris, kind };
      })
    : [];

  // Diagnostics settings.
  const rawDiag = raw.diagnostics ?? {};
  const diagnostics: DiagnosticSettings = { ...DEFAULT_DIAGNOSTICS };
  if (rawDiag && typeof rawDiag === 'object') {
    const d = rawDiag as Record<string, unknown>;
    for (const key of ['stretchThreshold', 'collapseThreshold', 'seamTolerance'] as const) {
      if (d[key] === undefined) continue;
      if (!isFiniteNumber(d[key]) || (d[key] as number) <= 0) {
        problems.push(`diagnostics.${key}: expected a positive finite number`);
      } else {
        diagnostics[key] = d[key] as number;
      }
    }
  }

  // Texture description (optional for meshes without a texture).
  const rawTexture = raw.texture ?? {};
  let texture: MeshDocument['texture'] = { name: 'untitled', width: 0, height: 0 };
  if (rawTexture && typeof rawTexture === 'object') {
    const t = rawTexture as Record<string, unknown>;
    const name = typeof t.name === 'string' && t.name.trim() ? t.name.trim() : 'untitled';
    const width = t.width === undefined ? 0 : checkInteger(t.width, 'texture.width', problems, 1);
    const height = t.height === undefined ? 0 : checkInteger(t.height, 'texture.height', problems, 1);
    texture = { name, width, height };
  }

  if (problems.length > 0) throw new MeshFormatError(problems);

  // Export-time diagnostics are compared against recomputed values on import.
  // They are trusted as claims to verify, so malformed claims are dropped
  // rather than rejecting an otherwise valid mesh.
  const exported = normalizeExported(raw.exported);

  return {
    format: 'fabric-mesh-preview',
    version: 1,
    texture,
    vertices,
    triangles,
    seams,
    diagnostics,
    ...(exported ? { exported } : {}),
  };
}

function normalizeExported(value: unknown): MeshDocument['exported'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.documentFingerprint !== 'string' || typeof raw.diagnosticsFingerprint !== 'string') {
    return undefined;
  }
  const num = (key: string): number => (isFiniteNumber(raw[key]) ? (raw[key] as number) : 0);
  return {
    tool: typeof raw.tool === 'string' ? raw.tool : 'unknown',
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    documentFingerprint: raw.documentFingerprint,
    diagnosticsFingerprint: raw.diagnosticsFingerprint,
    triangleCount: num('triangleCount'),
    flippedTriangles: num('flippedTriangles'),
    collapsedTriangles: num('collapsedTriangles'),
    overStretchedTriangles: num('overStretchedTriangles'),
    accidentalSplits: num('accidentalSplits'),
    splitSeams: num('splitSeams'),
    textureDigest: typeof raw.textureDigest === 'string' ? raw.textureDigest : null,
  };
}

/** Fills a missing texture description after the PNG is decoded. */
export function withTextureInfo(doc: MeshDocument, name: string, width: number, height: number): MeshDocument {
  return {
    ...doc,
    texture: {
      name: doc.texture.name === 'untitled' ? name : doc.texture.name,
      width: doc.texture.width || width,
      height: doc.texture.height || height,
    },
  };
}

/** Structural JSON validity checks used on the export path. */
export function assertSerializableDocument(doc: MeshDocument): void {
  const problems: string[] = [];
  for (const [i, v] of doc.vertices.entries()) {
    if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y)) problems.push(`vertices[${i}] is not finite`);
  }
  for (const t of doc.triangles) {
    if (!Number.isInteger(t.id)) problems.push(`triangle id ${String(t.id)} is not an integer`);
    for (const [k, uv] of t.uvs.entries()) {
      if (!isFiniteNumber(uv.x) || !isFiniteNumber(uv.y)) {
        problems.push(`triangle ${t.id} uv[${k}] is not finite`);
      }
    }
  }
  for (const s of doc.seams) {
    if (!Number.isInteger(s.triangles[0]) || !Number.isInteger(s.triangles[1])) {
      problems.push(`seam ${s.id} references a non-integer triangle index`);
    }
  }
  if (problems.length > 0) throw new MeshFormatError(problems);
}
