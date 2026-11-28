/**
 * A tiny deterministic PNG encoder (browser-safe, no dependencies).
 *
 * The encoder writes 8-bit RGBA PNGs using stored (uncompressed) deflate
 * blocks. Files are larger than a compressed PNG, but output is byte-for-byte
 * deterministic across runtimes, which matters because exported previews serve
 * as evidence in tests. Previews are small enough that the size is fine.
 *
 * Decoding lives in `tools/png-decode.ts` and is only used by Node tooling;
 * the browser decodes user-selected PNGs with `createImageBitmap`.
 */

import { fnv1aBytes } from './hash.ts';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput), false);
  return out;
}

/** Raw scanline stream (filter byte 0 + RGBA row per line). */
function scanlines(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new TypeError(`image data length ${data.length} does not match ${width}x${height} RGBA`);
  }
  const out = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    out[rowStart] = 0;
    out.set(data.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  return out;
}

/**
 * zlib stream with stored blocks only (no compression). Deterministic across
 * runtimes, so the browser's exported PNGs are byte-identical everywhere.
 * Node tooling compresses sample assets via `deflate` to keep them small.
 */
export function storedDeflate(raw: Uint8Array): Uint8Array {
  const blockSize = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / blockSize));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let outPos = 0;
  out[outPos++] = 0x78; // CMF: deflate, 32K window
  out[outPos++] = 0x01; // FLG: fastest
  let pos = 0;
  for (let b = 0; b < blocks; b++) {
    const final = b === blocks - 1 ? 1 : 0;
    const len = Math.min(blockSize, raw.length - pos);
    out[outPos++] = final; // BFINAL + BTYPE=00 (stored)
    out[outPos++] = len & 0xff;
    out[outPos++] = (len >>> 8) & 0xff;
    out[outPos++] = ~len & 0xff;
    out[outPos++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(pos, pos + len), outPos);
    outPos += len;
    pos += len;
  }
  // Adler-32 of the uncompressed data, written big-endian as zlib does.
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = (b << 16) | a;
  out[outPos++] = (adler >>> 24) & 0xff;
  out[outPos++] = (adler >>> 16) & 0xff;
  out[outPos++] = (adler >>> 8) & 0xff;
  out[outPos++] = adler & 0xff;
  return out.subarray(0, outPos);
}

/**
 * Encodes RGBA to an 8-bit RGBA PNG.
 *
 * `deflate` lets Node callers substitute a real zlib compressor for smaller
 * files; the default stored-block stream keeps output deterministic in the
 * browser, where no zlib is available.
 */
export function encodePng(
  image: RgbaImage,
  options: { deflate?: (data: Uint8Array) => Uint8Array } = {},
): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width, false);
  view.setUint32(4, image.height, false);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace
  const ihdr = chunk('IHDR', header);
  const idat = chunk('IDAT', (options.deflate ?? storedDeflate)(scanlines(image)));
  const iend = chunk('IEND', new Uint8Array(0));
  const out = new Uint8Array(8 + ihdr.length + idat.length + iend.length);
  // Raw signature bytes; a JS string literal would encode U+0089 as two bytes.
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set(ihdr, 8);
  out.set(idat, 8 + ihdr.length);
  out.set(iend, 8 + ihdr.length + idat.length);
  return out;
}

/** Digest of image bytes, recorded in export metadata. */
export function imageDigest(image: RgbaImage): string {
  return `${fnv1aBytes(image.data)}-${image.width}x${image.height}`;
}

/** RGBA buffer to a data URL, for browser previews and downloads. */
export function pngDataUrl(image: RgbaImage): string {
  const bytes = encodePng(image);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:image/png;base64,${btoa(binary)}`;
}
