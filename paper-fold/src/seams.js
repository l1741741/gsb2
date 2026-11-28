// 目标接缝的合拢度量：两条自由边在当前姿态下还差多远。
// 接缝端点可能以任一顺序对应，取两种配对中最大端点偏差较小的一种。

import { distance, sub } from './math3d.js';

function worldEdge(pose, edge) {
  return [pose.points[edge[0]], pose.points[edge[1]]];
}

// target: { id, edges: [{ face, edge: [i,j] }, { face, edge: [i,j] }] }
export function seamGap(model, poses, target) {
  const [specA, specB] = target.edges;
  const [a0, a1] = worldEdge(poses.get(specA.face), specA.edge);
  const [b0, b1] = worldEdge(poses.get(specB.face), specB.edge);

  const pairings = [
    [distance(a0, b0), distance(a1, b1)],
    [distance(a0, b1), distance(a1, b0)],
  ];
  const scores = pairings.map((d) => Math.max(d[0], d[1]));
  const reversed = scores[1] < scores[0];
  const endpointDistances = pairings[reversed ? 1 : 0];
  const gap = Math.max(...endpointDistances);

  const midA = [(a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2, (a0[2] + a1[2]) / 2];
  const midB = [(b0[0] + b1[0]) / 2, (b0[1] + b1[1]) / 2, (b0[2] + b1[2]) / 2];
  const midpointGap = distance(midA, midB);

  // 边长差用于发现“边对上了但长度不一致”的建模问题。
  const lengthA = distance(a0, a1);
  const lengthB = distance(b0, b1);
  const lengthMismatch = Math.abs(lengthA - lengthB);

  return {
    id: target.id,
    gap,
    endpointDistances,
    midpointGap,
    lengthMismatch,
    reversed,
    closed: gap <= model.eps * 100,
    points: { a: [a0, a1], b: [b0, b1] },
    direction: sub(midB, midA),
  };
}

export function allSeamGaps(model, poses) {
  return model.targets.map((target) => ({ target, result: seamGap(model, poses, target) }));
}
