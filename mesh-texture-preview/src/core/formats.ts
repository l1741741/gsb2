/**
 * Mesh text formats.
 *
 * JSON documents are the canonical export. Two text formats are also accepted
 * so the tool can be used with meshes produced elsewhere:
 *
 * 1. OBJ (v / vt / f). Per-corner UVs are inherent to OBJ faces, so split
 *    seams work. Seam intent is carried in comments:
 *        # fabric-seam split 1 2 seam-5
 *        # fabric-seam continuous 3 4
 *    where the numbers are triangle ids (declared after faces are read).
 *
 * 2. fabricmesh (used by the sample files, readable by hand):
 *        # fabric-mesh-preview 1
 *        texture "gingham.png" 512 512
 *        v <x> <y> [pinned]
 *        vt <u> <v>
 *        f <v0>/<vt0> <v1>/<vt1> <v2>/<vt2>        (triangle; id = face order)
 *        seam <kind> <triA> <triB>
 *        diag <stretch> <collapse> <tolerance>
 *
 * Imports are deterministic: the same text always produces the same
 * document, triangle ids and seam ids.
 */

import { MeshFormatError } from './document.ts';
import type { MeshDocument, SeamDeclaration, Triangle, Vec2, Vertex } from './types.ts';

export interface ImportedSource {
  document: MeshDocument;
  /** Human-readable description of what was read, for the UI. */
  summary: string;
}

function parseNumbers(parts: string[], path: string, problems: string[]): number[] | null {
  const values = parts.map((p) => Number.parseFloat(p));
  if (values.some((v) => !Number.isFinite(v))) {
    problems.push(`${path}: expected finite numbers, got "${parts.join(' ')}"`);
    return null;
  }
  return values;
}

/** Reads `f a/b c/d e/f` style corner tokens (1-based OBJ indices). */
function parseObjCorner(token: string): { v: number; vt: number | null } {
  const [vPart, vtPart] = token.split('/');
  const v = Number.parseInt(vPart, 10);
  const vt = vtPart === undefined || vtPart === '' ? null : Number.parseInt(vtPart, 10);
  return { v, vt: vt !== null && Number.isFinite(vt) ? vt : null };
}

export function parseObj(text: string): ImportedSource {
  const problems: string[] = [];
  const vertices: Vertex[] = [];
  const texcoords: Vec2[] = [];
  const triangles: Triangle[] = [];
  const rawSeams: { kind: 'continuous' | 'split'; a: number; b: number; id?: string }[] = [];

  let stretch: number | undefined;
  let collapse: number | undefined;
  let tolerance: number | undefined;
  let textureName: string | undefined;

  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      if (line.startsWith('# fabric-seam')) {
        const parts = line.split(/\s+/);
        // # fabric-seam <kind> <triA> <triB> [id]
        const kind = parts[2];
        if (kind !== 'continuous' && kind !== 'split') {
          problems.push(`line ${lineNo + 1}: fabric-seam kind must be continuous or split`);
          continue;
        }
        const a = Number.parseInt(parts[3] ?? '', 10);
        const b = Number.parseInt(parts[4] ?? '', 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
          problems.push(`line ${lineNo + 1}: fabric-seam needs two triangle ids`);
          continue;
        }
        rawSeams.push({ kind, a, b, id: parts[5] });
      } else if (line.startsWith('# fabric-texture')) {
        textureName = line.slice('# fabric-texture'.length).trim();
      } else if (line.startsWith('# fabric-diag')) {
        const parts = line.split(/\s+/).slice(2);
        [stretch, collapse, tolerance] = [
          Number.parseFloat(parts[0] ?? ''),
          Number.parseFloat(parts[1] ?? ''),
          Number.parseFloat(parts[2] ?? ''),
        ].map((v) => (Number.isFinite(v) ? v : undefined)) as [number | undefined, number | undefined, number | undefined];
      }
      continue;
    }
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') {
      const values = parseNumbers(parts.slice(1, 3), `line ${lineNo + 1}`, problems);
      if (values) vertices.push({ x: values[0], y: values[1] });
      continue;
    }
    if (tag === 'vt') {
      const values = parseNumbers(parts.slice(1, 3), `line ${lineNo + 1}`, problems);
      if (values) texcoords.push({ x: values[0], y: values[1] });
      continue;
    }
    if (tag === 'f') {
      const corners = parts.slice(1).map(parseObjCorner);
      if (corners.length < 3) {
        problems.push(`line ${lineNo + 1}: face needs at least three corners`);
        continue;
      }
      // Fan-triangulate polygons; quads become two triangles with stable ids.
      const base = triangles.length;
      for (let k = 1; k + 1 < corners.length; k++) {
        const ids = [corners[0], corners[k], corners[k + 1]];
        const verts: [number, number, number] = [0, 0, 0];
        const uvs: [Vec2, Vec2, Vec2] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
        for (let c = 0; c < 3; c++) {
          const corner = ids[c];
          const vi = corner.v - 1;
          if (vi < 0 || vi >= vertices.length) {
            problems.push(`line ${lineNo + 1}: vertex index ${corner.v} is out of range`);
          }
          verts[c] = vi;
          if (corner.vt !== null) {
            const ti = corner.vt - 1;
            if (ti < 0 || ti >= texcoords.length) {
              problems.push(`line ${lineNo + 1}: texture index ${corner.vt} is out of range`);
            } else {
              uvs[c] = texcoords[ti];
            }
          }
        }
        triangles.push({ id: base + (k - 1), vertices: verts, uvs });
      }
      continue;
    }
    // Known records that carry no geometry useful here.
    if (tag === 'vn' || tag === 'g' || tag === 'o' || tag === 's' || tag === 'usemtl' || tag === 'mtllib') continue;
    problems.push(`line ${lineNo + 1}: unsupported OBJ record "${tag}"`);
  }

  if (triangles.length === 0) problems.push('OBJ: no faces found');
  if (problems.length > 0) throw new MeshFormatError(problems);

  const seams = buildSeamDeclarations(rawSeams, triangles, problems, 'OBJ');
  if (problems.length > 0) throw new MeshFormatError(problems);

  const document: MeshDocument = {
    format: 'fabric-mesh-preview',
    version: 1,
    texture: {
      name: textureName ?? 'untitled',
      width: 0,
      height: 0,
    },
    vertices,
    triangles,
    seams,
    diagnostics: {
      stretchThreshold: stretch ?? 1.35,
      collapseThreshold: collapse ?? 0.02,
      seamTolerance: tolerance ?? 1e-3,
    },
  };
  return {
    document,
    summary: `OBJ: ${vertices.length} vertices, ${triangles.length} triangles, ${seams.length} declared seam(s)`,
  };
}

