import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, encodePng, imageDigest, pngDataUrl } from '../src/core/png.ts';
import { decodePng } from '../tools/png-decode.ts';

function solid(width: number, height: number, rgba: [number, number, number, number]): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

test('PNG signature is the raw 8-byte signature', () => {
  const png = encodePng(solid(2, 2, [10, 20, 30, 255]));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('encode then decode round-trips every pixel exactly', () => {
  const image = solid(7, 5, [12, 200, 99, 128]);
  const png = encodePng(image);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  assert.deepEqual([...decoded.data], [...image.data]);
});

test('encoding is byte-for-byte deterministic', () => {
  const a = encodePng(solid(3, 3, [1, 2, 3, 4]));
  const b = encodePng(solid(3, 3, [1, 2, 3, 4]));
  assert.deepEqual(a, b);
});

test('CRC32 matches a known vector', () => {
  // CRC-32 of "123456789" is 0xCBF43926.
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(bytes), 0xcbf43926);
});

test('imageDigest changes with pixels and identifies size', () => {
  const a = solid(2, 2, [0, 0, 0, 255]);
  const b = solid(2, 2, [1, 0, 0, 255]);
  assert.notEqual(imageDigest(a), imageDigest(b));
  assert.match(imageDigest(a), /^[0-9a-f]{8}-2x2$/);
  // The digest is stable for identical buffers.
  assert.equal(imageDigest(solid(2, 2, [0, 0, 0, 255])), imageDigest(a));
});

test('pngDataUrl emits a usable data URL', () => {
  const url = pngDataUrl(solid(2, 2, [200, 30, 30, 255]));
  assert.ok(url.startsWith('data:image/png;base64,'));
  const base64 = url.slice('data:image/png;base64,'.length);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const decoded = decodePng(bytes);
  assert.deepEqual(decoded.data.subarray(0, 4), new Uint8Array([200, 30, 30, 255]));
});

test('decode rejects a non-PNG buffer', () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a PNG/);
});
