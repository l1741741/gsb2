/**
 * 零原生依赖的离屏 Canvas 2D 最小实现 + PNG 编码器。
 *
 * 只实现 drawScene 用到的 2D 子集：路径（直线段，无贝塞尔）、
 * 奇偶填充、描边（含虚线）、圆形（问题标记用）与矩形。
 * 光栅化采用每像素 2x2 超采样做抗锯齿；文字在 PNG 中省略，
 * 环身份通过颜色/线型与同名 JSON 坐标对应。
 *
 * PNG 编码仅依赖 node:zlib（deflate）与 node:buffer，输出 8-bit RGBA。
 */
import { deflateSync } from 'node:zlib';
import type { DrawContext } from './canvas-draw.js';

interface SubPath {
  points: { x: number; y: number }[];
  closed: boolean;
}

function parseColor(input: string): [number, number, number, number] {
  const s = input.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const rgba = s.match(/rgba?\(([^)]+)\)/);
  if (rgba) {
    const parts = rgba[1].split(',').map((x) => x.trim());
    const a = parts[3] === undefined ? 255 : Math.round(parseFloat(parts[3]) * 255);
    return [parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10), a];
  }
  return [0, 0, 0, 255];
}

export class HeadlessCanvas implements DrawContext {
  readonly canvas: { width: number; height: number };
  fillStyle: string = '#000000';
  strokeStyle: string = '#000000';
  lineWidth = 1;
  lineDash: number[] = [];
  font = '12px sans-serif';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;

  /** RGBA 像素缓冲，长度 = width*height*4。 */
  private readonly pixels: Uint8ClampedArray;
  private paths: SubPath[] = [];
  private current: SubPath | null = null;

