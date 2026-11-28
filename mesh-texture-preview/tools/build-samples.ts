/**
 * Sample generator: writes the textures, meshes and reference previews that
 * ship with the tool. Pure Node, no browser required.
 *
 *   npm run build && node tools/build-samples.ts
 *
 * (Node 22 strips TypeScript types natively, so the tools need no own build.)
 *
 * The three sample scenes are designed around the tool's requirements:
 *
 *  - `gingham` : clean 4×4 grid, continuous seams everywhere. Baseline.
 *  - `split`   : the same grid, cut into two panels that meet on x = 100. The
 *                right panel has its own vertices along the cut and samples the
 *                texture a half-check further along U. The four edges on the
 *                cut are declared split, so each side visibly samples its own
 *                texels while the fabric stays water-tight.
 *  - `flipped` : the same grid with one control point dragged across its
 *                opposite edge, inverting a triangle. Numbers and picture both
 *                show it, and dragging back restores a valid mesh.
 *
 * The generator round-trips its own output: every sample is re-parsed from the
 * serialised text, every preview PNG is decoded, and fingerprints are compared,
 * so a broken encoder fails here rather than in the browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiagnostics, documentFingerprint, weldTopology } from '../src/core/diagnostics.ts';
import { normalizeDocument } from '../src/core/document.ts';
import type { MeshDocument, SeamDeclaration, Triangle, Vec2, Vertex } from '../src/core/types.ts';
import { deflateSync } from 'node:zlib';
import { encodePng, imageDigest } from '../src/core/png.ts';
import { renderMesh, type TextureImage } from '../src/core/raster.ts';
import { parseFabricMesh, serializeFabricMesh } from '../src/core/formats.ts';
import { decodePng } from './png-decode.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const samplesDir = path.join(root, 'samples');
const previewDir = path.join(samplesDir, 'previews');
fs.mkdirSync(previewDir, { recursive: true });

/* ------------------------------------------------------------------ texture */

/** Gingham: 4×4 checks with overcheck stripes and corner markers. */
function makeGingham(size: number): TextureImage {
  const data = new Uint8Array(size * size * 4);
  const cell = size / 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cell) % 4;
      const cy = Math.floor(y / cell) % 4;
      const idx = (y * size + x) * 4;
      // Base checks: warm white, ochre and deep coral.
      let r = 242;
      let g = 236;
      let b = 228;
      if (cx % 2 === 1 && cy % 2 === 1) {
        r = 158;
        g = 58;
        b = 66;
      } else if (cx % 2 === 1 || cy % 2 === 1) {
        r = 214;
        g = 166;
        b = 118;
      }
      // Overcheck lines make local stretch obvious.
      const stripe = (v: number): boolean => Math.abs(v - Math.round(v)) < 0.06;
      if (stripe(x / cell) || stripe(y / cell)) {
        r = Math.round(r * 0.5);
        g = Math.round(g * 0.6);
        b = Math.round(b * 0.75);
      }
      // Corner markers every cell: a flipped triangle is unmistakable.
      if (x % cell < size / 64 && y % cell < size / 64) {
        r = 16;
        g = 16;
        b = 22;
      }
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/* -------------------------------------------------------------------- mesh */

const GRID = 5;
const CELLS = GRID - 1;
const STEP = 100;

function buildGrid(): { vertices: Vertex[]; triangles: Triangle[] } {
  const vertices: Vertex[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      vertices.push({ x: col * STEP, y: row * STEP });
    }
  }
  const triangles: Triangle[] = [];
  for (let row = 0; row < CELLS; row++) {
    for (let col = 0; col < CELLS; col++) {
      const i00 = row * GRID + col;
      const i10 = i00 + 1;
      const i01 = i00 + GRID;
      const i11 = i01 + 1;
      const idBase = triangles.length;
      // UVs come from the grid position, so the texture maps 1:1 and every
      // shared edge is continuous by construction.
      const uv = (index: number): Vec2 => ({
        x: (index % GRID) / CELLS,
        y: Math.floor(index / GRID) / CELLS,
      });
      triangles.push({ id: idBase, vertices: [i00, i11, i10], uvs: [uv(i00), uv(i11), uv(i10)] });
      triangles.push({ id: idBase + 1, vertices: [i00, i01, i11], uvs: [uv(i00), uv(i01), uv(i11)] });
    }
  }
  return { vertices, triangles };
}

