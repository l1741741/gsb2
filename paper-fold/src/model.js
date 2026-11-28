// 纸模 JSON 的加载、语义校验与折叠树构建。
// 校验策略：一次运行聚合全部问题，每个错误带 code、定位 path 与中文原因，
// 而不是遇到第一个错误就抛出，方便用户一次修完。

import {
  add,
  cross,
  distance,
  dot,
  normalize,
  scale,
  sub,
} from './math3d.js';
import { triangulate } from './geometry.js';

const GEO_EPS_FACTOR = 1e-7;

function finite3(v) {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
}

function centroid(points) {
  const sum = points.reduce((acc, p) => add(acc, p), [0, 0, 0]);
  return scale(sum, 1 / points.length);
}

// 计算模型整体尺寸，用于把绝对容差缩放到模型量级。
function modelExtent(faces) {
  const all = faces.flatMap((face) => face.vertices);
  if (all.length === 0) return 1;
  let max = 0;
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      max = Math.max(max, distance(all[i], all[j]));
    }
  }
  return max || 1;
}

// 校验所有面的顶点是否共处于同一平面（展开板必须是平的）。
function sharedPlaneError(faces, eps) {
  const points = faces.flatMap((face) => face.vertices);
  const p0 = points[0];
  let normal = null;
  for (let i = 1; i < points.length && !normal; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const n = cross(sub(points[i], p0), sub(points[j], p0));
      if (dot(n, n) > eps * eps) {
        normal = normalize(n);
        break;
      }
    }
  }
  if (!normal) return { code: 'MODEL_DEGENERATE', path: 'faces', message: '所有顶点共线，无法构成纸面' };
  let worst = 0;
  for (const p of points) worst = Math.max(worst, Math.abs(dot(sub(p, p0), normal)));
  if (worst > eps * 100) {
    return {
      code: 'MODEL_NOT_FLAT',
      path: 'faces',
      message: `展开状态下面必须共面，检测到最大离面距离 ${worst.toExponential(3)}（容差 ${(eps * 100).toExponential(3)}）`,
    };
  }
  return null;
}

function validateFace(raw, index, errors) {
  const path = `faces[${index}]`;
  if (!raw || typeof raw !== 'object') {
    errors.push({ code: 'FACE_INVALID', path, message: '面必须是对象' });
    return null;
  }
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) {
    errors.push({ code: 'FACE_ID_INVALID', path: `${path}.id`, message: '面缺少字符串类型的 id' });
    return null;
  }
  if (!Array.isArray(raw.vertices) || raw.vertices.length < 3) {
    errors.push({ code: 'FACE_VERTICES_INVALID', path: `${path}.vertices`, face: id, message: `面 ${id} 至少需要 3 个顶点` });
    return null;
  }
  const vertices = [];
  raw.vertices.forEach((v, vi) => {
    if (!finite3(v)) {
      errors.push({ code: 'FACE_VERTICES_INVALID', path: `${path}.vertices[${vi}]`, face: id, message: `面 ${id} 的第 ${vi} 个顶点不是 3 个有限数字` });
    } else {
      vertices.push([v[0], v[1], v[2]]);
    }
  });
  if (vertices.length !== raw.vertices.length) return null;
  for (let vi = 0; vi < vertices.length; vi += 1) {
    const next = (vi + 1) % vertices.length;
    if (distance(vertices[vi], vertices[next]) < 1e-12) {
      errors.push({ code: 'FACE_VERTICES_INVALID', path: `${path}.vertices`, face: id, message: `面 ${id} 存在重合的相邻顶点（索引 ${vi} 与 ${next}）` });
      return null;
    }
  }
  // 单面平面性。
  const n = cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0]));
  if (dot(n, n) < 1e-24) {
    errors.push({ code: 'FACE_DEGENERATE', path: `${path}.vertices`, face: id, message: `面 ${id} 的前三个顶点共线，无法确定纸面` });
    return null;
  }
  const normal = normalize(n);
  let worst = 0;
  for (const p of vertices) worst = Math.max(worst, Math.abs(dot(sub(p, vertices[0]), normal)));
  if (worst > 1e-6) {
    errors.push({ code: 'FACE_NOT_PLANAR', path: `${path}.vertices`, face: id, message: `面 ${id} 不是平面多边形，最大离面距离 ${worst.toExponential(3)}` });
    return null;
  }
  return { id, vertices, normal, centroid: centroid(vertices) };
}

