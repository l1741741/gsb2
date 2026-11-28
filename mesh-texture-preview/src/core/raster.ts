/**
 * Reference software renderer.
 *
 * It rasterises the same triangles and samples the same texture as the WebGL
 * view, in plain TypeScript. Two uses:
 *
 *  - Node tests can assert exact pixel colours on seams without a GPU.
 *  - The "Export preview" path produces a PNG that is deterministic and
 *    independent of the GPU/driver used in the browser.
 *
 * The rasteriser is deliberately simple (no anti-aliasing, top-left sample
 * point) so results are stable. It is not a speed-optimised renderer; fabric
 * previews are small.
 */

import type { MeshDocument, Vec2 } from './types.ts';
import { barycentric, clamp, expandBounds, emptyBounds } from './geometry.ts';

export interface TextureImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. Uint8Array everywhere keeps the PNG codec simple. */
  data: Uint8Array;
}

export interface RenderOptions {
  /** Output width in pixels. */
  width: number;
  height: number;
  /** World-space region mapped to the output. Defaults to the mesh bounds. */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Margin in world units added around the mesh bounds. */
  padding?: number;
  /** Background colour (RGBA 0..255). */
  background?: [number, number, number, number];
  /** Draw triangle edges in wireframe over the sampled texture. */
  wireframe?: boolean;
  wireframeColour?: [number, number, number, number];
  /** Skip triangles whose diagnostics mark them invalid (badPatchMode: 'disable'). */
  skipInvalid?: boolean;
  /** Texture wrapping (repeat is the fabric-print default). */
  wrap?: 'repeat' | 'clamp';
}

export interface RenderResult {
  width: number;
  height: number;
  data: Uint8Array;
  /** world -> pixel transform used, so overlays and picks can reuse it. */
  transform: ViewTransform;
}

export interface ViewTransform {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  width: number;
  height: number;
  /** Fabric units per pixel. */
  scale: number;
  /** Pixel position of bounds.minX/minY. */
  offsetX: number;
  offsetY: number;
}

