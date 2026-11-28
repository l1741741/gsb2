// Ear-clipping triangulation of a simple (non-self-intersecting) 2D polygon.
// Works for concave profiles; a centroid fan would spill outside them.
// Returns index triples wound like the input (CCW input -> CCW triangles).

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function inTriangle(p, a, b, c) {
  const d1 = cross2(a, b, p);
  const d2 = cross2(b, c, p);
  const d3 = cross2(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

export function triangulatePolygon(points) {
  if (points.length < 3) throw new Error('profile needs at least 3 points to triangulate');
  const remaining = [...Array(points.length).keys()];
  if (signedArea(points) < 0) remaining.reverse();
  const triangles = [];
  let guard = points.length * points.length;
  while (remaining.length > 3) {
    if (guard-- <= 0) {
      throw new Error('profile could not be triangulated (self-intersecting or degenerate?)');
    }
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const ia = remaining[(i - 1 + remaining.length) % remaining.length];
      const ib = remaining[i];
      const ic = remaining[(i + 1) % remaining.length];
      const a = points[ia];
      const b = points[ib];
      const c = points[ic];
      if (cross2(a, b, c) <= 1e-12) continue; // reflex vertex or degenerate ear
      const blocked = remaining.some(
        (j) => j !== ia && j !== ib && j !== ic && inTriangle(points[j], a, b, c),
      );
      if (blocked) continue;
      triangles.push([ia, ib, ic]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      throw new Error('profile could not be triangulated (self-intersecting or degenerate?)');
    }
  }
  triangles.push([remaining[0], remaining[1], remaining[2]]);
  return triangles;
}
