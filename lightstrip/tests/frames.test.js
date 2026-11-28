import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrames } from '../src/frames.js';
import { angleBetween, dot } from '../src/vec3.js';

const allFinite = (frames) =>
  [...frames.tangents, ...frames.normals, ...frames.binormals].every((v) =>
    v.every((x) => Number.isFinite(x)),
  );

test('vertical straight path keeps a constant frame with no NaN and no reseed', () => {
  const samples = [];
  for (let i = 0; i <= 20; i++) samples.push([0, 0, i * 0.1]); // straight up
  const frames = buildFrames(samples);
  assert.ok(allFinite(frames));
  assert.equal(frames.events.length, 0);
  for (const n of frames.normals) {
    assert.ok(Math.abs(angleBetween(n, frames.normals[0])) < 1e-9, 'normal must not drift or flip');
  }
});

test('path reversal (U-turn) transports the frame smoothly without flipping', () => {
  // Semicircular U in the x-y plane: tangent rotates 180° through the bend.
  const samples = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI;
    samples.push([Math.cos(a), Math.sin(a), 0]);
  }
  const frames = buildFrames(samples);
  assert.ok(allFinite(frames));
  assert.equal(frames.events.length, 0);
  for (let i = 1; i < frames.normals.length; i++) {
    const step = angleBetween(frames.normals[i - 1], frames.normals[i]);
    assert.ok(step < Math.PI / 6, `normal jumped by ${step} rad at sample ${i}`);
  }
});

test('a tangent folding exactly onto the normal is reported, not silent', () => {
  // t0 = +x, so the seeded normal is +y; the central-difference tangent at
  // sample 1 is exactly +y, leaving nothing to project.
  const frames = buildFrames([[0, 0, 0], [1, 0, 0], [0, 2, 0]]);
  assert.ok(allFinite(frames));
  assert.equal(frames.events.length, 1);
  assert.equal(frames.events[0].type, 'frame-reseed');
});

test('closed planar loop has ~0 seam twist and a continuous frame across the seam', () => {
  const samples = [];
  const count = 64;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    samples.push([Math.cos(a), 0, Math.sin(a)]);
  }
  const frames = buildFrames(samples, { closed: true });
  assert.ok(allFinite(frames));
  assert.ok(Math.abs(frames.twistDegrees) < 1e-6, `twist ${frames.twistDegrees}`);
  const seam = angleBetween(frames.normals[count - 1], frames.normals[0]);
  assert.ok(seam < 0.2, `seam normal discontinuity ${seam} rad`);
});

test('closed non-planar loop distributes twist so first and last ring join', () => {
  // Tilted wavy loop: parallel transport does not close on itself.
  const samples = [];
  const count = 96;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    samples.push([Math.cos(a), 0.3 * Math.sin(3 * a), Math.sin(a)]);
  }
  const frames = buildFrames(samples, { closed: true });
  assert.ok(allFinite(frames));
  // After correction the seam step must be no larger than a typical interior step.
  let maxInterior = 0;
  for (let i = 1; i < count; i++) {
    maxInterior = Math.max(maxInterior, angleBetween(frames.normals[i - 1], frames.normals[i]));
  }
  const seam = angleBetween(frames.normals[count - 1], frames.normals[0]);
  assert.ok(seam <= maxInterior * 1.5 + 1e-9, `seam ${seam} vs interior ${maxInterior}`);
});

test('normals stay perpendicular to tangents', () => {
  const samples = [[0, 0, 0], [1, 0, 0.2], [1.5, 0.5, 1.2], [1.5, 0.5, 2.2], [0.4, 1, 2.8]];
  const frames = buildFrames(samples);
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Math.abs(dot(frames.normals[i], frames.tangents[i])) < 1e-9);
    assert.ok(Math.abs(dot(frames.binormals[i], frames.tangents[i])) < 1e-9);
  }
});
