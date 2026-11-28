// 简易轨道相机与 Canvas 2D 绘制辅助：正交投影、世界->屏幕变换、面拾取。
// 与渲染器基线一样只依赖 Canvas 2D 原语，不引入任何第三方包。

export class OrbitCamera {
  constructor({ width, height, extent = 1 } = {}) {
    this.width = width;
    this.height = height;
    this.yaw = -0.6;
    this.pitch = 0.9;
    this.zoom = 1;
    this.extent = extent;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  // 世界坐标 -> 相机坐标。先绕 z 转 yaw，再绕 x 转 pitch。
  toCamera(p) {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const x1 = cy * p[0] - sy * p[1];
    const y1 = sy * p[0] + cy * p[1];
    const z1 = p[2];
    const y2 = cp * y1 - sp * z1;
    const z2 = sp * y1 + cp * z1;
    return [x1, y2, z2];
  }

  // 世界 -> 屏幕像素。
  project(p) {
    const c = this.toCamera(p);
    const fit = Math.min(this.width, this.height) / (this.extent * 2.6);
    return {
      x: this.width / 2 + c[0] * fit * this.zoom,
      y: this.height / 2 - c[1] * fit * this.zoom,
      depth: c[2],
    };
  }

  // 屏幕点到某世界三角形的拾取：把三角形与点一起投影到屏幕做二维包含测试，
  // 配合 painter 深度排序由外部决定取最前面的命中面。
  hitFace(screenPoint, worldTriangles) {
    const hits = [];
    for (const [faceId, tris] of worldTriangles) {
      let depthSum = 0;
      let inside = false;
      for (const tri of tris) {
        const screen = tri.map((p) => this.project(p));
        depthSum += screen.reduce((acc, s) => acc + s.depth, 0);
        if (pointInTriangle2(screenPoint, screen[0], screen[1], screen[2])) inside = true;
      }
      if (inside) hits.push({ faceId, depth: depthSum / tris.length / 3 });
    }
    hits.sort((a, b) => a.depth - b.depth); // 相机深度越小越靠前
    return hits.length > 0 ? hits[0].faceId : null;
  }
}

function pointInTriangle2(p, a, b, c) {
  const area = (b.x - c.x) * (a.y - c.y) - (c.y - b.y) * (a.x - c.x);
  if (Math.abs(area) < 1e-12) return false;
  const s = ((b.x - c.x) * (p.y - c.y) - (c.y - b.y) * (p.x - c.x)) / area;
  const t = ((c.x - a.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x)) / area;
  return s >= 0 && t >= 0 && s + t <= 1;
}

// 把每个面拆成带平均相机深度的屏幕三角形，供 painter 算法从后向前绘制。
export function buildDrawList(camera, faces, poses) {
  const drawList = [];
  for (const faceId of faces) {
    const pose = poses.get(faceId);
    for (const tri of pose.triangles) {
      const projected = tri.map((p) => camera.project(p));
      const depth = projected.reduce((acc, p) => acc + p.depth, 0) / 3;
      drawList.push({ faceId, projected, depth });
    }
  }
  drawList.sort((a, b) => b.depth - a.depth);
  return drawList;
}

// 绘制一个面的轮廓（用于选中高亮）。
export function drawFaceOutline(ctx, camera, points) {
  ctx.beginPath();
  points.forEach((p, i) => {
    const s = camera.project(p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.stroke();
}

export function drawSegment(ctx, camera, a, b) {
  const sa = camera.project(a);
  const sb = camera.project(b);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  ctx.lineTo(sb.x, sb.y);
  ctx.stroke();
}