function edgeIndicesOf(rawCrease, faceId) {
  if (rawCrease.edges && typeof rawCrease.edges === 'object') {
    const e = rawCrease.edges[faceId];
    if (e !== undefined) return e;
  }
  return rawCrease.edge; // 简写：两面共用同一对索引
}

function validateCrease(raw, index, faceMap, errors, extent) {
  const path = `creases[${index}]`;
  if (!raw || typeof raw !== 'object') {
    errors.push({ code: 'CREASE_INVALID', path, message: '折缝必须是对象' });
    return null;
  }
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) {
    errors.push({ code: 'CREASE_ID_INVALID', path: `${path}.id`, message: '折缝缺少字符串类型的 id' });
    return null;
  }
  if (!Array.isArray(raw.faces) || raw.faces.length !== 2 ||
      raw.faces.some((f) => typeof f !== 'string')) {
    errors.push({ code: 'CREASE_FACES_INVALID', path: `${path}.faces`, crease: id, message: `折缝 ${id} 的 faces 必须是两个面 id 组成的数组` });
    return null;
  }
  const [fa, fb] = raw.faces;
  if (fa === fb) {
    errors.push({ code: 'CREASE_SELF_FACE', path: `${path}.faces`, crease: id, message: `折缝 ${id} 的两个面不能相同（${fa}）` });
    return null;
  }
  for (const f of [fa, fb]) {
    if (!faceMap.has(f)) {
      errors.push({ code: 'CREASE_FACE_UNKNOWN', path: `${path}.faces`, crease: id, message: `折缝 ${id} 引用了不存在的面 ${f}` });
    }
  }
  if (!faceMap.has(fa) || !faceMap.has(fb)) return null;

  if (raw.direction !== 'mountain' && raw.direction !== 'valley') {
    errors.push({ code: 'CREASE_DIRECTION_INVALID', path: `${path}.direction`, crease: id, message: `折缝 ${id} 的 direction 必须是 "mountain"（山折）或 "valley"（谷折）` });
  }
  if (!Number.isFinite(raw.endAngle)) {
    errors.push({ code: 'CREASE_ANGLE_INVALID', path: `${path}.endAngle`, crease: id, message: `折缝 ${id} 的 endAngle 必须是有限数字（弧度）` });
  } else if (raw.endAngle < 0 || raw.endAngle > Math.PI * 2) {
    errors.push({ code: 'CREASE_ANGLE_INVALID', path: `${path}.endAngle`, crease: id, message: `折缝 ${id} 的 endAngle 应在 0 到 2π 之间，收到 ${raw.endAngle}` });
  }

  // 共享边校验：索引合法、两点不同、是多边形边界边、且两面引用的顶点在展开板上重合。
  const edgeA = edgeIndicesOf(raw, fa);
  const edgeB = edgeIndicesOf(raw, fb);
  const checkEdge = (edge, faceId, edgePath) => {
    const face = faceMap.get(faceId);
    if (!Array.isArray(edge) || edge.length !== 2 || edge.some((n) => !Number.isInteger(n))) {
      errors.push({ code: 'CREASE_EDGE_INVALID', path: edgePath, crease: id, message: `折缝 ${id} 在面 ${faceId} 上的边必须是两个整数索引` });
      return null;
    }
    const [i, j] = edge;
    if (i === j) {
      errors.push({ code: 'CREASE_EDGE_INVALID', path: edgePath, crease: id, message: `折缝 ${id} 在面 ${faceId} 上的边两个端点索引相同（${i}）` });
      return null;
    }
    if (i < 0 || j < 0 || i >= face.vertices.length || j >= face.vertices.length) {
      errors.push({ code: 'CREASE_EDGE_OUT_OF_RANGE', path: edgePath, crease: id, message: `折缝 ${id} 在面 ${faceId} 上的边索引 [${i}, ${j}] 超出顶点范围（共 ${face.vertices.length} 个顶点）` });
      return null;
    }
    const ring = (k) => (k + 1) % face.vertices.length;
    const isBoundary = ring(i) === j || ring(j) === i;
    if (!isBoundary) {
      errors.push({ code: 'CREASE_EDGE_NOT_BOUNDARY', path: edgePath, crease: id, message: `折缝 ${id} 引用的 [${i}, ${j}] 不是面 ${faceId} 的相邻边界边` });
      return null;
    }
    return edge;
  };
  const validA = checkEdge(edgeA, fa, `${path}.edges`);
  const validB = checkEdge(edgeB, fb, `${path}.edges`);
  if (!validA || !validB) return null;

  const faceA = faceMap.get(fa);
  const faceB = faceMap.get(fb);
  const pa0 = faceA.vertices[validA[0]];
  const pa1 = faceA.vertices[validA[1]];
  const pb0 = faceB.vertices[validB[0]];
  const pb1 = faceB.vertices[validB[1]];
  const eps = extent * GEO_EPS_FACTOR;
  // 允许两端点顺序相反；两种配对取较小偏差。
  const mismatchStraight = Math.max(distance(pa0, pb0), distance(pa1, pb1));
  const mismatchReversed = Math.max(distance(pa0, pb1), distance(pa1, pb0));
  const reversed = mismatchReversed < mismatchStraight;
  const mismatch = Math.min(mismatchStraight, mismatchReversed);
  if (mismatch > eps * 100) {
    errors.push({
      code: 'CREASE_EDGE_NOT_SHARED',
      path: `${path}.edges`,
      crease: id,
      message: `折缝 ${id} 的两条边在展开板上不重合（端点最大偏差 ${mismatch.toExponential(3)}，容差 ${(eps * 100).toExponential(3)}），不是有效共享边`,
    });
    return null;
  }
  return {
    id,
    faces: [fa, fb],
    edgeByFace: { [fa]: validA, [fb]: validB },
    reversed,
    direction: raw.direction,
    endAngle: raw.endAngle,
  };
}

