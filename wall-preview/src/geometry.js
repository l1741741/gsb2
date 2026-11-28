// 弧形展墙（圆柱片）几何核心。纯函数，无 DOM 依赖，可在 Node 中直接测试。
// 约定：
// - 角度单位为度，沿墙表面从起始角向结束角递增。
// - 展开坐标：x = 距起始边的弧长（mm），y = 距墙底边的高度（mm）。
// - 满圈（跨度恰为 360°）时角度/弧长按周长回绕，跨起止缝的图案自然接续；
//   不足一圈时不回绕，越界一律返回 null（空白区绝不重复贴图）。

export const FULL_CIRCLE_EPSILON_DEG = 1e-9;
export const ANCHOR_CONFLICT_EPSILON_MM = 1;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateWall(params) {
  const errors = [];
  const { radiusMm, startAngleDeg, endAngleDeg, heightMm } = params ?? {};
  if (!isFiniteNumber(radiusMm) || radiusMm <= 0) {
    errors.push(`半径必须为正数（当前：${radiusMm}）`);
  }
  if (!isFiniteNumber(heightMm) || heightMm <= 0) {
    errors.push(`墙高必须为正数（当前：${heightMm}）`);
  }
  if (!isFiniteNumber(startAngleDeg)) {
    errors.push(`起始角必须是有限数值（当前：${startAngleDeg}）`);
  }
  if (!isFiniteNumber(endAngleDeg)) {
    errors.push(`结束角必须是有限数值（当前：${endAngleDeg}）`);
  }
  if (isFiniteNumber(startAngleDeg) && isFiniteNumber(endAngleDeg)) {
    const span = endAngleDeg - startAngleDeg;
    if (span <= 0) {
      errors.push(`结束角必须大于起始角（起始 ${startAngleDeg}°，结束 ${endAngleDeg}°）`);
    } else if (span > 360 + FULL_CIRCLE_EPSILON_DEG) {
      errors.push(`角度跨度不能超过 360°（当前 ${span}°）`);
    }
  }
  return errors;
}

export function makeWall(params) {
  const errors = validateWall(params);
  if (errors.length > 0) {
    const error = new Error(errors.join('；'));
    error.validationErrors = errors;
    throw error;
  }
  const { radiusMm, startAngleDeg, endAngleDeg, heightMm } = params;
  return Object.freeze({ radiusMm, startAngleDeg, endAngleDeg, heightMm });
}

export function wallSpanDeg(wall) {
  return wall.endAngleDeg - wall.startAngleDeg;
}

export function isFullCircle(wall) {
  return Math.abs(wallSpanDeg(wall) - 360) < FULL_CIRCLE_EPSILON_DEG;
}

/** 墙面展开总长（mm）。 */
export function arcLengthMm(wall) {
  return wall.radiusMm * wallSpanDeg(wall) * DEG2RAD;
}

/**
 * 把距起始边的弧长归一化到墙面上。
 * 满圈：按周长回绕（跨缝接续）。不足一圈：越界返回 null（不重复）。
 */
export function normalizeArcMm(wall, arcMm) {
  if (!isFiniteNumber(arcMm)) return null;
  const length = arcLengthMm(wall);
  if (isFullCircle(wall)) {
    return ((arcMm % length) + length) % length;
  }
  const eps = 1e-6;
  if (arcMm < -eps || arcMm > length + eps) return null;
  return Math.min(Math.max(arcMm, 0), length);
}

/** 弧长（距起始边 mm）→ 角度（度）。满圈时回绕到 [起始角, 起始角+360)。 */
export function angleAtArcMm(wall, arcMm) {
  const arc = normalizeArcMm(wall, arcMm);
  if (arc === null) return null;
  return wall.startAngleDeg + (arc / wall.radiusMm) * RAD2DEG;
}

/** 角度（度）→ 距起始边的弧长（mm）。不在墙面上时返回 null。 */
export function arcAtAngleDeg(wall, angleDeg) {
  if (!isFiniteNumber(angleDeg)) return null;
  const span = wallSpanDeg(wall);
  let rel = angleDeg - wall.startAngleDeg;
  if (isFullCircle(wall)) {
    rel = ((rel % 360) + 360) % 360;
  } else {
    const eps = 1e-9;
    if (rel < -eps || rel > span + eps) return null;
    rel = Math.min(Math.max(rel, 0), span);
  }
  return wall.radiusMm * rel * DEG2RAD;
}

/**
 * 画面（贴图）在墙面某弧长处的覆盖情况。
 * 返回 { u }（u ∈ [0,1)，沿画面宽度的归一化位置）；未被画面覆盖时返回 null。
 * 满圈时弧长先按周长回绕，因此跨过起止缝的画面部分能正确接续；
 * 不足一圈时越界直接返回 null，空白区不会误重复贴图。
 */
export function artworkCoverageAtArc(wall, artwork, arcMm) {
  const arc = normalizeArcMm(wall, arcMm);
  if (arc === null) return null;
  let local = arc - artwork.offsetMm;
  if (isFullCircle(wall)) {
    const length = arcLengthMm(wall);
    local = ((local % length) + length) % length;
  }
  if (local < 0 || local >= artwork.widthMm) return null;
  return { u: local / artwork.widthMm };
}

