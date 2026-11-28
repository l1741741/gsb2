// Built-in closed cross-sections, wound counter-clockwise in the local frame
// (x = across the strip, scaled by the path width; y = thickness, absolute).
// Custom profiles can be supplied inline in a case file as { points: [[x, y], ...] }.

export const profiles = {
  'flat-strip': {
    points: [
      [-0.5, -0.08],
      [0.5, -0.08],
      [0.5, 0.08],
      [-0.5, 0.08],
    ],
  },
  'beveled-strip': {
    points: [
      [-0.5, -0.06],
      [0.5, -0.06],
      [0.56, -0.02],
      [0.56, 0.02],
      [0.5, 0.06],
      [-0.5, 0.06],
      [-0.56, 0.02],
      [-0.56, -0.02],
    ],
  },
  't-profile': {
    points: [
      [-0.08, -0.2],
      [0.08, -0.2],
      [0.08, 0.02],
      [0.5, 0.02],
      [0.5, 0.14],
      [-0.5, 0.14],
      [-0.5, 0.02],
      [-0.08, 0.02],
    ],
  },
};

export function resolveProfile(profile) {
  if (typeof profile === 'string') {
    const found = profiles[profile];
    if (!found) {
      throw new Error(`unknown profile "${profile}"; available: ${Object.keys(profiles).join(', ')}`);
    }
    return found;
  }
  if (profile && Array.isArray(profile.points) && profile.points.length >= 3) {
    return profile;
  }
  throw new Error('profile must be a built-in name or { points: [[x, y], ...] } with >= 3 points');
}

// Signed area (shoelace); positive means counter-clockwise.
export function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}
