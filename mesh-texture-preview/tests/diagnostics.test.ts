import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiagnostics,
  documentFingerprint,
  medianOf,
  resolveSeams,
  singularValues,
  triangleJacobian,
  triangleMetrics,
  weldTopology,
  wrapUvDelta,
} from '../src/core/diagnostics.ts';
import { flippedTriangle, quadGrid, singleTriangle, splitPair } from './fixtures.ts';

test('weldTopology merges identical positions and keeps distinct ones', () => {
  const doc = splitPair(0.25);
  const topology = weldTopology(doc.vertices);
  // A, B, C and the duplicate B' — four distinct positions, with B and B' welded.
  assert.equal(topology.weldVertex.length, 4);
  assert.equal(topology.vertexWeld[1], topology.vertexWeld[3]);
  assert.notEqual(topology.vertexWeld[0], topology.vertexWeld[1]);
});

test('medianOf handles odd and even counts', () => {
  assert.equal(medianOf([1, 3, 5]), 3);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([]), 0);
});

test('triangleJacobian recovers a pure scale, and singular values match', () => {
  // Fabric is exactly 2× the UV-space shape.
  const jacobian = triangleJacobian(
    [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 0, y: 200 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
  );
  assert.ok(jacobian);
  const sv = singularValues(jacobian);
  assert.ok(Math.abs(sv.max - 200) < 1e-9);
  assert.ok(Math.abs(sv.min - 200) < 1e-9);
  assert.ok(Math.abs(sv.det - 40000) < 1e-9);
});

test('triangleJacobian returns null for a zero-area UV triangle', () => {
  const jacobian = triangleJacobian(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ],
    [
      { x: 0.2, y: 0.2 },
      { x: 0.2, y: 0.2 },
      { x: 0.2, y: 0.2 },
    ],
  );
  assert.equal(jacobian, null);
});

test('wrapUvDelta folds offsets into [-0.5, 0.5)', () => {
  assert.deepEqual(wrapUvDelta({ x: 0.25, y: -0.25 }), { x: 0.25, y: -0.25 });
  assert.deepEqual(wrapUvDelta({ x: 1.5, y: -1.5 }), { x: -0.5, y: -0.5 });
  assert.deepEqual(wrapUvDelta({ x: 0.5, y: -0.5 }), { x: -0.5, y: -0.5 });
});

test('a clean grid has no flipped, collapsed or stretched triangles', () => {
  const diagnostics = buildDiagnostics(quadGrid());
  assert.equal(diagnostics.flippedTriangles, 0);
  assert.equal(diagnostics.collapsedTriangles, 0);
  assert.equal(diagnostics.overStretchedTriangles, 0);
  assert.equal(diagnostics.accidentalSplits, 0);
  assert.equal(diagnostics.invalidSeams, 0);
  // Each of the 4 quads contributes 1 diagonal (interior) + its 2 cell edges
  // that are interior on this 2×2 grid: 4 diagonals + 4 interior cell edges
  // gives 8 shared edges in total.
  assert.equal(diagnostics.continuousSeams, 8);
  assert.equal(diagnostics.referenceStretch, 200);
});

test('a single unit-scale triangle reads as isotropic density 1× relative to its mesh', () => {
  const doc = singleTriangle(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ],
    [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0, y: 0.5 },
    ],
  );
  const metric = buildDiagnostics(doc).triangles[0];
  assert.ok(Math.abs(metric.anisotropy - 1) < 1e-9);
  assert.ok(Math.abs(metric.stretchRatio - 1) < 1e-9, 'one triangle is its own reference');
});

test('flipped triangle is detected via negative determinant', () => {
  const diagnostics = buildDiagnostics(flippedTriangle());
  const metric = diagnostics.triangles[0];
  assert.equal(metric.flipped, true);
  assert.equal(metric.invalid, true);
  assert.ok(metric.determinant < 0);
  assert.equal(diagnostics.flippedTriangles, 1);
});

