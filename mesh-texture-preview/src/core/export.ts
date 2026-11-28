/**
 * Export: mesh JSON (with recorded diagnostics) and preview PNG.
 *
 * The exported JSON carries:
 *   - geometry, per-corner UVs, seam declarations, thresholds (everything
 *     needed to rebuild the same fabric, seams and diagnostics);
 *   - `exported`: a diagnostics record from the moment of export.
 *
 * On reload, diagnostics are recomputed from geometry and compared with the
 * record. That makes "same position, same seams, same diagnostics" a checked
 * property rather than an assumption — and it does not depend on the history or
 * the order of edits that produced the mesh.
 */

import { buildDiagnostics, documentFingerprint } from './diagnostics.ts';
import { assertSerializableDocument } from './document.ts';
import { fnv1aBytes } from './hash.ts';
import { encodePng, imageDigest, type RgbaImage } from './png.ts';
import { renderMesh, type RenderResult } from './raster.ts';
import { serializeFabricMesh } from './formats.ts';
import type { ExportedDiagnostics, MeshDocument } from './types.ts';

export const TOOL_VERSION = '1.0.0';

export interface ExportOptions {
  /** Texture digest so a reload can warn when a different PNG is loaded. */
  textureDigest: string | null;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/** Builds the JSON payload for `mesh.json`. */
export function buildMeshJson(doc: MeshDocument, options: ExportOptions): string {
  assertSerializableDocument(doc);
  const diagnostics = buildDiagnostics(doc);
  const exported: ExportedDiagnostics = {
    tool: `mesh-texture-preview ${TOOL_VERSION}`,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    documentFingerprint: diagnostics.documentFingerprint,
    diagnosticsFingerprint: diagnostics.fingerprint,
    triangleCount: doc.triangles.length,
    flippedTriangles: diagnostics.flippedTriangles,
    collapsedTriangles: diagnostics.collapsedTriangles,
    overStretchedTriangles: diagnostics.overStretchedTriangles,
    accidentalSplits: diagnostics.accidentalSplits,
    splitSeams: diagnostics.splitSeams,
    textureDigest: options.textureDigest,
  };
  const payload: MeshDocument = { ...doc, exported };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export interface PreviewExport {
  png: Uint8Array;
  width: number;
  height: number;
  /** Pixel digest; identical across machines because the CPU rasteriser is used. */
  digest: string;
  /** Diagnostics fingerprint at render time. */
  diagnosticsFingerprint: string;
  /** Raster result, kept so callers can also display it. */
  raster: RenderResult;
}

export interface PreviewOptions {
  width?: number;
  height?: number;
  padding?: number;
  /** Skip invalid triangles, matching badPatchMode = 'disable'. */
  skipInvalid?: boolean;
}

/**
 * Renders the deterministic reference preview with the CPU rasteriser, not the
 * GPU view. That keeps the exported image reproducible across machines and
 * independent of the browser's WebGL driver.
 */
export function buildPreview(doc: MeshDocument, texture: RgbaImage, options: PreviewOptions = {}): PreviewExport {
  const diagnostics = buildDiagnostics(doc);
  const invalid = new Set(diagnostics.triangles.filter((t) => t.invalid).map((t) => t.id));
  const raster = renderMesh(
    doc,
    { width: texture.width, height: texture.height, data: texture.data },
    {
      width: options.width ?? 640,
      height: options.height ?? 640,
      padding: options.padding ?? 8,
      background: [18, 22, 28, 255],
      wireframe: true,
      wireframeColour: [255, 255, 255, 90],
      skipInvalid: options.skipInvalid ?? false,
    },
    invalid,
  );
  const image: RgbaImage = { width: raster.width, height: raster.height, data: raster.data };
  return {
    png: encodePng(image),
    width: raster.width,
    height: raster.height,
    digest: imageDigest(image),
    diagnosticsFingerprint: diagnostics.fingerprint,
    raster,
  };
}

/** A `.fabricmesh` text export, useful for diffing meshes in version control. */
export function buildFabricMeshText(doc: MeshDocument): string {
  return serializeFabricMesh(doc);
}

/** Deterministic digest of texture pixels, for the export record. */
export function digestTexture(texture: RgbaImage): string {
  return fnv1aBytes(texture.data);
}

export { documentFingerprint };
