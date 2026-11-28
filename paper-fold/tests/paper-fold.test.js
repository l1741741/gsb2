import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadModel } from '../src/model.js';
import { solveAt } from '../src/solver.js';
import { analyzeContacts, scanProgress, adjacentPairs } from '../src/intersection.js';
import { allSeamGaps } from '../src/seams.js';
import { classifyTriangleSets } from '../src/geometry.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = (name) => JSON.parse(readFileSync(join(here, '..', 'samples', `${name}.json`), 'utf8'));

test('正常合拢样例：三段串联折缝在 t=1 精确合拢且全程无互穿', () => {
  const { ok, model, errors } = loadModel(samples('tube'));
  assert.equal(ok, true, errors.map((e) => e.message).join('; '));
  assert.equal(model.faceOrder.length, 4);
  assert.equal(model.creases.size, 3);

  const scan = scanProgress(model, 64);
  assert.equal(scan.firstCross, null);

  const poses = solveAt(model, 1);
  const result = analyzeContacts(model, poses);
  assert.equal(result.crossingPairs.size, 0);
  // F0 与 F3 仅自由边贴合，不能被误判为互穿。
  assert.deepEqual([...result.touchingPairs], ['F0|F3']);

  const gaps = allSeamGaps(model, poses);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].result.closed, true);
  assert.ok(gaps[0].result.gap < 1e-12);

  // 展开状态下接缝是张开的（整板宽度 4）。
  const flat = allSeamGaps(model, solveAt(model, 0));
  assert.ok(Math.abs(flat[0].result.gap - 4) < 1e-9);
});

test('同一进度反复往返给出位级一致的结果，绕回初始角度无漂移', () => {
  const { model } = loadModel(samples('tube'));
  const reference = solveAt(model, 0.37);
  for (let k = 0; k < 30; k += 1) {
    solveAt(model, 0.91);
    solveAt(model, 0.04);
    solveAt(model, 1);
    const again = solveAt(model, 0.37);
    for (const id of model.faceOrder) {
      assert.deepEqual(again.get(id).points, reference.get(id).points);
      assert.deepEqual(again.get(id).rotation, reference.get(id).rotation);
    }
  }
  // t=0 时每个面都精确回到展开板顶点。
  const flat = solveAt(model, 0);
  for (const id of model.faceOrder) {
    assert.deepEqual(flat.get(id).points, model.faces.get(id).vertices);
  }
});

test('任意进度下共享折缝两端点始终接合（三段串联也不漂移）', () => {
  const { model } = loadModel(samples('tube'));
  for (const t of [0, 0.13, 0.5, 0.777, 1]) {
    const poses = solveAt(model, t);
    for (const crease of model.creases.values()) {
      const pe = crease.edgeByFace[crease.parentFace];
      const ce = crease.edgeByFace[crease.childFace];
      const pp = poses.get(crease.parentFace).points;
      const cp = poses.get(crease.childFace).points;
      for (let k = 0; k < 2; k += 1) {
        const a = pp[pe[k]];
        const d0 = Math.hypot(a[0] - cp[ce[0]][0], a[1] - cp[ce[0]][1], a[2] - cp[ce[0]][2]);
        const d1 = Math.hypot(a[0] - cp[ce[1]][0], a[1] - cp[ce[1]][1], a[2] - cp[ce[1]][2]);
        assert.ok(Math.min(d0, d1) < 1e-12, `折缝 ${crease.id} 在 t=${t} 脱开`);
      }
    }
  }
});

test('互穿样例：在折叠中途检测到 L/G 真正互穿，并给出首个互穿进度', () => {
  const { ok, model } = loadModel(samples('crossing'));
  assert.equal(ok, true);
  assert.equal(analyzeContacts(model, solveAt(model, 0)).crossingPairs.size, 0);
  assert.equal(analyzeContacts(model, solveAt(model, 0.5)).crossingPairs.size, 0);

  const scan = scanProgress(model, 100);
  assert.ok(scan.firstCross);
  assert.deepEqual(scan.firstCross.pairs, ['G|L']);
  assert.ok(scan.firstCross.progress > 0.5 && scan.firstCross.progress < 0.9);

  const atCross = analyzeContacts(model, solveAt(model, scan.firstCross.progress + 0.02));
  assert.ok(atCross.crossingPairs.has('G|L'));
});

