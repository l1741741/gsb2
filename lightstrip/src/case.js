import { resolveProfile } from './profiles.js';

// Validate and normalize a case definition (parsed JSON) into a canonical form.
export function normalizeCase(def) {
  if (!def || typeof def !== 'object') throw new Error('case must be a JSON object');
  if (!Array.isArray(def.points) || def.points.length < 2) {
    throw new Error('case.points must be an array of at least 2 control points');
  }
  const points = def.points.map((p, i) => {
    const position = Array.isArray(p) ? p : p.position;
    if (!Array.isArray(position) || position.length !== 3 || position.some((v) => !Number.isFinite(v))) {
      throw new Error(`control point ${i} needs a finite [x, y, z] position`);
    }
    const width = Array.isArray(p) ? def.width : p.width ?? def.width;
    const w = width ?? 0.3;
    if (!Number.isFinite(w) || w <= 0) throw new Error(`control point ${i} has invalid width ${w}`);
    return { position, width: w };
  });
  const closed = def.closed === true;
  if (closed && points.length < 3) throw new Error('a closed case needs at least 3 control points');
  return {
    name: def.name ?? 'lightstrip',
    points,
    closed,
    profile: resolveProfile(def.profile ?? 'flat-strip'),
    samplesPerSegment: def.samplesPerSegment ?? 16,
    uvScale: def.uvScale ?? 1,
    sharpTurnDeg: def.sharpTurnDeg ?? 45,
  };
}
