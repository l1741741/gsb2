/**
 * Cross-checking import: validates JSON documents, and compares any embedded
 * export-time diagnostics against freshly recomputed ones.
 *
 * A round-trip (export → reload) is considered faithful when:
 *   1. geometry + UVs + seam declarations hash identically
 *      (documentFingerprint), and
 *   2. diagnostics recomputed from that geometry hash identically to the
 *      diagnostics recorded at export (diagnosticsFingerprint).
 *
 * Case 2 is redundant when case 1 holds, but checking both catches a document
 * edited outside this tool (geometry changed but stale diagnostics kept).
 */

import { normalizeDocument, MeshFormatError } from './document.ts';
import { buildDiagnostics, documentFingerprint } from './diagnostics.ts';
import { parseMeshText, parseObj, parseFabricMesh } from './formats.ts';
import type { DiagnosticsSnapshot, MeshDocument } from './types.ts';

export interface ImportReport {
  document: MeshDocument;
  summary: string;
  /** Diagnostics computed from the imported geometry (always fresh). */
  computed: DiagnosticsSnapshot;
  /** True when the document carried no export-time diagnostics to compare. */
  hadExportedDiagnostics: boolean;
  /** Differences between recorded and recomputed fingerprints, if any. */
  mismatches: string[];
  /** Fingerprint of the document as imported. */
  documentFingerprint: string;
}

export function importMeshJson(json: string, fileName: string): ImportReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new MeshFormatError([`${fileName}: not valid JSON (${(error as Error).message})`]);
  }
  return reportDocument(normalizeDocument(parsed), `${fileName}: fabric-mesh-preview JSON`);
}

export function importMeshText(text: string, fileName: string): ImportReport {
  const source = parseMeshText(text, fileName);
  return reportDocument(source.document, `${fileName}: ${source.summary}`);
}

export function reportDocument(document: MeshDocument, summary: string): ImportReport {
  const computed = buildDiagnostics(document);
  const mismatches: string[] = [];
  const exported = document.exported;
  if (exported) {
    if (exported.documentFingerprint !== computed.documentFingerprint) {
      mismatches.push(
        'geometry/UV/seam fingerprint differs from the value recorded at export',
      );
    }
    if (exported.diagnosticsFingerprint !== computed.fingerprint) {
      mismatches.push('diagnostics differ from the values recorded at export');
    }
    if (exported.flippedTriangles !== computed.flippedTriangles) {
      mismatches.push(
        `flipped triangle count: recorded ${exported.flippedTriangles}, recomputed ${computed.flippedTriangles}`,
      );
    }
    if (exported.splitSeams !== computed.splitSeams) {
      mismatches.push(`split seam count: recorded ${exported.splitSeams}, recomputed ${computed.splitSeams}`);
    }
  }
  return {
    document,
    summary,
    computed,
    hadExportedDiagnostics: Boolean(exported),
    mismatches,
    documentFingerprint: computed.documentFingerprint,
  };
}

export { parseObj, parseFabricMesh, documentFingerprint };