export function computeTransform(
  width: number,
  height: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  padding = 0,
): ViewTransform {
  const b = {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
  const worldWidth = Math.max(1e-6, b.maxX - b.minX);
  const worldHeight = Math.max(1e-6, b.maxY - b.minY);
  const scale = Math.min(width / worldWidth, height / worldHeight);
  const offsetX = (width - worldWidth * scale) / 2;
  const offsetY = (height - worldHeight * scale) / 2;
  return { bounds: b, width, height, scale, offsetX, offsetY };
}

export function worldToPixel(t: ViewTransform, p: Vec2): Vec2 {
  return {
    x: t.offsetX + (p.x - t.bounds.minX) * t.scale,
    y: t.offsetY + (p.y - t.bounds.minY) * t.scale,
  };
}

export function pixelToWorld(t: ViewTransform, x: number, y: number): Vec2 {
  return {
    x: (x - t.offsetX) / t.scale + t.bounds.minX,
    y: (y - t.offsetY) / t.scale + t.bounds.minY,
  };
}

export function meshBounds(doc: MeshDocument) {
  const b = emptyBounds();
  for (const v of doc.vertices) expandBounds(b, v);
  return b;
}

/** Bilinear sample of the texture at normalised UVs, with wrapping. */
export function sampleTexture(
  texture: TextureImage,
  u: number,
  v: number,
  wrap: 'repeat' | 'clamp' = 'repeat',
): [number, number, number, number] {
  const { width, height, data } = texture;
  let x: number;
  let y: number;
  if (wrap === 'repeat') {
    x = (u - Math.floor(u)) * width - 0.5;
    y = (v - Math.floor(v)) * height - 0.5;
  } else {
    x = clamp(u, 0, 1) * width - 0.5;
    y = clamp(v, 0, 1) * height - 0.5;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const wrapX = (i: number): number => (wrap === 'repeat' ? ((i % width) + width) % width : clamp(i, 0, width - 1));
  const wrapY = (i: number): number => (wrap === 'repeat' ? ((i % height) + height) % height : clamp(i, 0, height - 1));
  const x1 = wrapX(x0 + 1);
  const y1 = wrapY(y0 + 1);
  const xa = wrapX(x0);
  const ya = wrapY(y0);
  const idx = (px: number, py: number) => (py * width + px) * 4;
  const c00 = idx(xa, ya);
  const c10 = idx(x1, ya);
  const c01 = idx(xa, y1);
  const c11 = idx(x1, y1);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const top = data[c00 + k] * (1 - fx) + data[c10 + k] * fx;
    const bottom = data[c01 + k] * (1 - fx) + data[c11 + k] * fx;
    out[k] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

/**
 * Rasterises the mesh. Triangles are filled independently, so a split seam
 * shows both sides' texture: each triangle samples only its own corner UVs.
 */
export function renderMesh(
  doc: MeshDocument,
  texture: TextureImage,
  options: RenderOptions,
  invalidTriangleIds?: ReadonlySet<number>,
): RenderResult {
  const bounds = options.bounds ?? meshBounds(doc);
  const transform = computeTransform(options.width, options.height, bounds, options.padding ?? 0);
  const background = options.background ?? [22, 26, 32, 255];
  const data = new Uint8Array(options.width * options.height * 4);
  for (let i = 0; i < options.width * options.height; i++) {
    data[i * 4] = background[0];
    data[i * 4 + 1] = background[1];
    data[i * 4 + 2] = background[2];
    data[i * 4 + 3] = background[3];
  }
  const wrap = options.wrap ?? 'repeat';

  for (const tri of doc.triangles) {
    if (options.skipInvalid && invalidTriangleIds?.has(tri.id)) continue;
    const p0 = doc.vertices[tri.vertices[0]];
    const p1 = doc.vertices[tri.vertices[1]];
    const p2 = doc.vertices[tri.vertices[2]];
    const s0 = worldToPixel(transform, p0);
    const s1 = worldToPixel(transform, p1);
    const s2 = worldToPixel(transform, p2);
    const minX = Math.floor(Math.min(s0.x, s1.x, s2.x));
    const maxX = Math.ceil(Math.max(s0.x, s1.x, s2.x));
    const minY = Math.floor(Math.min(s0.y, s1.y, s2.y));
    const maxY = Math.ceil(Math.max(s0.y, s1.y, s2.y));
    for (let py = Math.max(0, minY); py < Math.min(options.height, maxY + 1); py++) {
      for (let px = Math.max(0, minX); px < Math.min(options.width, maxX + 1); px++) {
        const sample = { x: px + 0.5, y: py + 0.5 };
        const bary = barycentric(sample, s0, s1, s2);
        if (!bary) continue;
        if (bary[0] < -1e-6 || bary[1] < -1e-6 || bary[2] < -1e-6) continue;
        const u = tri.uvs[0].x * bary[0] + tri.uvs[1].x * bary[1] + tri.uvs[2].x * bary[2];
        const v = tri.uvs[0].y * bary[0] + tri.uvs[1].y * bary[1] + tri.uvs[2].y * bary[2];
        const colour = sampleTexture(texture, u, v, wrap);
        const idx = (py * options.width + px) * 4;
        data[idx] = colour[0];
        data[idx + 1] = colour[1];
        data[idx + 2] = colour[2];
        data[idx + 3] = colour[3];
      }
    }
  }

  if (options.wireframe) {
    const colour = options.wireframeColour ?? [255, 255, 255, 40];
    for (const tri of doc.triangles) {
      const p0 = worldToPixel(transform, doc.vertices[tri.vertices[0]]);
      const p1 = worldToPixel(transform, doc.vertices[tri.vertices[1]]);
      const p2 = worldToPixel(transform, doc.vertices[tri.vertices[2]]);
      drawLine(data, options.width, options.height, p0, p1, colour);
      drawLine(data, options.width, options.height, p1, p2, colour);
      drawLine(data, options.width, options.height, p2, p0, colour);
    }
  }

  return { width: options.width, height: options.height, data, transform };
}

/** Bresenham line with alpha blending, for the wireframe overlay. */
export function drawLine(
  data: Uint8Array,
  width: number,
  height: number,
  a: Vec2,
  b: Vec2,
  colour: [number, number, number, number],
): void {
  let x0 = Math.round(a.x);
  let y0 = Math.round(a.y);
  const x1 = Math.round(b.x);
  const y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const alpha = colour[3] / 255;
  for (;;) {
    if (x0 >= 0 && x0 < width && y0 >= 0 && y0 < height) {
      const idx = (y0 * width + x0) * 4;
      for (let k = 0; k < 3; k++) data[idx + k] = Math.round(data[idx + k] * (1 - alpha) + colour[k] * alpha);
      data[idx + 3] = 255;
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Average colour of a small pixel neighbourhood, for seam continuity probes. */
export function samplePixel(image: RenderResult, x: number, y: number): [number, number, number, number] {
  const px = clamp(Math.round(x), 0, image.width - 1);
  const py = clamp(Math.round(y), 0, image.height - 1);
  const idx = (py * image.width + px) * 4;
  return [image.data[idx], image.data[idx + 1], image.data[idx + 2], image.data[idx + 3]];
}

/** Mean absolute RGB difference between two pixel samples. */
export function colourDistance(a: readonly number[], b: readonly number[]): number {
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
}