// 从根面建立折叠树，同时识别环（无向图回边）与不可达面。
function buildTree(rootId, faceMap, creases, errors) {
  const adjacency = new Map();
  for (const face of faceMap.keys()) adjacency.set(face, []);
  const pairSeen = new Map();
  for (const crease of creases) {
    const key = [...crease.faces].sort().join('|');
    if (pairSeen.has(key)) {
      errors.push({
        code: 'CREASE_DUPLICATE_PAIR',
        path: 'creases',
        crease: crease.id,
        message: `面 ${key.replace('|', ' 与 ')} 之间存在第二条折缝 ${crease.id}（已有 ${pairSeen.get(key)}），纸面连接必须是树结构`,
      });
    }
    pairSeen.set(key, crease.id);
    adjacency.get(crease.faces[0]).push({ to: crease.faces[1], crease });
    adjacency.get(crease.faces[1]).push({ to: crease.faces[0], crease });
  }

  const parentOf = new Map();
  const parentCreaseOf = new Map();
  const creaseOf = new Map(); // child face id -> crease
  const childrenOf = new Map();
  for (const id of faceMap.keys()) childrenOf.set(id, []);
  // DFS（不用 BFS）：只有 DFS 的回边才准确对应“闭合环”的那条折缝。
  const visited = new Set();
  const finished = new Set();
  const cycleCreases = [];
  const stack = [{ id: rootId, parentCrease: null, cursor: 0 }];
  visited.add(rootId);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const neighbors = adjacency.get(frame.id);
    if (frame.cursor >= neighbors.length) {
      finished.add(frame.id);
      stack.pop();
      continue;
    }
    const { to, crease } = neighbors[frame.cursor];
    frame.cursor += 1;
    if (crease.id === frame.parentCrease) continue; // 沿父折缝回边，跳过
    if (finished.has(to)) continue;
    if (visited.has(to)) {
      // 回边 = 环。只在 id 较小的遍历方向记录一次，避免双向重复。
      const seen = cycleCreases.some((c) => c.crease === crease.id);
      if (!seen) cycleCreases.push({ crease: crease.id, from: frame.id, to });
      continue;
    }
    visited.add(to);
    parentOf.set(to, frame.id);
    parentCreaseOf.set(to, crease.id);
    creaseOf.set(to, crease);
    childrenOf.get(frame.id).push(to);
    stack.push({ id: to, parentCrease: crease.id, cursor: 0 });
  }
  for (const c of cycleCreases) {
    errors.push({
      code: 'CREASE_RING',
      path: 'creases',
      crease: c.crease,
      message: `折缝 ${c.crease} 连接 ${c.from} 与 ${c.to} 时形成闭合环：两个面已经通过其它折缝连通，纸张连接图必须是树，不能有环`,
    });
  }
  const unreachable = [...faceMap.keys()].filter((id) => !visited.has(id));
  for (const id of unreachable) {
    errors.push({ code: 'FACE_DISCONNECTED', path: 'faces', face: id, message: `面 ${id} 与根面 ${rootId} 之间没有折缝路径，无法继承折叠运动` });
  }
  return { parentOf, creaseOf, childrenOf, visited };
}

