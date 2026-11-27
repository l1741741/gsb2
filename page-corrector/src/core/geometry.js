// 几何核心：四角校验、单应矩阵、坐标映射与透视重采样。
// 本模块不依赖 DOM，可直接在 Node 中测试。
//
// 角点顺序固定为 左上(TL) -> 右上(TR) -> 右下(BR) -> 左下(BL)，
// 坐标单位是「源图像素」，y 轴向下（与 Canvas 一致）。

export const CORNER_KEYS = ['tl', 'tr', 'br', 'bl'];
export const CORNER_LABELS = ['左上角', '右上角', '右下角', '左下角'];

/** 按图像对角线长度推算「几乎重合」的判定距离（源图像素）。 */
export function defaultMinDistance(imageWidth, imageHeight, fraction = 0.02) {
  const w = Number(imageWidth) || 0;
  const h = Number(imageHeight) || 0;
  return fraction * Math.hypot(w, h);
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

/** 三点有向面积的两倍（y 向下，正值表示顺时针转折）。 */
function orient(a, b, c) {
  return cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
}

const EPS = 1e-9;

function onSegment(a, p, b) {
  return (
    orient(a, p, b) === 0 &&
    p.x >= Math.min(a.x, b.x) - EPS &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

/**
 * 线段 ab 与 cd 是否相交（包含端点接触与共线重叠）。
 * 对角边没有公共端点，因此端点接触也应判为交叉/重合退化。
 */
export function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);

  if (Math.abs(o1) < EPS && onSegment(a, c, b)) return true;
  if (Math.abs(o2) < EPS && onSegment(a, d, b)) return true;
  if (Math.abs(o3) < EPS && onSegment(c, a, d)) return true;
  if (Math.abs(o4) < EPS && onSegment(c, b, d)) return true;

  return (
    (o1 > EPS && o2 < -EPS || o1 < -EPS && o2 > EPS) &&
    (o3 > EPS && o4 < -EPS || o3 < -EPS && o4 > EPS)
  );
}

/**
 * 校验四角。返回问题列表，每个问题：
 *   { code, corners:number[], message:string }
 * 没有问题时返回空数组（表示四边形可用）。
 */
export function validateQuad(corners, options = {}) {
  const issues = [];
  if (!Array.isArray(corners) || corners.length !== 4) {
    return [{ code: 'count', corners: [], message: '需要恰好四个角点' }];
  }
  corners.forEach((p, i) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      issues.push({ code: 'non-finite', corners: [i], message: `${CORNER_LABELS[i]}坐标无效` });
    }
  });
  if (issues.length) return issues;

  const minDistance = Number.isFinite(options.minDistance) ? options.minDistance : 1e-6;

  // 1) 任意两角几乎重合
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      if (distance(corners[i], corners[j]) < minDistance) {
        issues.push({
          code: 'coincident',
          corners: [i, j],
          message: `${CORNER_LABELS[i]}与${CORNER_LABELS[j]}几乎重合`,
        });
      }
    }
  }

  // 2) 两组对边交叉：顶边(0-1) vs 底边(2-3)，右边(1-2) vs 左边(3-0)
  if (segmentsIntersect(corners[0], corners[1], corners[2], corners[3])) {
    issues.push({
      code: 'crossed',
      edges: [[0, 1], [2, 3]],
      corners: [0, 1, 2, 3],
      message: '顶边与底边发生交叉',
    });
  }
  if (segmentsIntersect(corners[1], corners[2], corners[3], corners[0])) {
    issues.push({
      code: 'crossed',
      edges: [[1, 2], [3, 0]],
      corners: [1, 2, 3, 0],
      message: '左边与右边发生交叉',
    });
  }

  // 3) 退化/内凹：在没有重合与交叉时再检查，避免重复噪声
  if (!issues.length) {
    const turns = [
      orient(corners[0], corners[1], corners[2]), // 转折发生在角 1
      orient(corners[1], corners[2], corners[3]), // 角 2
      orient(corners[2], corners[3], corners[0]), // 角 3
      orient(corners[3], corners[0], corners[1]), // 角 0
    ];
    const scale = Math.max(1, minDistance * minDistance);
    const positive = turns.filter((t) => t > scale * 1e-6).length;
    const negative = turns.filter((t) => t < -scale * 1e-6).length;
    const nearZeroIndex = turns.findIndex((t) => Math.abs(t) <= scale * 1e-6);
    if (nearZeroIndex !== -1) {
      const cornerIndex = (nearZeroIndex + 1) % 4;
      issues.push({
        code: 'collinear',
        corners: [cornerIndex],
        message: `${CORNER_LABELS[cornerIndex]}几乎落在边上，四边形退化`,
      });
    } else if (positive > 0 && negative > 0) {
      // 与多数转向相反的那个角就是内凹角
      const wantPositive = positive >= negative;
      const turnIndex = turns.findIndex((t) => (wantPositive ? t < 0 : t > 0));
      const cornerIndex = (turnIndex + 1) % 4;
      issues.push({
        code: 'concave',
        corners: [cornerIndex],
        message: `${CORNER_LABELS[cornerIndex]}内凹，四角需围成外凸四边形`,
      });
    }
  }

  return issues;
}