function buildSeamDeclarations(
  raw: { kind: 'continuous' | 'split'; a: number; b: number; id?: string }[],
  triangles: Triangle[],
  problems: string[],
  source: string,
): SeamDeclaration[] {
  const ids = new Set(triangles.map((t) => t.id));
  const used = new Set<string>();
  const seams: SeamDeclaration[] = [];
  raw.forEach((entry, index) => {
    if (!ids.has(entry.a) || !ids.has(entry.b)) {
      problems.push(`${source}: seam references unknown triangle id ${ids.has(entry.a) ? entry.b : entry.a}`);
      return;
    }
    let id = entry.id ?? `seam-${index + 1}`;
    if (used.has(id)) {
      problems.push(`${source}: duplicate seam id "${id}"`);
      id = `${id}-${index + 1}`;
    }
    used.add(id);
    seams.push({ id, triangles: [entry.a, entry.b], kind: entry.kind });
  });
  return seams;
}

/** Removes an unquoted trailing comment (`... # note`) from a fabricmesh line. */
function stripInlineComment(line: string): string {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '#' && !inQuotes) return line.slice(0, i);
  }
  return line;
}

export function parseFabricMesh(text: string): ImportedSource {
  const problems: string[] = [];
  const vertices: Vertex[] = [];
  const texcoords: Vec2[] = [];
  const triangles: Triangle[] = [];
  const rawSeams: { kind: 'continuous' | 'split'; a: number; b: number; id?: string }[] = [];
  let texture = { name: 'untitled', width: 0, height: 0 };
  let stretch = 1.35;
  let collapse = 0.02;
  let tolerance = 1e-3;
  let sawMagic = false;

  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo];
    const line = stripInlineComment(rawLine).trim();
    if (!line) {
      if (/^#\s*fabric-mesh-preview\s+1\s*$/.test(rawLine.trim())) sawMagic = true;
      continue;
    }
    // Tokenise, honouring "quoted strings".
    const parts = line.match(/"[^"]*"|\S+/g) ?? [];
    const tag = parts[0];
    const path = `line ${lineNo + 1}`;
    if (tag === 'texture') {
      const namePart = parts[1] ?? '';
      const name = namePart.startsWith('"') ? namePart.slice(1, -1) : namePart;
      const nums = parseNumbers(parts.slice(2, 4), path, problems) ?? [0, 0];
      texture = { name: name || 'untitled', width: nums[0] ?? 0, height: nums[1] ?? 0 };
    } else if (tag === 'diag') {
      const nums = parseNumbers(parts.slice(1, 4), path, problems);
      if (nums) {
        stretch = nums[0];
        collapse = nums[1];
        tolerance = nums[2];
      }
    } else if (tag === 'v') {
      const nums = parseNumbers(parts.slice(1, 3), path, problems);
      if (!nums) continue;
      const vertex: Vertex = { x: nums[0], y: nums[1] };
      if (parts[3] === 'pinned') vertex.pinned = true;
      vertices.push(vertex);
    } else if (tag === 'vt') {
      const nums = parseNumbers(parts.slice(1, 3), path, problems);
      if (nums) texcoords.push({ x: nums[0], y: nums[1] });
    } else if (tag === 'f') {
      const cornerTokens = parts.slice(1);
      if (cornerTokens.length !== 3) {
        problems.push(`${path}: faces must have exactly three corners`);
        continue;
      }
      const verts: [number, number, number] = [0, 0, 0];
      const uvs: [Vec2, Vec2, Vec2] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
      let ok = true;
      cornerTokens.forEach((token, c) => {
        const [vPart, vtPart] = token.split('/');
        const vi = Number.parseInt(vPart, 10);
        const ti = Number.parseInt(vtPart ?? '', 10);
        if (!Number.isFinite(vi) || vi < 0 || vi >= vertices.length) {
          problems.push(`${path}: vertex index ${vPart} is out of range`);
          ok = false;
        } else {
          verts[c] = vi;
        }
        if (!Number.isFinite(ti) || ti < 0 || ti >= texcoords.length) {
          problems.push(`${path}: texture index ${String(vtPart)} is out of range`);
          ok = false;
        } else {
          uvs[c] = texcoords[ti];
        }
      });
      if (ok) triangles.push({ id: triangles.length, vertices: verts, uvs });
    } else if (tag === 'seam') {
      const kind = parts[1];
      if (kind !== 'continuous' && kind !== 'split') {
        problems.push(`${path}: seam kind must be continuous or split`);
        continue;
      }
      const a = Number.parseInt(parts[2] ?? '', 10);
      const b = Number.parseInt(parts[3] ?? '', 10);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        problems.push(`${path}: seam needs two triangle ids`);
        continue;
      }
      rawSeams.push({ kind, a, b, id: parts[4] });
    } else {
      problems.push(`${path}: unknown record "${tag}"`);
    }
  }

  if (!sawMagic) problems.push('missing "# fabric-mesh-preview 1" header');
  if (triangles.length === 0) problems.push('no triangles found');
  if (problems.length > 0) throw new MeshFormatError(problems);

  const seams = buildSeamDeclarations(rawSeams, triangles, problems, 'fabricmesh');
  if (problems.length > 0) throw new MeshFormatError(problems);

  const document: MeshDocument = {
    format: 'fabric-mesh-preview',
    version: 1,
    texture,
    vertices,
    triangles,
    seams,
    diagnostics: { stretchThreshold: stretch, collapseThreshold: collapse, seamTolerance: tolerance },
  };
  return {
    document,
    summary: `fabricmesh: ${vertices.length} vertices, ${triangles.length} triangles, ${seams.length} declared seam(s)`,
  };
}