// 确定每条折缝的轴向符号：让谷折（valley）把子面中心抬向板面法线一侧，
// 结果与顶点书写顺序无关。
function orientCreaseAxis(crease, faceMap, parentId, childId) {
  const parent = faceMap.get(parentId);
  const child = faceMap.get(childId);
  const edge = crease.edgeByFace[parentId];
  const p0 = parent.vertices[edge[0]];
  const p1 = parent.vertices[edge[1]];
  const axis = normalize(sub(p1, p0));
  const mid = scale(add(p0, p1), 0.5);
  const towardChild = sub(child.centroid, mid);
  const normal = parent.normal;
  // 子面中心绕 axis 以正角转动时，线速度为 cross(axis, towardChild)。
  // 谷折约定把子面抬向板面法线 normal，所以当该速度与法线反向时，
  // 轴符号取 -1（求解器以 hingeAngle = axisSign * endAngle * t 旋转）。
  // 该计算只依赖几何方向，与顶点索引的书写顺序无关。
  const sign = dot(cross(axis, towardChild), normal) >= 0 ? 1 : -1;
  return { axis, sign };
}

function validateTarget(raw, index, faceMap, errors) {
  const path = `targetSeams[${index}]`;
  if (!raw || typeof raw !== 'object') {
    errors.push({ code: 'TARGET_INVALID', path, message: '目标接缝必须是对象' });
    return null;
  }
  const id = raw.id ?? `target-${index}`;
  if (!Array.isArray(raw.edges) || raw.edges.length !== 2) {
    errors.push({ code: 'TARGET_EDGES_INVALID', path: `${path}.edges`, target: id, message: `目标接缝 ${id} 需要恰好两条边` });
    return null;
  }
  const resolved = [];
  raw.edges.forEach((spec, ei) => {
    const ep = `${path}.edges[${ei}]`;
    if (!spec || typeof spec.face !== 'string' || !Array.isArray(spec.edge) || spec.edge.length !== 2) {
      errors.push({ code: 'TARGET_EDGE_INVALID', path: ep, target: id, message: `目标接缝 ${id} 的第 ${ei + 1} 条边必须是 { face, edge: [i, j] } 结构` });
      return;
    }
    const face = faceMap.get(spec.face);
    if (!face) {
      errors.push({ code: 'TARGET_FACE_UNKNOWN', path: `${ep}.face`, target: id, message: `目标接缝 ${id} 引用了不存在的面 ${spec.face}` });
      return;
    }
    const [i, j] = spec.edge;
    if (!Number.isInteger(i) || !Number.isInteger(j) ||
        i < 0 || j < 0 || i >= face.vertices.length || j >= face.vertices.length || i === j) {
      errors.push({ code: 'TARGET_EDGE_OUT_OF_RANGE', path: `${ep}.edge`, target: id, message: `目标接缝 ${id} 在面 ${spec.face} 上的边索引 [${i}, ${j}] 无效（共 ${face.vertices.length} 个顶点）` });
      return;
    }
    const ring = (k) => (k + 1) % face.vertices.length;
    if (ring(i) !== j && ring(j) !== i) {
      errors.push({ code: 'TARGET_EDGE_NOT_BOUNDARY', path: `${ep}.edge`, target: id, message: `目标接缝 ${id} 的 [${i}, ${j}] 不是面 ${spec.face} 的相邻边界边` });
      return;
    }
    resolved.push({ face: spec.face, edge: [i, j] });
  });
  if (resolved.length !== 2) return null;
  if (resolved[0].face === resolved[1].face) {
    errors.push({ code: 'TARGET_SAME_FACE', path, target: id, message: `目标接缝 ${id} 的两条边位于同一个面 ${resolved[0].face} 上` });
    return null;
  }
  return { id, edges: resolved };
}