/**
 * 拖动某个角被拒绝时，给出面向操作者的提示，明确「哪个角要调整」。
 * 返回 { message:string, badCorners:number[] }。
 */
export function rejectionHint(issues, dragIndex) {
  const badCorners = new Set();
  let primary = null;

  for (const issue of issues) {
    issue.corners.forEach((i) => badCorners.add(i));
    if (issue.code === 'coincident') {
      const other = issue.corners.find((i) => i !== dragIndex);
      if (issue.corners.includes(dragIndex) && other !== undefined) {
        primary = `「${CORNER_LABELS[dragIndex]}」与「${CORNER_LABELS[other]}」几乎重合，本次拖动已拒绝；请把「${CORNER_LABELS[dragIndex]}」向外拖开，或调整「${CORNER_LABELS[other]}」。`;
      }
    } else if (issue.code === 'crossed') {
      if (issue.edges?.some(([a, b]) => a === dragIndex || b === dragIndex)) {
        const opposite = (dragIndex + 2) % 4;
        primary = `再拖会让${issue.message}，本次移动已拒绝；请调整当前的「${CORNER_LABELS[dragIndex]}」或对角的「${CORNER_LABELS[opposite]}」。`;
      } else if (!primary) {
        primary = `${issue.message}，请调整高亮的角。`;
      }
    } else if (issue.code === 'concave' || issue.code === 'collinear') {
      const bad = issue.corners[0];
      primary = `${issue.message}；请调整高亮的「${CORNER_LABELS[bad]}」（当前拖动：${CORNER_LABELS[dragIndex]}）。`;
    }
  }

  if (!primary) {
    const names = [...badCorners].map((i) => CORNER_LABELS[i]).join('、');
    primary = names ? `四角关系无效，请调整：${names}` : '四角关系无效，本次拖动已拒绝。';
  }
  return { message: primary, badCorners: [...badCorners] };
}

// ---------------------------------------------------------------------------
// 单应矩阵（DLT + 高斯消元），行优先 9 元素数组，h[8] = 1。
// ---------------------------------------------------------------------------

function solveLinear8(A, b) {
  const n = 8;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) {
      throw new Error('单应矩阵无解：对应点可能退化');
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];

    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) m[r][c] -= factor * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** 由 4 对对应点求单应矩阵 H，使 dst ≈ H · src（齐次坐标）。 */
