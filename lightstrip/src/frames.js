import { cross, dot, normalize, rotateAroundAxis, scale, sub } from './vec3.js';

// Pick any unit vector perpendicular to t, preferring world axes for stability.
function pickPerpendicular(t) {
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let best = axes[2];
  let bestDot = Infinity;
  for (const a of axes) {
    const d = Math.abs(dot(a, t));
    if (d < bestDot) {
      bestDot = d;
      best = a;
    }
  }
  return normalize(sub(best, scale(t, dot(best, t))));
}

// Parallel-transport frames along a sampled path.
//
// The normal is propagated by projecting the previous normal onto the plane
// perpendicular to the new tangent, which never flips on its own and stays
// well-defined for vertical runs and path reversals. The only failure mode is
// a tangent that jumps exactly onto the previous normal (a true 180° fold of
// the frame); that is reported as a `frame-reseed` event and the frame is
// re-seeded deterministically — never silently.
//
// For closed loops the transported frame generally mismatches across the seam
// by some twist angle; the mismatch is measured, distributed evenly over all
// rings (so first and last ring join exactly), and reported in degrees.
export function buildFrames(samples, { closed = false } = {}) {
  const count = samples.length;
  const tangents = [];
  for (let i = 0; i < count; i++) {
    let d;
    if (!closed && i === 0) d = sub(samples[1], samples[0]);
    else if (!closed && i === count - 1) d = sub(samples[count - 1], samples[count - 2]);
    else d = sub(samples[(i + 1) % count], samples[(i - 1 + count) % count]);
    tangents.push(normalize(d) ?? [0, 0, 1]);
  }

  const events = [];
  const normals = [];
  let normal = pickPerpendicular(tangents[0]);
  normals.push(normal);
  for (let i = 1; i < count; i++) {
    const t = tangents[i];
    let next = normalize(sub(normal, scale(t, dot(normal, t))));
    if (!next) {
      events.push({ type: 'frame-reseed', sampleIndex: i, reason: 'tangent aligned with transported normal' });
      next = pickPerpendicular(t);
    }
    normals.push(next);
    normal = next;
  }

  let twistDegrees = 0;
  if (closed && count > 2) {
    // Transport the last normal across the seam back onto ring 0's plane and
    // measure the signed mismatch against the first normal.
    const t0 = tangents[0];
    const across = normalize(sub(normal, scale(t0, dot(normal, t0))));
    if (across) {
      const n0 = normals[0];
      const angle = Math.atan2(dot(cross(across, n0), t0), dot(across, n0));
      twistDegrees = (angle * 180) / Math.PI;
      for (let i = 0; i < count; i++) {
        normals[i] = rotateAroundAxis(normals[i], tangents[i], -angle * (i / count));
      }
    } else {
      events.push({ type: 'frame-reseed', sampleIndex: 0, reason: 'seam transport degenerate' });
    }
  }

  const binormals = normals.map((n, i) => normalize(cross(tangents[i], n)) ?? [0, 1, 0]);
  return { tangents, normals, binormals, events, twistDegrees };
}
