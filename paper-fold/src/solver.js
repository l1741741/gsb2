// 折叠运动学：把“每条折缝转动 endAngle * t”沿折叠树传播成每个面的刚体姿态。
//
// 关键性质：
// 1. solveAt 是 t 的纯函数，不保存任何逐帧状态；任意 t 都由闭式 Rodrigues 公式直接
//    计算，因此反复往返、绕过完整角度再回来，结果位级一致，不存在累计漂移。
// 2. 子面的平移由铰链点对齐求出（t = 世界铰链点 - R * 局部铰链点），
//    同一折缝两侧的面在任意 t 始终精确接合。
// 3. 同一面通过多段串联折缝继承前面的运动：姿态 = 链上各铰链旋转的有序乘积。

import { add, identity, matApply, matMul, rotAxisAngle, sub } from './math3d.js';
import { transformTriangles } from './geometry.js';

export function clampProgress(t) {
  if (!Number.isFinite(t)) return 0;
  return Math.min(1, Math.max(0, t));
}

// 返回 Map：faceId -> {
//   rotation, translation, points: 世界坐标顶点, triangles: 世界坐标三角形,
//   normal, centroid, hingeAngle
// }
export function solveAt(model, progress) {
  const t = clampProgress(progress);
  const { faces, faceOrder, tree, creases, rootFace } = model;
  const poses = new Map();

  for (const faceId of faceOrder) {
    const face = faces.get(faceId);
    if (faceId === rootFace) {
      const rotation = identity();
      const translation = [0, 0, 0];
      poses.set(faceId, buildPose(face, rotation, translation, 0));
      continue;
    }

    const parentId = tree.parentOf.get(faceId);
    const parentPose = poses.get(parentId);
    const crease = creases.get(tree.creaseOf.get(faceId).id);

    // 铰链轴随父面运动到当前世界方向（仍是单位向量，旋转保持长度）。
    const worldAxis = matApply(parentPose.rotation, crease.axisFlat);
    // axisSign 已使“正转角”把子面中心抬向板面法线（谷折 valley）；
    // 山折 mountain 反向折，整体取负号。
    const directionSign = crease.direction === 'mountain' ? -1 : 1;
    const hingeAngle = directionSign * crease.axisSign * crease.endAngle * t;
    const hingeRotation = rotAxisAngle(worldAxis, hingeAngle);

    // 子面相对世界的旋转 = 绕世界铰链轴的旋转 * 父面旋转。
    const rotation = matMul(hingeRotation, parentPose.rotation);

    // 平移按铰链点对齐：取折缝在父面上的端点（展开板上与子面端点重合的同一点）。
    const hingeLocal = crease.hingePoints[0];
    const hingeWorld = add(matApply(parentPose.rotation, hingeLocal), parentPose.translation);
    const translation = sub(hingeWorld, matApply(rotation, hingeLocal));

    poses.set(faceId, buildPose(face, rotation, translation, hingeAngle));
  }
  return poses;
}

function buildPose(face, rotation, translation, hingeAngle) {
  const points = face.vertices.map((p) => add(matApply(rotation, p), translation));
  const triangles = transformTriangles(face.triangles, face.vertices, rotation, translation);
  const normal = matApply(rotation, face.normal);
  const centroid = add(matApply(rotation, face.centroid), translation);
  return { rotation, translation, points, triangles, normal, centroid, hingeAngle };
}