export function findHomography(srcPoints, dstPoints) {
  if (!Array.isArray(srcPoints) || srcPoints.length !== 4) {
    throw new TypeError('需要 4 个源点');
  }
  if (!Array.isArray(dstPoints) || dstPoints.length !== 4) {
    throw new TypeError('需要 4 个目标点');
  }
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = srcPoints[i];
    const { x: u, y: v } = dstPoints[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear8(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 三阶矩阵求逆（行优先）。 */
export function invertMatrix3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('矩阵不可逆');
  const invDet = 1 / det;
  return [
    A * invDet,
    (c * h - b * i) * invDet,
    (b * f - c * e) * invDet,
    B * invDet,
    (a * i - c * g) * invDet,
    (c * d - a * f) * invDet,
    C * invDet,
    (b * g - a * h) * invDet,
    (a * e - b * d) * invDet,
  ];
}

/** 用 H 映射点，返回 {x,y}。 */
export function mapPoint(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

/** 四角 -> 纸面归一化坐标 [0,1]² 的映射（源像素 → 纸面）。 */
export function sourcePixelsToPaperNorm(cornersPx) {
  const paper = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  return findHomography(cornersPx, paper);
}

/** 纸面归一化坐标 -> 源像素。 */
export function paperNormToSourcePixels(cornersPx) {
  return invertMatrix3(sourcePixelsToPaperNorm(cornersPx));
}

/** 归一化角点（相对源图宽高）转源像素角点。 */
export function normalizedCornersToPixels(cornersNorm, width, height) {
  return cornersNorm.map((p) => ({ x: p.x * width, y: p.y * height }));
}

/** 源像素角点转归一化角点。 */
export function pixelCornersToNormalized(cornersPx, width, height) {
  return cornersPx.map((p) => ({ x: p.x / width, y: p.y / height }));
}

export function paperPixelSize(ratio, outputWidth, maxDimension = 8000) {
  const r = Number(ratio) > 0 ? Number(ratio) : Math.SQRT2;
  let width = Math.max(1, Math.round(Number(outputWidth) || 1600));
  let height = Math.max(1, Math.round(width / r));
  const longest = Math.max(width, height);
  if (longest > maxDimension) {
    const k = maxDimension / longest;
    width = Math.max(1, Math.round(width * k));
    height = Math.max(1, Math.round(height * k));
  }
  return { width, height };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 通用单应重采样：遍历目标图每个像素中心，用 H_DST_TO_SRC 反查到源图，
 * 双线性采样。source 为类 ImageData：{width,height,data:Uint8ClampedArray}。
 *
 * edge:
 *   'clamp'       越界坐标夹到边缘（整页校正用，四边形在图内）
 *   'transparent' 反查点在源图外时输出全透明（生成斜拍示例用）
 *
 * 返回 { width, height, data:Uint8ClampedArray }。
 */
export async function warpImage(source, HDstToSrc, dstWidth, dstHeight, options = {}) {
  const { width: sw, height: sh, data: sd } = source;
  const dw = Math.max(1, Math.round(dstWidth));
  const dh = Math.max(1, Math.round(dstHeight));
  const out = new Uint8ClampedArray(dw * dh * 4);
  const edge = options.edge === 'transparent' ? 'transparent' : 'clamp';
  const signal = options.signal;
  const yieldRows = options.yieldRows ?? 32;

  for (let dy = 0; dy < dh; dy += 1) {
    if (signal) {
      if (signal.cancelled) {
        const err = new Error('已取消');
        err.code = 'CANCELLED';
        throw err;
      }
    }
    if (options.onRow && dy % yieldRows === 0) options.onRow(dy, dh);
    if (dy > 0 && dy % yieldRows === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const py = dy + 0.5;
    for (let dx = 0; dx < dw; dx += 1) {
      const px = dx + 0.5;
      const w = HDstToSrc[6] * px + HDstToSrc[7] * py + HDstToSrc[8];
      const sx = (HDstToSrc[0] * px + HDstToSrc[1] * py + HDstToSrc[2]) / w;
      const sy = (HDstToSrc[3] * px + HDstToSrc[4] * py + HDstToSrc[5]) / w;
      const di = (dy * dw + dx) * 4;

      if (edge === 'transparent') {
        if (sx < 0 || sy < 0 || sx > sw || sy > sh) {
          out[di + 3] = 0;
          continue;
        }
      }

      // 纹素中心位于 (i+0.5, j+0.5)，换算到「整数纹素格点」做双线性。
      let fx = clamp(sx - 0.5, 0, sw - 1);
      let fy = clamp(sy - 0.5, 0, sh - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      for (let c = 0; c < 4; c += 1) {
        out[di + c] =
          sd[i00 + c] * w00 +
          sd[i10 + c] * w10 +
          sd[i01 + c] * w01 +
          sd[i11 + c] * w11;
      }
    }
  }
  if (options.onRow) options.onRow(dh, dh);
  return { width: dw, height: dh, data: out };
}

/**
 * 计算「输出纸面像素坐标 → 源像素」的矩阵。
 * 输出像素四角为 (0,0)-(W,0)-(W,H)-(0,H)（用外边界，与像素中心采样配合）。
 */
export function outputPixelsToSourceHomography(cornersPx, outWidth, outHeight) {
  const outputCorners = [
    { x: 0, y: 0 },
    { x: outWidth, y: 0 },
    { x: outWidth, y: outHeight },
    { x: 0, y: outHeight },
  ];
  return findHomography(outputCorners, cornersPx);
}
