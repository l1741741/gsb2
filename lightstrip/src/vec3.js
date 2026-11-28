// Minimal 3D vector helpers. Vectors are plain [x, y, z] arrays.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const distance = (a, b) => length(sub(a, b));

// Returns null for a zero-length vector instead of producing NaN.
export const normalize = (a) => {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

export const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const angleBetween = (a, b) => {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot(na, nb))));
};

// Rodrigues rotation of v around unit axis k by angle (radians).
export const rotateAroundAxis = (v, k, angle) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ];
};
