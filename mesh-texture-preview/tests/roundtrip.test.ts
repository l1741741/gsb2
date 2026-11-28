import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshFormatError, normalizeDocument } from '../src/core/document.ts';
import { parseFabricMesh, parseMeshText, parseObj, serializeFabricMesh } from '../src/core/formats.ts';
import { importMeshJson, importMeshText } from '../src/core/importer.ts';
import { buildDiagnostics, documentFingerprint } from '../src/core/diagnostics.ts';
import { buildMeshJson } from '../src/core/export.ts';
import { buildPreview, digestTexture, buildFabricMeshText } from '../src/core/export.ts';
import { quadGrid, splitPair } from './fixtures.ts';

const ginghamPath = new URL('../samples/gingham.fabricmesh', import.meta.url);
const splitPath = new URL('../samples/split.fabricmesh', import.meta.url);
const flippedPath = new URL('../samples/flipped.fabricmesh', import.meta.url);

test('fabricmesh export round-trips geometry, UVs, seams and diagnostics', async () => {
  const fs = await import('node:fs');
  for (const file of [ginghamPath, splitPath, flippedPath]) {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseFabricMesh(text);
    const reexported = serializeFabricMesh(parsed.document);
    const reparsed = parseFabricMesh(reexported);
    assert.equal(documentFingerprint(reparsed.document), documentFingerprint(parsed.document), file.pathname);
    assert.equal(
      buildDiagnostics(reparsed.document).fingerprint,
      buildDiagnostics(parsed.document).fingerprint,
      `${file.pathname} diagnostics`,
    );
  }
});

test('sample fingerprints in the recorded reports still match', async () => {
  const fs = await import('node:fs');
  const names = ['gingham', 'split', 'flipped'] as const;
  for (const name of names) {
    const report = JSON.parse(
      fs.readFileSync(new URL(`../samples/previews/${name}-report.json`, import.meta.url), 'utf8'),
    ) as { documentFingerprint: string; diagnosticsFingerprint: string };
    const text = fs.readFileSync(new URL(`../samples/${name}.fabricmesh`, import.meta.url), 'utf8');
    const parsed = parseFabricMesh(text).document;
    assert.equal(documentFingerprint(parsed), report.documentFingerprint, `${name} document fingerprint`);
    assert.equal(buildDiagnostics(parsed).fingerprint, report.diagnosticsFingerprint, `${name} diagnostics fingerprint`);
  }
});

test('OBJ import reads v/vt/f and fan-triangulates quads', () => {
  const obj = [
    'v 0 0',
    'v 100 0',
    'v 100 100',
    'v 0 100',
    'vt 0 0',
    'vt 1 0',
    'vt 1 1',
    'vt 0 1',
    'f 1/1 2/2 3/3 4/4',
  ].join('\n');
  const imported = parseObj(obj);
  assert.equal(imported.document.vertices.length, 4);
  assert.equal(imported.document.triangles.length, 2);
  assert.deepEqual(imported.document.triangles[0].uvs[1], { x: 1, y: 0 });
  assert.deepEqual(imported.document.triangles[1].vertices, [0, 2, 3]);
});

test('OBJ import applies seam comments to triangle ids', () => {
  const obj = [
    '# fabric-seam split 0 1 seam-a',
    'v 0 0',
    'v 100 0',
    'v 50 100',
    'v 50 -100',
    'vt 0 0',
    'vt 0.5 0',
    'vt 0.25 0.5',
    'vt 0.75 0',
    'vt 0.25 -0.5',
    'f 1/1 2/2 3/3',
    'f 1/1 2/4 4/5',
  ].join('\n');
  const imported = parseObj(obj);
  assert.equal(imported.document.seams.length, 1);
  assert.equal(imported.document.seams[0].id, 'seam-a');
  assert.equal(imported.document.seams[0].kind, 'split');
  assert.deepEqual(imported.document.seams[0].triangles, [0, 1]);
});

test('OBJ import reports problems instead of guessing', () => {
  assert.throws(() => parseObj('v 0 0\nf 1/1 2/2 3/3'), (error: unknown) => {
    assert.ok(error instanceof MeshFormatError);
    assert.ok(error.problems.some((p) => p.includes('out of range')));
    return true;
  });
});

test('fabricmesh rejects unknown records and out-of-range indices', () => {
  const bad = [
    '# fabric-mesh-preview 1',
    'v 0 0',
    'v 100 0',
    'v 0 100',
    'vt 0 0',
    'vt 1 0',
    'vt 0 1',
    'f 0/0 1/1 5/2',
    'wobble 3',
  ].join('\n');
  assert.throws(() => parseFabricMesh(bad), (error: unknown) => {
    assert.ok(error instanceof MeshFormatError);
    const joined = error.problems.join(' | ');
    assert.ok(joined.includes('out of range'), joined);
    assert.ok(joined.includes('unknown record'), joined);
    return true;
  });
});