/** Chooses a parser by file extension and content sniffing. */
export function parseMeshText(text: string, fileName: string): ImportedSource {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.obj')) return parseObj(text);
  if (lower.endsWith('.fabricmesh') || lower.endsWith('.fmesh') || lower.endsWith('.txt')) {
    return parseFabricMesh(text);
  }
  if (text.includes('# fabric-mesh-preview')) return parseFabricMesh(text);
  return parseObj(text);
}

export function serializeFabricMesh(doc: MeshDocument): string {
  const out: string[] = [];
  out.push('# fabric-mesh-preview 1');
  out.push(`# exported by mesh-texture-preview; deterministic, reload-safe`);
  out.push(`texture ${JSON.stringify(doc.texture.name)} ${doc.texture.width} ${doc.texture.height}`);
  out.push(`diag ${doc.diagnostics.stretchThreshold} ${doc.diagnostics.collapseThreshold} ${doc.diagnostics.seamTolerance}`);
  out.push('');
  doc.vertices.forEach((v, i) => {
    out.push(`v ${formatNumber(v.x)} ${formatNumber(v.y)}${v.pinned ? ' pinned' : ''} # ${i}`);
  });
  out.push('');
  // Write each triangle's UVs as vt entries, reusing identical values so the
  // file stays compact while still allowing per-corner split UVs.
  const uvIndex = new Map<string, number>();
  const vtLines: string[] = [];
  const triLines: string[] = [];
  for (const tri of doc.triangles) {
    const refs: string[] = [];
    for (let k = 0; k < 3; k++) {
      const uv = tri.uvs[k];
      const key = `${formatNumber(uv.x)}|${formatNumber(uv.y)}`;
      let index = uvIndex.get(key);
      if (index === undefined) {
        index = vtLines.length;
        uvIndex.set(key, index);
        vtLines.push(`vt ${formatNumber(uv.x)} ${formatNumber(uv.y)}`);
      }
      refs.push(`${tri.vertices[k]}/${index}`);
    }
    triLines.push(`f ${refs.join(' ')} # tri ${tri.id}`);
  }
  out.push(...vtLines);
  out.push('');
  out.push(...triLines);
  if (doc.seams.length > 0) {
    out.push('');
    for (const seam of doc.seams) {
      out.push(`seam ${seam.kind} ${seam.triangles[0]} ${seam.triangles[1]} ${seam.id}`);
    }
  }
  return `${out.join('\n')}\n`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError('cannot serialise a non-finite number');
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}