test('贴合与互穿被严格区分：方管合口只算 touch', () => {
  const { model } = loadModel(samples('tube'));
  const result = analyzeContacts(model, solveAt(model, 1));
  const contact = result.contacts.find((c) => c.faces.join('|') === 'F0|F3');
  assert.equal(contact.kind, 'touch');
  assert.ok(contact.minDistance < 1e-10);
  assert.equal(adjacentPairs(model).has('F0|F1'), true);
});

test('折平后共面：面积交叠判互穿；共面边接触由三角形级判定为贴合', () => {
  // 底板 A 在 z=0；L、G 各折 180° 翻到 A 的两侧，折平后三片共面且互不交叠。
  const raw = {
    rootFace: 'A',
    faces: [
      { id: 'A', vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] },
      { id: 'L', vertices: [[-1, 0, 0], [0, 0, 0], [0, 1, 0], [-1, 1, 0]] },
      { id: 'G', vertices: [[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0]] },
    ],
    creases: [
      { id: 'CL', faces: ['A', 'L'], edges: { A: [0, 3], L: [1, 2] }, direction: 'valley', endAngle: Math.PI },
      { id: 'CG', faces: ['A', 'G'], edges: { A: [1, 2], G: [3, 0] }, direction: 'mountain', endAngle: Math.PI },
    ],
  };
  const { model } = loadModel(raw);
  const poses = solveAt(model, 1);
  // 折平后所有面法向仍与 z 轴平行（共面）。
  for (const id of model.faceOrder) {
    assert.ok(Math.abs(Math.abs(poses.get(id).normal[2]) - 1) < 1e-9);
  }
  const result = analyzeContacts(model, poses);
  // L、G 折平后都翻到 A 上方并完全重叠（共面面积重叠）=> 互穿；与 A 为邻接跳过。
  assert.deepEqual([...result.crossingPairs], ['G|L']);
  assert.equal(result.touchingPairs.size, 0);

  // 三角形级：共面边接触 => touch；共面面积重叠 => cross。
  const triA = [[[0, 0, 0], [1, 0, 0], [0, 1, 0]]];
  const triEdgeTouch = [[[1, 0, 0], [2, 0, 0], [1, 1, 0]]];
  assert.equal(classifyTriangleSets(triA, triEdgeTouch, 1e-9), 'touch');
  const triVertexTouch = [[[1, 0, 0], [2, 0, 0], [2, -1, 0]]];
  assert.equal(classifyTriangleSets(triA, triVertexTouch, 1e-9), 'touch');
  const triOverlap = [[[0.5, -0.5, 0], [1.5, -0.5, 0], [0.5, 0.5, 0]]];
  assert.equal(classifyTriangleSets(triA, triOverlap, 1e-9), 'cross');
});

test('坏样例：折缝闭合环返回 CREASE_RING 且说明涉及的面', () => {
  const result = loadModel(samples('invalid-ring'));
  assert.equal(result.ok, false);
  const ring = result.errors.find((e) => e.code === 'CREASE_RING');
  assert.ok(ring, result.errors.map((e) => e.code).join(','));
  assert.match(ring.message, /RING/);
  assert.match(ring.message, /环/);
});

test('坏样例：重复折缝编号返回 DUPLICATE_CREASE_ID', () => {
  const result = loadModel(samples('invalid-duplicate-id'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'DUPLICATE_CREASE_ID' && /DUP/.test(e.message)));
});

test('坏样例：无效共享边分别报出非边界边与边不重合的具体原因', () => {
  const result = loadModel(samples('invalid-edge'));
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes('CREASE_EDGE_NOT_BOUNDARY'));
  assert.ok(codes.includes('CREASE_EDGE_NOT_SHARED'));
  assert.match(result.errors.find((e) => e.code === 'CREASE_EDGE_NOT_SHARED').message, /不重合/);
});