test('parseMeshText sniffs fabricmesh content when the extension is unknown', () => {
  const text = '# fabric-mesh-preview 1\nv 0 0\nv 1 0\nv 0 1\nvt 0 0\nvt 1 0\nvt 0 1\nf 0/0 1/1 2/2';
  const imported = parseMeshText(text, 'mesh.dat');
  assert.equal(imported.document.triangles.length, 1);
});

test('JSON export/reload preserves geometry, seams and diagnostics fingerprints', () => {
  const doc = quadGrid();
  doc.seams = [{ id: 'declared', triangles: [0, 1], kind: 'split' }];
  const json = buildMeshJson(doc, { textureDigest: 'abc', now: () => new Date('2026-01-01T00:00:00Z') });
  const report = importMeshJson(json, 'mesh.json');
  assert.equal(report.mismatches.length, 0, report.mismatches.join(' | '));
  assert.equal(report.hadExportedDiagnostics, true);
  assert.equal(
    documentFingerprint(report.document),
    documentFingerprint(doc),
  );
  assert.equal(report.computed.fingerprint, buildDiagnostics(doc).fingerprint);
  assert.equal(report.document.exported?.diagnosticsFingerprint, report.computed.fingerprint);
});

test('JSON reload flags a document edited outside the tool', () => {
  const doc = splitPair(0.25);
  const json = buildMeshJson(doc, { textureDigest: null, now: () => new Date('2026-01-01T00:00:00Z') });
  const parsed = JSON.parse(json) as { vertices: { x: number; y: number }[] };
  parsed.vertices[1].x = 130; // tamper with geometry after export
  const report = importMeshJson(JSON.stringify(parsed), 'tampered.json');
  assert.ok(report.mismatches.length >= 2, report.mismatches.join(' | '));
  assert.ok(report.mismatches.some((m) => m.includes('geometry')));
  assert.ok(report.mismatches.some((m) => m.includes('diagnostics')));
});

test('export->reload is independent of the edit order that produced the mesh', () => {
  // Reach the same final document by two different edit sequences, then
  // export both and compare the reloaded diagnostics.
  const start = quadGrid();
  const pathA = (() => {
    const step1 = structuredClone(start);
    step1.vertices[4] = { x: 120, y: 120 };
    const step2 = structuredClone(step1);
    step2.seams = [{ id: 's', triangles: [0, 1], kind: 'continuous' }];
    return step2;
  })();
  const pathB = (() => {
    const step1 = structuredClone(start);
    step1.seams = [{ id: 's', triangles: [0, 1], kind: 'continuous' }];
    const step2 = structuredClone(step1);
    step2.vertices[4] = { x: 120, y: 120 };
    return step2;
  })();
  const jsonA = buildMeshJson(normalizeDocument(pathA), { textureDigest: null, now: () => new Date('2026-01-01T00:00:00Z') });
  const jsonB = buildMeshJson(normalizeDocument(pathB), { textureDigest: null, now: () => new Date('2026-01-01T00:00:00Z') });
  const reportA = importMeshJson(jsonA, 'a.json');
  const reportB = importMeshJson(jsonB, 'b.json');
  assert.equal(reportA.documentFingerprint, reportB.documentFingerprint);
  assert.equal(reportA.computed.fingerprint, reportB.computed.fingerprint);
  assert.equal(reportA.mismatches.length, 0);
  assert.equal(reportB.mismatches.length, 0);
});

test('fabricmesh text export round-trips through importMeshText', () => {
  const doc = splitPair(0.25);
  const text = buildFabricMeshText(doc);
  const report = importMeshText(text, 'pair.fabricmesh');
  assert.equal(report.mismatches.length, 0);
  assert.equal(documentFingerprint(report.document), documentFingerprint(doc));
  // The split declaration survives as a split declaration.
  assert.equal(report.document.seams.length, 1);
  assert.equal(report.document.seams[0].kind, 'split');
});

test('preview export is deterministic for the same document and texture', async () => {
  const fs = await import('node:fs');
  const { decodePng } = await import('../tools/png-decode.ts');
  const textureBytes = fs.readFileSync(new URL('../samples/gingham.png', import.meta.url));
  const texture = decodePng(new Uint8Array(textureBytes));
  const doc = parseFabricMesh(fs.readFileSync(ginghamPath, 'utf8')).document;
  const a = buildPreview(doc, texture, { width: 128, height: 128 });
  const b = buildPreview(doc, texture, { width: 128, height: 128 });
  assert.equal(a.digest, b.digest);
  assert.deepEqual(a.png, b.png);
  assert.equal(a.diagnosticsFingerprint, b.diagnosticsFingerprint);
  assert.equal(digestTexture(texture), digestTexture(texture));
});