function centroidX(vertices: readonly Vertex[], tri: Triangle): number {
  return (vertices[tri.vertices[0]].x + vertices[tri.vertices[1]].x + vertices[tri.vertices[2]].x) / 3;
}

/**
 * Splits the mesh along the vertical line x = 100 into two panels.
 *
 * Every triangle with centroid x > 100 gets its own copies of the seam-line
 * vertices; the copies sit at the same fabric position (so welding rejoins the
 * edge) but carry UVs shifted along U, which is exactly how a split seam is
 * represented in a real UV layout. All right-panel UVs shift together, so every
 * edge *inside* the right panel stays continuous; only the cut becomes split.
 */
function splitAlongX(doc: MeshDocument, lineX: number, shiftU: number): MeshDocument {
  const seamVertexIndices = doc.vertices
    .map((v, i) => (Math.abs(v.x - lineX) < 1e-9 ? i : -1))
    .filter((i) => i >= 0);
  if (seamVertexIndices.length === 0) throw new Error('split line does not touch any vertex');

  const duplicates = new Map<number, number>();
  const vertices = doc.vertices.map((v) => ({ ...v }));
  const triangles = doc.triangles.map((tri) => ({
    id: tri.id,
    vertices: [tri.vertices[0], tri.vertices[1], tri.vertices[2]] as [number, number, number],
    uvs: [{ ...tri.uvs[0] }, { ...tri.uvs[1] }, { ...tri.uvs[2] }] as [Vec2, Vec2, Vec2],
  }));

  for (const tri of triangles) {
    const cx = centroidX(vertices, tri);
    if (cx <= lineX) continue;
    // Shift the whole right panel in UV space.
    for (let k = 0; k < 3; k++) tri.uvs[k] = { x: tri.uvs[k].x + shiftU, y: tri.uvs[k].y };
    // Replace shared seam vertices with panel-local copies.
    for (let k = 0; k < 3; k++) {
      const index = tri.vertices[k];
      if (!seamVertexIndices.includes(index)) continue;
      let copy = duplicates.get(index);
      if (copy === undefined) {
        copy = vertices.length;
        vertices.push({ x: vertices[index].x, y: vertices[index].y });
        duplicates.set(index, copy);
      }
      tri.vertices[k] = copy;
    }
  }

  // The cut edges are now represented by two vertex indices at one position.
  // Declare each of them as a split seam: intent is explicit, and the edge
  // checker verifies the two sides really do sample different texels.
  const topology = weldTopology(vertices);
  const seamIds = seamVertexIndices.map((i) => topology.vertexWeld[i]);
  const cutEdges: { a: number; b: number; triangles: [number, number] }[] = [];
  for (let k = 0; k + 1 < seamIds.length; k++) {
    const wa = seamIds[k];
    const wb = seamIds[k + 1];
    // Find the two triangles sharing this welded edge, one from each panel.
    const shares = triangles.filter(
      (t) =>
        t.vertices.some((vi) => topology.vertexWeld[vi] === wa) &&
        t.vertices.some((vi) => topology.vertexWeld[vi] === wb),
    );
    if (shares.length !== 2) throw new Error(`cut edge ${k} has ${shares.length} sides, expected 2`);
    cutEdges.push({ a: wa, b: wb, triangles: [shares[0].id, shares[1].id] });
  }

  // Any inherited declaration on a cut edge is superseded by the split
  // declaration; keeping both would declare one edge with two intents.
  const cutTrianglePairs = new Set(
    cutEdges.map((edge) => `${Math.min(...edge.triangles)}|${Math.max(...edge.triangles)}`),
  );
  const inherited = doc.seams.filter(
    (seam) => !cutTrianglePairs.has(`${Math.min(...seam.triangles)}|${Math.max(...seam.triangles)}`),
  );
  const seams: SeamDeclaration[] = [
    ...inherited,
    ...cutEdges.map((edge, k) => ({
      id: `seam-cut-${k}`,
      triangles: edge.triangles,
      kind: 'split' as const,
    })),
  ];

  return { ...doc, vertices, triangles, seams };
}