test('一次加载聚合多个错误而不是只报第一个', () => {
  const result = loadModel(samples('invalid-edge'));
  assert.ok(result.errors.length >= 2);
  assert.ok(result.errors.every((e) => e.code && e.path && e.message));
});

test('山折与谷折方向相反地抬起子面', () => {
  const raw = {
    faces: [
      { id: 'A', vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] },
      { id: 'B', vertices: [[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0]] },
    ],
    creases: [
      { id: 'c', faces: ['A', 'B'], edges: { A: [1, 2], B: [3, 0] }, direction: 'valley', endAngle: Math.PI / 2 },
    ],
  };
  const { model } = loadModel(raw);
  const valleyPose = solveAt(model, 1).get('B');
  const mountainRaw = structuredClone(raw);
  mountainRaw.creases[0].direction = 'mountain';
  const mountainModel = loadModel(mountainRaw).model;
  const mountainPose = solveAt(mountainModel, 1).get('B');
  const valleyZ = valleyPose.centroid[2];
  const mountainZ = mountainPose.centroid[2];
  // 谷折抬向板面法线 +z，山折压向 -z，z 分量等大反向；xy 平面位置相同。
  assert.ok(valleyZ > 0.1);
  assert.ok(mountainZ < -0.1);
  assert.ok(Math.abs(valleyZ + mountainZ) < 1e-9);
  for (let i = 0; i < 2; i += 1) {
    assert.ok(Math.abs(valleyPose.centroid[i] - mountainPose.centroid[i]) < 1e-9);
  }
  assert.ok(Math.abs(valleyPose.hingeAngle + mountainPose.hingeAngle) < 1e-12);
});

test('五边形面（非三角/四边）可三角化并随铰链正常运动', () => {
  const raw = {
    faces: [
      { id: 'A', vertices: [[0, 0, 0], [1, 0, 0], [1.2, 0.5, 0], [1, 1, 0], [0, 1, 0]] },
      { id: 'B', vertices: [[0, 0, 0], [1, 0, 0], [1, -1, 0], [0, -1, 0]] },
    ],
    creases: [
      { id: 'c', faces: ['A', 'B'], edges: { A: [0, 1], B: [1, 0] }, direction: 'valley', endAngle: Math.PI / 2 },
    ],
  };
  const result = loadModel(raw);
  assert.equal(result.ok, true, result.errors.map((e) => e.message).join(';'));
  assert.equal(result.model.faces.get('A').triangles.length, 3);
  const poses = solveAt(result.model, 0.5);
  assert.equal(poses.get('A').points.length, 5);
});

test('目标接缝校验：未知面、越界索引、同面边都有明确错误', () => {
  const base = {
    faces: [
      { id: 'A', vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] },
      { id: 'B', vertices: [[1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0]] },
    ],
    creases: [
      { id: 'c', faces: ['A', 'B'], edges: { A: [1, 2], B: [3, 0] }, direction: 'valley', endAngle: 1 },
    ],
    targetSeams: [
      { id: 't1', edges: [{ face: 'X', edge: [0, 1] }, { face: 'B', edge: [0, 1] }] },
      { id: 't2', edges: [{ face: 'A', edge: [0, 9] }, { face: 'B', edge: [0, 1] }] },
      { id: 't3', edges: [{ face: 'A', edge: [0, 1] }, { face: 'A', edge: [2, 3] }] },
    ],
  };
  const result = loadModel(base);
  assert.equal(result.ok, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes('TARGET_FACE_UNKNOWN'));
  assert.ok(codes.includes('TARGET_EDGE_OUT_OF_RANGE'));
  assert.ok(codes.includes('TARGET_SAME_FACE'));
});

test('断开的面与未知根面会被拒绝', () => {
  const raw = {
    rootFace: 'A',
    faces: [
      { id: 'A', vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] },
      { id: 'B', vertices: [[2, 0, 0], [3, 0, 0], [3, 1, 0], [2, 1, 0]] },
    ],
    creases: [],
  };
  const result = loadModel(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'FACE_DISCONNECTED'));

  assert.equal(loadModel({ ...raw, rootFace: 'Z' }).ok, false);
});
