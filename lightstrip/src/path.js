import { distance, lerp } from './vec3.js';

// Centripetal Catmull-Rom evaluation between p1 and p2 (t in [0, 1]).
// Zero-length chords are floored so duplicate control points cannot produce NaN.
function catmullRom(p0, p1, p2, p3, t) {
  const chord = (a, b) => Math.sqrt(Math.max(distance(a, b), 1e-12));
  const t0 = 0;
  const t1 = t0 + chord(p0, p1);
  const t2 = t1 + chord(p1, p2);
  const t3 = t2 + chord(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const at = (a, b, ta, tb) => {
    const f = (tt - ta) / Math.max(tb - ta, 1e-12);
    return lerp(a, b, f);
  };
  const a1 = at(p0, p1, t0, t1);
  const a2 = at(p1, p2, t1, t2);
  const a3 = at(p2, p3, t2, t3);
  const b1 = at(a1, a2, t0, t2);
  const b2 = at(a2, a3, t1, t3);
  return at(b1, b2, t1, t2);
}

// Resample control points into a dense polyline.
// Returns samples plus, for each sample, which control segment it came from
// and the local parameter t (used to interpolate per-control-point widths,
// so width stays continuous across joints by construction).
export function samplePath(controlPoints, { samplesPerSegment = 16, closed = false } = {}) {
  const n = controlPoints.length;
  if (n < 2) throw new Error('path needs at least 2 control points');
  if (closed && n < 3) throw new Error('a closed path needs at least 3 control points');

  const segCount = closed ? n : n - 1;
  const samples = [];
  const sampleSegment = [];
  const sampleT = [];
  const degenerateSegments = [];

  const at = (i) => controlPoints[closed ? ((i % n) + n) % n : Math.min(Math.max(i, 0), n - 1)];

  for (let k = 0; k < segCount; k++) {
    const p0 = at(k - 1);
    const p1 = at(k);
    const p2 = at(k + 1);
    const p3 = at(k + 2);
    if (distance(p1, p2) < 1e-9) {
      degenerateSegments.push({ segment: k, point: p1, reason: 'zero-length control segment' });
    }
    // The last segment of an open path also emits its endpoint (t = 1).
    const steps = !closed && k === segCount - 1 ? samplesPerSegment + 1 : samplesPerSegment;
    for (let s = 0; s < steps; s++) {
      const t = s / samplesPerSegment;
      samples.push(catmullRom(p0, p1, p2, p3, t));
      sampleSegment.push(k);
      sampleT.push(t);
    }
  }

  // Sample index at which each control point sits (for preview markers).
  const controlIndices = controlPoints.map((_, i) =>
    closed || i < n - 1 ? i * samplesPerSegment : samples.length - 1,
  );

  const arcLengths = [0];
  for (let i = 1; i < samples.length; i++) {
    arcLengths.push(arcLengths[i - 1] + distance(samples[i - 1], samples[i]));
  }

  return { samples, sampleSegment, sampleT, controlIndices, arcLengths, degenerateSegments, closed };
}