  constructor(readonly width: number, readonly height: number) {
    this.canvas = { width, height };
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.pixels.fill(255);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, a] = parseColor(this.fillStyle as string);
    this.rasterize(
      [
        {
          points: [
            { x, y },
            { x: x + w, y },
            { x: x + w, y: y + h },
            { x, y: y + h },
          ],
          closed: true,
        },
      ],
      r,
      g,
      b,
      a,
      false,
    );
  }

  beginPath(): void {
    this.paths = [];
    this.current = null;
  }

  closePath(): void {
    if (this.current) this.current.closed = true;
  }

  moveTo(x: number, y: number): void {
    this.current = { points: [{ x, y }], closed: false };
    this.paths.push(this.current);
  }

  lineTo(x: number, y: number): void {
    if (!this.current) this.moveTo(x, y);
    else this.current.points.push({ x, y });
  }

  arc(cx: number, cy: number, r: number, start: number, end: number): void {
    // 仅支持完整圆（问题标记），按 24 段折线逼近
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const t = start + ((end - start) * i) / steps;
      const x = cx + Math.cos(t) * r;
      const y = cy + Math.sin(t) * r;
      if (i === 0) this.moveTo(x, y);
      else this.lineTo(x, y);
    }
  }

  fill(): void {
    const [r, g, b, a] = parseColor(this.fillStyle as string);
    this.rasterize(this.snapshotPaths(), r, g, b, a, false);
  }

  stroke(): void {
    const [r, g, b, a] = parseColor(this.strokeStyle as string);
    this.rasterize(this.snapshotPaths(), r, g, b, a, true);
  }

  fillText(): void {
    // PNG 预览不渲染文字，身份信息由配套 JSON 提供
  }

  save(): void {
    // 无状态栈需求：drawScene 的 save/restore 仅包裹样式切换
  }

  restore(): void {}

  setLineDash(dash: number[]): void {
    this.lineDash = [...dash];
  }

  private snapshotPaths(): SubPath[] {
    const out = this.paths
      .filter((p) => p.points.length > 1)
      .map((p) => ({ points: [...p.points], closed: p.closed }));
    return out;
  }

  /**
   * 扫描线光栅化（2x2 超采样）。
   * 先对两条亚像素扫描行分别求所有边的交点区间，再按像素统计覆盖率，
   * 复杂度 O(行数 × 边数 + 覆盖像素)，与朴素逐像素射线法相比快两个数量级。
   */
  private rasterize(
    paths: SubPath[],
    r: number,
    g: number,
    b: number,
    a: number,
    stroke: boolean,
  ): void {
    const fills: SubPath[] = stroke
      ? paths.flatMap((p) => this.strokeToOutline(p))
      : paths.map((p) => ({
          points: p.closed ? p.points : [...p.points, p.points[0]],
          closed: true,
        }));

    // 只在所有路径的包围盒内工作，避开大片空白
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const path of fills) {
      for (const p of path.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (!Number.isFinite(minX)) return;
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(this.width - 1, Math.ceil(maxX));
    const y1 = Math.min(this.height - 1, Math.ceil(maxY));

    // 两条亚像素行的内部区间（奇偶规则），按像素列缓存覆盖率
    const coverage = new Uint8Array((y1 - y0 + 1) * (x1 - x0 + 1));
    const subRowOffsets = [0.25, 0.75];
    const subColOffsets = [0.25, 0.75];

    for (let row = 0; row < 2; row++) {
      for (let py = y0; py <= y1; py++) {
        const y = py + subRowOffsets[row];
        const spans = this.scanlineSpans(fills, y);
        for (const [lo, hi] of spans) {
          const cx0 = Math.max(x0, Math.floor(lo));
          const cx1 = Math.min(x1, Math.ceil(hi));
          for (let px = cx0; px <= cx1; px++) {
            for (const sx of subColOffsets) {
              const x = px + sx;
              if (x >= lo && x <= hi) {
                const idx = (py - y0) * (x1 - x0 + 1) + (px - x0);
                coverage[idx] = Math.min(4, coverage[idx] + 1);
              }
            }
          }
        }
      }
    }

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const cov = coverage[(py - y0) * (x1 - x0 + 1) + (px - x0)];
        if (cov === 0) continue;
        const srcA = (a / 255) * (cov / 4) * this.globalAlpha;
        const idx = (py * this.width + px) * 4;
        const dstA = this.pixels[idx + 3] / 255;
        const outA = srcA + dstA * (1 - srcA);
        if (outA <= 0) continue;
        this.pixels[idx] = Math.round((r * srcA + this.pixels[idx] * dstA * (1 - srcA)) / outA);
        this.pixels[idx + 1] = Math.round((g * srcA + this.pixels[idx + 1] * dstA * (1 - srcA)) / outA);
        this.pixels[idx + 2] = Math.round((b * srcA + this.pixels[idx + 2] * dstA * (1 - srcA)) / outA);
        this.pixels[idx + 3] = Math.round(outA * 255);
      }
    }
  }

  /**
   * 求给定扫描行 y 与所有路径的奇偶填充区间 [lo, hi] 列表。
   * 多子路径的交点合并排序后成对取出。
   */
  private scanlineSpans(paths: SubPath[], y: number): [number, number][] {
    const xs: number[] = [];
    for (const path of paths) {
      const pts = path.points;
      const n = pts.length;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        if (a.y > y !== b.y > y) {
          xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
      }
    }
    xs.sort((u, v) => u - v);
    const spans: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      spans.push([xs[i], xs[i + 1]]);
    }
    return spans;
  }

  /** 把描边线段展开为宽度 lineWidth 的细长多边形轮廓；虚线按 dash 切段。 */
  private strokeToOutline(path: SubPath): SubPath[] {
    const pts = path.points;
    const half = this.lineWidth / 2;
    const outlines: SubPath[] = [];
    const segCount = path.closed ? pts.length : pts.length - 1;

    const emitSegment = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return;
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;
      outlines.push({
        closed: true,
        points: [
          { x: a.x + nx, y: a.y + ny },
          { x: b.x + nx, y: b.y + ny },
          { x: b.x - nx, y: b.y - ny },
          { x: a.x - nx, y: a.y - ny },
        ],
      });
    };

    if (this.lineDash.length === 0) {
      for (let i = 0; i < segCount; i++) emitSegment(pts[i], pts[(i + 1) % pts.length]);
      return outlines;
    }

    // 虚线：沿折线累计长度，按 on/off 模式切分
    let patternIdx = 0;
    let remain = this.lineDash[0];
    let drawing = true;
    for (let i = 0; i < segCount; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      let t = 0;
      while (t < len - 1e-9) {
        const step = Math.min(remain, len - t);
        const p1 = { x: a.x + (dx * t) / len, y: a.y + (dy * t) / len };
        const p2 = { x: a.x + (dx * (t + step)) / len, y: a.y + (dy * (t + step)) / len };
        if (drawing) emitSegment(p1, p2);
        t += step;
        remain -= step;
        if (remain <= 1e-9) {
          patternIdx = (patternIdx + 1) % this.lineDash.length;
          remain = this.lineDash[patternIdx];
          drawing = !drawing;
        }
      }
    }
    return outlines;
  }

  /** 编码为 PNG 字节（含 CRC 与 zlib deflate）。 */
  toPng(): Buffer {
    const { width: w, height: h } = this;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 4 + 1)] = 0; // filter type 0
      this.pixels.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => {
        raw[y * (w * 4 + 1) + 1 + i] = v;
      });
    }
    const compressed = deflateSync(raw, { level: 9 });

    const chunks: Buffer[] = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])];
    const writeChunk = (type: string, data: Buffer): void => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const typeBuf = Buffer.from(type, 'ascii');
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
      chunks.push(len, typeBuf, data, crcBuf);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    writeChunk('IHDR', ihdr);
    writeChunk('IDAT', compressed);
    writeChunk('IEND', Buffer.alloc(0));
    return Buffer.concat(chunks);
  }
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
