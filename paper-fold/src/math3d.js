// 轻量三维向量与矩阵工具。
// 约定：向量为普通数组 [x, y, z]；矩阵为行主序的 3x3 嵌套数组，作用于列向量。
// 全部为纯函数，不做就地修改，保证同一输入永远得到同一输出（折叠求解可重复的基础）。

export const vec = (x = 0, y = 0, z = 0) => [x, y, z];

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

export const neg = (a) => [-a[0], -a[1], -a[2]];

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const length = (a) => Math.hypot(a[0], a[1], a[2]);

export const distance = (a, b) => length(sub(a, b));

export function normalize(a) {
  const len = length(a);
  if (len === 0) throw new RangeError('cannot normalize a zero-length vector');
  return [a[0] / len, a[1] / len, a[2] / len];
}

export const identity = () => [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export function matMul(a, b) {
  const result = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      result[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return result;
}

export const matApply = (m, p) => [
  m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
  m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
  m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2],
];

// Rodrigues 旋转公式：绕单位轴 axis 旋转 angle 弧度，返回 3x3 旋转矩阵。
// 这是闭式公式（非逐帧累加），任意角度都直接由 angle 计算，因此绕回初始角度后
// 不会产生累计误差。
export function rotAxisAngle(axis, angle) {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  return [
    [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
  ];
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const lerp = (a, b, t) => a + (b - a) * t;

// 相对容差：按模型尺寸缩放，避免大模型误判、小模型漏判。
export const relativeEpsilon = (extent, factor = 1e-9) => Math.max(1e-12, extent * factor);