export function validateArtwork(wall, artwork) {
  const errors = [];
  if (!artwork) return errors;
  const length = arcLengthMm(wall);
  const { offsetMm, widthMm, bottomMm, heightMm } = artwork;
  if (!isFiniteNumber(widthMm) || widthMm <= 0) {
    errors.push(`画面宽度必须为正数（当前：${widthMm}）`);
  }
  if (!isFiniteNumber(heightMm) || heightMm <= 0) {
    errors.push(`画面高度必须为正数（当前：${heightMm}）`);
  }
  if (!isFiniteNumber(offsetMm)) {
    errors.push(`画面水平偏移必须是有限数值（当前：${offsetMm}）`);
  }
  if (!isFiniteNumber(bottomMm)) {
    errors.push(`画面底边高度必须是有限数值（当前：${bottomMm}）`);
  }
  if (errors.length > 0) return errors;
  if (widthMm > length + 1e-6) {
    errors.push(`画面宽度 ${widthMm}mm 超过墙面展开长度 ${length.toFixed(1)}mm`);
  }
  if (bottomMm < 0 || bottomMm + heightMm > wall.heightMm + 1e-6) {
    errors.push(`画面垂直范围 ${bottomMm}–${bottomMm + heightMm}mm 超出墙高 0–${wall.heightMm}mm`);
  }
  if (!isFullCircle(wall)) {
    if (offsetMm < 0 || offsetMm + widthMm > length + 1e-6) {
      errors.push(
        `不足一圈时画面必须落在墙面内：当前水平范围 ${offsetMm}–${offsetMm + widthMm}mm，` +
        `允许 0–${length.toFixed(1)}mm（满圈时才允许跨起止缝回绕）`,
      );
    }
  }
  return errors;
}

/**
 * 定位点到墙四边的实际距离（mm）。只由墙面几何决定，与观察方向无关：
 * 翻面观看时投影会镜像，但这组距离保持不变。
 */
export function anchorEdgeDistances(wall, anchor) {
  const length = arcLengthMm(wall);
  return {
    toStartEdgeMm: anchor.arcMm,
    toEndEdgeMm: length - anchor.arcMm,
    toBottomMm: anchor.heightMm,
    toTopMm: wall.heightMm - anchor.heightMm,
  };
}

export function validateAnchors(wall, anchors) {
  const errors = [];
  const length = arcLengthMm(wall);
  const seenIds = new Set();
  anchors.forEach((anchor, index) => {
    const label = anchor.name || anchor.id || `#${index + 1}`;
    if (!anchor.id) {
      errors.push(`定位点 ${label} 缺少 id`);
    } else if (seenIds.has(anchor.id)) {
      errors.push(`定位点 id 重复：${anchor.id}`);
    }
    seenIds.add(anchor.id);
    if (!isFiniteNumber(anchor.arcMm) || anchor.arcMm < 0 || anchor.arcMm > length + 1e-6) {
      errors.push(`定位点 ${label} 的水平位置超出墙面（${anchor.arcMm}mm，允许 0–${length.toFixed(1)}mm）`);
    }
    if (!isFiniteNumber(anchor.heightMm) || anchor.heightMm < 0 || anchor.heightMm > wall.heightMm + 1e-6) {
      errors.push(`定位点 ${label} 的高度超出墙面（${anchor.heightMm}mm，允许 0–${wall.heightMm}mm）`);
    }
  });
  for (let i = 0; i < anchors.length; i += 1) {
    for (let j = i + 1; j < anchors.length; j += 1) {
      const a = anchors[i];
      const b = anchors[j];
      if (!isFiniteNumber(a.arcMm) || !isFiniteNumber(b.arcMm)) continue;
      if (!isFiniteNumber(a.heightMm) || !isFiniteNumber(b.heightMm)) continue;
      if (
        Math.abs(a.arcMm - b.arcMm) < ANCHOR_CONFLICT_EPSILON_MM &&
        Math.abs(a.heightMm - b.heightMm) < ANCHOR_CONFLICT_EPSILON_MM
      ) {
        const labelA = a.name || a.id;
        const labelB = b.name || b.id;
        errors.push(
          `定位点 ${labelA} 与 ${labelB} 位置冲突（相距不足 ${ANCHOR_CONFLICT_EPSILON_MM}mm，` +
          `均在 (${a.arcMm}, ${a.heightMm}) 附近）`,
        );
      }
    }
  }
  return errors;
}

/**
 * 把墙面上一点投影到观察平面（用于墙体预览）。
 * centerAngleDeg：视线正对的角度；side：'front' 外侧 / 'back' 内侧（翻面）。
 * 返回 { x, y, facing }：x 为水平投影（翻面时镜像），facing 表示该点朝向观察者。
 * 注意：这里只影响屏幕位置，定位点的到边距离由 anchorEdgeDistances 给出，不随翻面改变。
 */
export function projectPoint(wall, arcMm, heightMm, { centerAngleDeg, side = 'front' } = {}) {
  const angleDeg = angleAtArcMm(wall, arcMm);
  if (angleDeg === null) return null;
  const center = centerAngleDeg ?? wall.startAngleDeg + wallSpanDeg(wall) / 2;
  const rel = (angleDeg - center) * DEG2RAD;
  const sign = side === 'back' ? -1 : 1;
  return {
    x: sign * wall.radiusMm * Math.sin(rel),
    y: heightMm,
    facing: Math.cos(rel) > 0,
  };
}
