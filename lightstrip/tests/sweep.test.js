import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSweep } from '../src/sweep.js';
import { profiles, signedArea } from '../src/profiles.js';
import { triangulatePolygon } from '../src/triangulate.js';
import { distance, dot, sub } from '../src/vec3.js';

const loadCase = async (name) =>
  JSON.parse(await readFile(new URL(`../cases/${name}.json`, import.meta.url), 'utf8'));

// Count how often each undirected edge appears after welding coincident
// vertices (texture seams and caps duplicate positions); a watertight mesh
// has exactly 2 everywhere.
function edgeCounts(mesh) {
  const weld = new Map();
  const id = mesh.positions.map((p) => {
    const key = p.map((v) => Math.round(v * 1e7)).join(',');
    if (!weld.has(key)) weld.set(key, weld.size);
    return weld.get(key);
  });
  const counts = new Map();
  for (const f of mesh.faces) {
    const [a, b, c] = f.indices.map((i) => id[i]);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

test('built-in profiles are counter-clockwise (outward winding contract)', () => {
  for (const [name, profile] of Object.entries(profiles)) {
    assert.ok(signedArea(profile.points) > 0, `${name} must be CCW`);
  }
});

test('closed loop is watertight with no caps and no seam gap', async () => {
  const mesh = buildSweep(await loadCase('closed-loop'));
  assert.equal(mesh.closed, true);
  assert.ok(mesh.faces.every((f) => f.material === 'strip'));
  for (const [edge, count] of edgeCounts(mesh)) {
    assert.equal(count, 2, `edge ${edge} is not shared by exactly 2 faces`);
  }
  // Seam rings are distinct samples but must be close neighbours on the path.
  const first = mesh.pathSamples[0];
  const last = mesh.pathSamples[mesh.ringCount - 1];
  const typical = distance(mesh.pathSamples[1], first);
  assert.ok(distance(first, last) < typical * 2.5, 'closed loop ends should meet near the start');
});

test('open path gets distinguishable end caps and stays watertight', async () => {
  const mesh = buildSweep(await loadCase('straight-joint'));
  const caps = mesh.faces.filter((f) => f.material === 'cap');
  assert.ok(caps.length > 0, 'open path must have cap faces');
  for (const [edge, count] of edgeCounts(mesh)) {
    assert.equal(count, 2, `edge ${edge} is not shared by exactly 2 faces`);
  }
});

test('width is continuous across a mid-path joint', async () => {
  const mesh = buildSweep(await loadCase('straight-joint'));
  // Joint sits at control point 2 (width jumps 0.3 -> 0.55 across it).
  let maxStep = 0;
  for (let i = 1; i < mesh.widths.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(mesh.widths[i] - mesh.widths[i - 1]));
  }
  const maxWidth = Math.max(...mesh.widths);
  assert.ok(maxStep < maxWidth * 0.2, `width step ${maxStep} too large at a joint`);
  // Ring radius tracks the width: sample a ring vertex offset from its centre.
  const ringAt = (i) => distance(mesh.positions[i * mesh.ringSize], mesh.pathSamples[i]);
  const jointSample = mesh.controlPoints[2].sampleIndex;
  const before = ringAt(jointSample - 1);
  const after = ringAt(jointSample + 1);
  assert.ok(Math.abs(before - after) < 0.1, `ring radius jumps ${before} -> ${after} at joint`);
});

test('face normals point outward on a straight run', () => {
  const mesh = buildSweep({
    profile: 'flat-strip',
    points: [
      { position: [0, 0, 0], width: 0.4 },
      { position: [0, 0, 2], width: 0.4 },
    ],
    samplesPerSegment: 8,
  });
  // For each strip face, the geometric normal must point away from the path centre.
  for (const f of mesh.faces) {
    if (f.material !== 'strip') continue;
    const [a, b, c] = f.indices.map((i) => mesh.positions[i]);
    const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const centre = [0, 0, centroid[2]]; // path runs along +z at x=y=0
    const outward = sub(centroid, centre);
    const n = mesh.normals[f.indices[0]];
    assert.ok(dot(n, outward) > 0, 'normal points inward');
  }
});

test('all shipped cases build without non-finite vertices', async () => {
  for (const name of ['spatial-bend', 'closed-loop', 'u-turn', 'straight-joint']) {
    const mesh = buildSweep(await loadCase(name));
    assert.equal(mesh.diagnostics.nanVertices, 0, `${name} produced NaN`);
    assert.equal(mesh.diagnostics.frameEvents.length, 0, `${name} reseeded a frame`);
  }
});

test('ear clipping covers concave profiles exactly (no fan spill)', () => {
  for (const [name, profile] of Object.entries(profiles)) {
    const tris = triangulatePolygon(profile.points);
    let triArea = 0;
    for (const [a, b, c] of tris) {
      const [x1, y1] = profile.points[a];
      const [x2, y2] = profile.points[b];
      const [x3, y3] = profile.points[c];
      triArea += Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) / 2;
    }
    assert.ok(
      Math.abs(triArea - Math.abs(signedArea(profile.points))) < 1e-9,
      `${name}: triangle area ${triArea} != polygon area`,
    );
  }
});

test('invalid case definitions are rejected', () => {
  assert.throws(() => buildSweep({ points: [[0, 0, 0]] }), /at least 2/);
  assert.throws(() => buildSweep({ points: [[0, 0, 0], [1, 0, 0]], profile: 'nope' }), /unknown profile/);
  assert.throws(
    () => buildSweep({ points: [{ position: [0, 0, 0], width: -1 }, [1, 0, 0]] }),
    /width/,
  );
});