test('squashing one triangle below the collapse threshold flags it collapsed', () => {
  // UV area is tiny compared to fabrication; minStretch collapses.
  const doc = singleTriangle(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ],
    [
      { x: 0, y: 0 },
      { x: 0.001, y: 0 },
      { x: 0, y: 0.001 },
    ],
  );
  const metric = triangleMetrics(doc, 0, doc.diagnostics, 0);
  // minStretch here is 100000, so not collapsed; instead test the reverse:
  // a huge UV triangle relative to fabric gives a tiny minStretch.
  const reverse = singleTriangle(
    [
      { x: 0, y: 0 },
      { x: 0.01, y: 0 },
      { x: 0, y: 0.01 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
  );
  const reverseMetric = triangleMetrics(reverse, 0, reverse.diagnostics, 0);
  assert.ok(reverseMetric.minStretch < 0.02, `minStretch ${reverseMetric.minStretch}`);
  assert.equal(reverseMetric.collapsed, true);
  assert.equal(metric.collapsed, false);
});

test('stretching one triangle relative to the mesh median is flagged', () => {
  const doc = quadGrid();
  // Move a shared corner of one triangle far away to stretch it locally.
  doc.vertices[4] = { x: 100, y: 400 };
  const diagnostics = buildDiagnostics(doc);
  const stretched = diagnostics.triangles.filter((t) => t.overStretched);
  assert.ok(stretched.length > 0, 'expected at least one over-stretched triangle');
  const worst = stretched.reduce((a, b) => (b.deformation > a.deformation ? b : a));
  assert.ok(worst.deformation > doc.diagnostics.stretchThreshold);
});

test('split seam sides are sampled separately and reported as split-ok', () => {
  const doc = splitPair(0.25);
  const diagnostics = buildDiagnostics(doc);
  assert.equal(diagnostics.splitSeams, 1);
  const metrics = diagnostics.seamById.get('split-edge');
  assert.ok(metrics);
  assert.equal(metrics.status, 'split-ok');
  assert.ok(Math.abs(metrics.maxSplit - 0.25) < 1e-9, `maxSplit ${metrics.maxSplit}`);
  assert.equal(metrics.samples.length, 9);
  // Each sample sees the declared offset, not zero.
  for (const sample of metrics.samples) {
    assert.ok(Math.abs(sample.splitDistanceLength - 0.25) < 1e-9, `t=${sample.t}`);
  }
});

test('whole-repeat offset on a split seam is visually continuous but recorded', () => {
  const doc = splitPair(1.0);
  const diagnostics = buildDiagnostics(doc);
  const metrics = diagnostics.seamById.get('split-edge')!;
  // Wrapped distance is 0, so the texture looks continuous...
  assert.ok(metrics.maxSplit < 1e-9);
  // ...but the raw offset is a whole repeat.
  assert.ok(metrics.maxSplitRaw > 0.99);
  assert.equal(metrics.repeatMismatch, true);
  assert.equal(metrics.status, 'split-equal');
});

test('a continuous declaration whose sides differ is reported as accidental-split', () => {
  const doc = splitPair(0.25);
  doc.seams = [{ id: 'split-edge', triangles: [0, 1], kind: 'continuous' }];
  const diagnostics = buildDiagnostics(doc);
  const metrics = diagnostics.seamById.get('split-edge')!;
  assert.equal(metrics.status, 'accidental-split');
  assert.equal(diagnostics.accidentalSplits, 1);
});

test('undeclared shared edges are still checked as continuous seams', () => {
  const doc = quadGrid();
  const diagnostics = buildDiagnostics(doc);
  assert.equal(diagnostics.seams.length, 8);
  for (const seam of diagnostics.seams) {
    assert.equal(seam.declared, false);
    assert.equal(seam.status, 'continuous-ok');
  }
});

test('a declaration between non-adjacent triangles is surfaced as invalid', () => {
  const doc = quadGrid();
  doc.seams = [{ id: 'bogus', triangles: [0, 2], kind: 'split' }];
  const diagnostics = buildDiagnostics(doc);
  const metric = diagnostics.seamById.get('bogus')!;
  assert.equal(metric.status, 'invalid');
  assert.equal(metric.valid, false);
  assert.equal(diagnostics.invalidSeams, 1);
});

test('boundary edges count only single-triangle edges', () => {
  const diagnostics = buildDiagnostics(quadGrid());
  // A 2×2 quad grid has 8 boundary edges and 4 interior edges.
  assert.equal(diagnostics.boundaryEdges, 8);
  const single = buildDiagnostics(singleTriangle(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ],
  ));
  assert.equal(single.boundaryEdges, 3);
});

test('fingerprints are deterministic and change with the document', () => {
  const a = quadGrid();
  const b = quadGrid();
  assert.equal(documentFingerprint(a), documentFingerprint(b));
  assert.equal(buildDiagnostics(a).fingerprint, buildDiagnostics(b).fingerprint);
  b.vertices[0] = { x: 10, y: 0 };
  assert.notEqual(documentFingerprint(a), documentFingerprint(b));
  assert.notEqual(buildDiagnostics(a).fingerprint, buildDiagnostics(b).fingerprint);
});

test('resolveSeams reports both sides of a split seam with independent UVs', () => {
  const doc = splitPair(0.25);
  const seams = resolveSeams(doc);
  assert.equal(seams.length, 1);
  const seam = seams[0];
  assert.equal(seam.valid, true);
  assert.equal(seam.edgeVertexA[0], 0);
  assert.equal(seam.edgeVertexA[1], 1);
  // Side B has its own duplicate vertex at the same fabric position.
  assert.equal(seam.edgeVertexB[1], 3);
  assert.deepEqual(seam.uvA[1], { x: 0.5, y: 0 });
  assert.deepEqual(seam.uvB[1], { x: 0.75, y: 0 });
  // Both sides are indexed from the same fabric endpoint.
  assert.ok(Math.abs(seam.uvB[0].x - seam.uvA[0].x - 0.25) < 1e-9);
  assert.ok(Math.abs(seam.uvB[1].x - seam.uvA[1].x - 0.25) < 1e-9);
});
