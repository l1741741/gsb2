/**
 * Node-only PNG decoder used by tests and sample tooling.
 *
 * Handles 8-bit RGB/RGBA/greyscale/palette PNGs with filters 0–4 (the shapes
 * Chrome's canvas and our encoder produce). The browser never needs this: it
 * decodes user PNGs with createImageBitmap.
 */

import { inflateSync } from 'node:zlib';
import type { RgbaImage } from '../src/core/png.ts';

export function decodePng(bytes: Uint8Array): RgbaImage {
  // Compare raw bytes: decoding 0x89 as text is not portable.
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8) throw new TypeError('not a PNG file');
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== signature[i]) throw new TypeError('not a PNG file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos, false);
    const type = new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0, false);
      height = new DataView(data.buffer, data.byteOffset).getUint32(4, false);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8) throw new TypeError(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new TypeError('interlaced PNGs are not supported');
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : colourType === 4 ? 2 : 1;
  if (colourType !== 6 && colourType !== 2 && colourType !== 0 && colourType !== 4 && colourType !== 3) {
    throw new TypeError(`unsupported PNG colour type ${colourType}`);
  }
  const combined = concat(idat);
  const raw = inflateSync(combined);
  const stride = width * channels;
  const expected = height * (stride + 1);
  if (raw.length < expected) throw new TypeError(`PNG data too short: ${raw.length} < ${expected}`);
  const pixels = new Uint8Array(width * height * channels);
  let prev: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const reconstructed: Uint8Array = unfilter(filter, row, prev, channels, stride);
    pixels.set(reconstructed, y * stride);
    prev = reconstructed;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (colourType === 6) {
      rgba.set(pixels.subarray(i * 4, i * 4 + 4), i * 4);
    } else if (colourType === 2) {
      rgba[i * 4] = pixels[i * 3];
      rgba[i * 4 + 1] = pixels[i * 3 + 1];
      rgba[i * 4 + 2] = pixels[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else if (colourType === 0) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = pixels[i];
      rgba[i * 4 + 3] = 255;
    } else if (colourType === 4) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = pixels[i * 2];
      rgba[i * 4 + 3] = pixels[i * 2 + 1];
    } else {
      if (!palette) throw new TypeError('indexed PNG without a palette');
      const index = pixels[i];
      rgba[i * 4] = palette[index * 3];
      rgba[i * 4 + 1] = palette[index * 3 + 1];
      rgba[i * 4 + 2] = palette[index * 3 + 2];
      rgba[i * 4 + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
  }
  return { width, height, data: rgba };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function unfilter(filter: number, row: Uint8Array, prev: Uint8Array, channels: number, stride: number): Uint8Array {
  const out = new Uint8Array(stride);
  switch (filter) {
    case 0:
      out.set(row);
      break;
    case 1:
      for (let i = 0; i < stride; i++) out[i] = (row[i] + (i >= channels ? out[i - channels] : 0)) & 0xff;
      break;
    case 2:
      for (let i = 0; i < stride; i++) out[i] = (row[i] + prev[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? out[i - channels] : 0;
        out[i] = (row[i] + Math.floor((left + prev[i]) / 2)) & 0xff;
      }
      break;
    case 4:
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? out[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        out[i] = (row[i] + paeth(a, b, c)) & 0xff;
      }
      break;
    default:
      throw new TypeError(`unsupported PNG filter ${filter}`);
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