// 主入口：返回 { ok, errors, warnings, model }。
export function loadModel(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ code: 'MODEL_INVALID', path: '$', message: 'JSON 根节点必须是对象' }], warnings, model: null };
  }
  if (!Array.isArray(raw.faces) || raw.faces.length === 0) {
    return { ok: false, errors: [{ code: 'FACES_MISSING', path: 'faces', message: '模型缺少非空的 faces 数组' }], warnings, model: null };
  }

  const faceList = [];
  const faceMap = new Map();
  raw.faces.forEach((rf, i) => {
    const face = validateFace(rf, i, errors);
    if (!face) return;
    if (faceMap.has(face.id)) {
      errors.push({ code: 'DUPLICATE_FACE_ID', path: `faces[${i}].id`, face: face.id, message: `面 id "${face.id}" 重复定义` });
      return;
    }
    faceMap.set(face.id, face);
    faceList.push(face);
  });
  if (errors.length > 0) return { ok: false, errors, warnings, model: null };

  const extent = modelExtent(faceList);
  const planeError = sharedPlaneError(faceList, extent * GEO_EPS_FACTOR);
  if (planeError) return { ok: false, errors: [planeError], warnings, model: null };

  // 耳切三角化在加载期完成，多边形自交等问题在这里暴露为明确错误。
  for (const face of faceList) {
    try {
      face.triangles = triangulate(face.vertices);
    } catch (err) {
      errors.push({ code: 'FACE_POLYGON_INVALID', path: 'faces', face: face.id, message: `面 ${face.id} 三角化失败：${err.message}` });
    }
  }

  const creaseIdSeen = new Set();
  const creaseList = [];
  if (raw.creases !== undefined && !Array.isArray(raw.creases)) {
    errors.push({ code: 'CREASES_INVALID', path: 'creases', message: 'creases 必须是数组' });
  }
  for (const [i, rc] of (raw.creases ?? []).entries()) {
    if (rc && typeof rc === 'object' && creaseIdSeen.has(rc.id)) {
      errors.push({ code: 'DUPLICATE_CREASE_ID', path: `creases[${i}].id`, crease: rc.id, message: `折缝 id "${rc.id}" 重复定义` });
      continue;
    }
    if (rc && typeof rc === 'object') creaseIdSeen.add(rc.id);
    const crease = validateCrease(rc, i, faceMap, errors, extent);
    if (crease) creaseList.push(crease);
  }
  if (errors.length > 0) return { ok: false, errors, warnings, model: null };

  const rootId = typeof raw.rootFace === 'string' ? raw.rootFace : faceList[0].id;
  if (!faceMap.has(rootId)) {
    return {
      ok: false,
      errors: [{ code: 'ROOT_FACE_UNKNOWN', path: 'rootFace', message: `rootFace "${raw.rootFace}" 不在 faces 中` }],
      warnings,
      model: null,
    };
  }

  const tree = buildTree(rootId, faceMap, creaseList, errors);
  if (errors.length > 0) return { ok: false, errors, warnings, model: null };

  // 折缝定轴向，并记录父子关系。
  const creaseMap = new Map();
  for (const crease of creaseList) {
    const parentId = tree.parentOf.get(crease.faces[0]) === crease.faces[1] ? crease.faces[1] : crease.faces[0];
    const childId = parentId === crease.faces[0] ? crease.faces[1] : crease.faces[0];
    const { axis, sign } = orientCreaseAxis(crease, faceMap, parentId, childId);
    const parentEdge = crease.edgeByFace[parentId];
    const parent = faceMap.get(parentId);
    creaseMap.set(crease.id, {
      ...crease,
      parentFace: parentId,
      childFace: childId,
      axisFlat: axis,
      axisSign: sign,
      hingePoints: [parent.vertices[parentEdge[0]], parent.vertices[parentEdge[1]]],
    });
  }

  // 目标接缝校验。
  const targets = [];
  const targetIdSeen = new Set();
  if (raw.targetSeams !== undefined) {
    if (!Array.isArray(raw.targetSeams)) {
      errors.push({ code: 'TARGETS_INVALID', path: 'targetSeams', message: 'targetSeams 必须是数组' });
    } else {
      raw.targetSeams.forEach((rt, i) => {
        if (rt && typeof rt === 'object' && targetIdSeen.has(rt.id ?? `target-${i}`)) {
          errors.push({ code: 'DUPLICATE_TARGET_ID', path: `targetSeams[${i}].id`, target: rt.id, message: `目标接缝 id "${rt.id}" 重复定义` });
          return;
        }
        if (rt && typeof rt === 'object') targetIdSeen.add(rt.id ?? `target-${i}`);
        const target = validateTarget(rt, i, faceMap, errors);
        if (target) targets.push(target);
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings, model: null };

  // DFS 顺序（运动求解按该顺序传播）。
  const order = [];
  const walk = (id) => {
    order.push(id);
    for (const child of tree.childrenOf.get(id)) walk(child);
  };
  walk(rootId);

  return {
    ok: true,
    errors,
    warnings,
    model: {
      name: typeof raw.name === 'string' ? raw.name : '未命名纸模',
      extent,
      eps: extent * GEO_EPS_FACTOR,
      faces: faceMap,
      faceOrder: order,
      creases: creaseMap,
      rootFace: rootId,
      tree,
      targets,
    },
  };
}