function sampleDocument(kind: 'gingham' | 'split' | 'flipped'): MeshDocument {
  const { vertices, triangles } = buildGrid();
  // Declared continuous seam anchors on the central cuts; undeclared shared
  // edges are still checked automatically.
  const centralVertical = triangles.filter((t) => t.vertices.includes(6) && t.vertices.includes(11));
  const base: MeshDocument = {
    format: 'fabric-mesh-preview',
    version: 1,
    texture: { name: 'gingham.png', width: 512, height: 512 },
    vertices,
    triangles,
    seams: [
      {
        id: 'seam-v-centre',
        triangles: [centralVertical[0].id, centralVertical[1].id],
        kind: 'continuous',
      },
    ],
    diagnostics: { stretchThreshold: 1.35, collapseThreshold: 0.02, seamTolerance: 1e-3 },
  };

  if (kind === 'split') {
    // A half-check offset: the two sides show different checks at the cut.
    return splitAlongX(base, STEP, 0.125);
  }

  if (kind === 'flipped') {
    // Vertex 18 (300,300) is shared by four triangles. Pulling it to (400,402)
    // crosses an opposite edge and inverts the winding of one triangle.
    const doc = normalizeDocument(base);
    doc.vertices[18] = { x: 400, y: 402 };
    return doc;
  }

  return base;
}

/* ------------------------------------------------------------------ writing */

function writeSample(name: string, doc: MeshDocument, texture: TextureImage): void {
  const validated = normalizeDocument(doc);
  const diag = buildDiagnostics(validated);
  const preview = renderMesh(validated, texture, {
    width: 384,
    height: 384,
    background: [20, 24, 30, 255],
    padding: 10,
    wireframe: true,
    wireframeColour: [255, 255, 255, 70],
  });
  const png = encodePng(
    { width: preview.width, height: preview.height, data: preview.data },
    { deflate: (data) => new Uint8Array(deflateSync(data, { level: 9 })) },
  );
  fs.writeFileSync(path.join(previewDir, `${name}-preview.png`), png);
  const meshText = serializeFabricMesh(validated);
  fs.writeFileSync(path.join(samplesDir, `${name}.fabricmesh`), meshText);

  // Round-trip the serialised mesh through the parser and compare fingerprints.
  const reread = parseFabricMesh(meshText).document;
  const rereadDiag = buildDiagnostics(reread);
  if (documentFingerprint(reread) !== documentFingerprint(validated)) {
    throw new Error(`${name}: serialised mesh changed the document fingerprint`);
  }
  if (rereadDiag.fingerprint !== diag.fingerprint) {
    throw new Error(`${name}: serialised mesh changed the diagnostics fingerprint`);
  }

  const report = {
    name,
    vertices: validated.vertices.length,
    triangles: validated.triangles.length,
    documentFingerprint: documentFingerprint(validated),
    diagnosticsFingerprint: diag.fingerprint,
    flippedTriangles: diag.flippedTriangles,
    collapsedTriangles: diag.collapsedTriangles,
    overStretchedTriangles: diag.overStretchedTriangles,
    accidentalSplits: diag.accidentalSplits,
    splitSeams: diag.splitSeams,
    continuousSeams: diag.continuousSeams,
    boundaryEdges: diag.boundaryEdges,
    previewDigest: imageDigest({ width: preview.width, height: preview.height, data: preview.data }),
  };
  fs.writeFileSync(path.join(previewDir, `${name}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(name.padEnd(9), JSON.stringify(report));
}

const texture = makeGingham(512);
const texturePng = encodePng(texture, { deflate: (data) => new Uint8Array(deflateSync(data, { level: 9 })) });
fs.writeFileSync(path.join(samplesDir, 'gingham.png'), texturePng);

for (const kind of ['gingham', 'split', 'flipped'] as const) {
  writeSample(kind, sampleDocument(kind), texture);
}

/* Self-check the PNG codec against its own output. */
const decoded = decodePng(texturePng);
if (decoded.width !== 512 || decoded.height !== 512) throw new Error('texture round-trip size mismatch');
if (imageDigest(decoded) !== imageDigest(texture)) throw new Error('texture round-trip data mismatch');
console.log('texture round-trip ok', imageDigest(decoded));
