/**
 * hex.ts — 尖顶六边格（pointy-top）轴坐标数学。
 *
 * 视线裁定使用一套仿射整数坐标 (U,V)：
 *   U = 2q + r
 *   V = 3r
 * 六边格中心在 (U,V) 下全是整数，六个顶点也是整数，
 * 因此“视线刚好擦过顶点/边沿”可以用整数 + 精确分数裁定，
 * 不依赖浮点 epsilon。UV 是世界坐标的各向异性缩放（仿射变换），
 * 直线段与参数 t 在变换下保持不变。
 */

export interface Axial {
  q: number;
  r: number;
}

export interface UV {
  u: number;
  v: number;
}

export interface Pixel {
  x: number;
  y: number;
}

/** 尖顶六边格的六个相邻方向（轴坐标，顺序：东、东北、西北、西、西南、东南）。 */
export const HEX_DIRECTIONS: readonly Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
] as const;

export function keyOf(a: Axial): string {
  return `${a.q},${a.r}`;
}

export function parseKey(k: string): Axial {
  const i = k.indexOf(',');
  return { q: Number(k.slice(0, i)), r: Number(k.slice(i + 1)) };
}

export function sameHex(a: Axial, b: Axial): boolean {
  return a.q === b.q && a.r === b.r;
}

export function addHex(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}

/** 六边格距离（轴坐标 / 立方坐标）。 */
export function hexDistance(a: Axial, b: Axial): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

export function neighbors(a: Axial): Axial[] {
  return HEX_DIRECTIONS.map((d) => addHex(a, d));
}

export function toUV(a: Axial): UV {
  return { u: 2 * a.q + a.r, v: 3 * a.r };
}

export function fromUV(p: UV): Axial | null {
  if (p.v % 3 !== 0) return null;
  const r = p.v / 3;
  const twoQPlusR = p.u;
  if ((twoQPlusR - r) % 2 !== 0) return null;
  const q = (twoQPlusR - r) / 2;
  return { q, r };
}

/**
 * UV 坐标下六边格的六个顶点（相对格心，整数），顺序首尾相接：
 * (1,1) (0,2) (-1,1) (-1,-1) (0,-2) (1,-1)
 */
export const HEX_VERTICES_UV: readonly UV[] = [
  { u: 1, v: 1 },
  { u: 0, v: 2 },
  { u: -1, v: 1 },
  { u: -1, v: -1 },
  { u: 0, v: -2 },
  { u: 1, v: -1 },
] as const;

/** 尖顶六边格：轴坐标 -> 像素中心。size 为外接圆半径。 */
export function axialToPixel(a: Axial, size: number): Pixel {
  return {
    x: size * Math.sqrt(3) * (a.q + a.r / 2),
    y: size * 1.5 * a.r,
  };
}

/** UV -> 像素：x = sqrt(3)*size/2 * U，y = size/2 * V。 */
export function uvToPixel(p: UV, size: number): Pixel {
  return { x: (Math.sqrt(3) * size * p.u) / 2, y: (size * p.v) / 2 };
}

/** 像素 -> 浮点轴坐标（配合 axialRound 做点选）。 */
export function pixelToAxialFloat(p: Pixel, size: number): Axial {
  const q = ((Math.sqrt(3) / 3) * p.x - (1 / 3) * p.y) / size;
  const r = ((2 / 3) * p.y) / size;
  return { q, r };
}

/** 立方坐标舍入，把浮点轴坐标吸附到最近六边格。 */
export function axialRound(f: Axial): Axial {
  let x = f.q;
  let z = f.r;
  let y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);
  if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
  else if (yDiff > zDiff) ry = -rx - rz;
  else rz = -rx - ry;
  // 归一化 -0，避免地图键出现 "-0,r" 与 "0,r" 两个格。
  return { q: rx === 0 ? 0 : rx, r: rz === 0 ? 0 : rz };
}

export function pixelToHex(p: Pixel, size: number): Axial {
  return axialRound(pixelToAxialFloat(p, size));
}

/** 半径 radius 的六边形地图包含的全部轴坐标。 */
export function hexRadiusTiles(radius: number): Axial[] {
  const out: Axial[] = [];
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) out.push({ q, r });
  }
  return out;
}
