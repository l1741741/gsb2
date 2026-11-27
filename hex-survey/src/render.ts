/**
 * render.ts — 纯 Canvas 2D 六边格渲染器。
 * 所有图标（信标、石墙、勘测员、标记）都用路径原语现场绘制，
 * 不加载任何远程图片 / 字体 / CDN。
 */

import {
  axialToPixel,
  hexRadiusTiles,
  pixelToHex,
  toUV,
  uvToPixel,
  type Axial,
} from './hex.js';
import { heightAt, obstacleAt } from './mapio.js';
import { ratToNumber, type LosResult, type Viewshed } from './los.js';
import type { GameState, MoveOption } from './engine.js';
import type { Action, MapDef } from './types.js';

export interface Camera {
  size: number;
  ox: number;
  oy: number;
  cssW: number;
  cssH: number;
}

export function fitCamera(map: MapDef, cssW: number, cssH: number): Camera {
  const tiles = hexRadiusTiles(map.shape.radius);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const h of tiles) {
    const p = axialToPixel(h, 1);
    minX = Math.min(minX, p.x - Math.sqrt(3) / 2);
    maxX = Math.max(maxX, p.x + Math.sqrt(3) / 2);
    minY = Math.min(minY, p.y - 1);
    maxY = Math.max(maxY, p.y + 1);
  }
  const unitW = maxX - minX;
  const unitH = maxY - minY;
  const pad = 28;
  const size = Math.max(
    14,
    Math.min((cssW - pad * 2) / unitW, (cssH - pad * 2) / unitH),
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    size,
    ox: cssW / 2 - size * cx,
    oy: cssH / 2 - size * cy,
    cssW,
    cssH,
  };
}

export interface DrawModel {
  map: MapDef;
  state: GameState;
  /** 当前视线覆盖（实况预览或重放帧推导）；null 时不画可视层。 */
  view: Viewshed | null;
  moveOptions: MoveOption[];
  hover: Axial | null;
  selected: Axial | null;
  mode: 'play' | 'query';
  queryA: Axial | null;
  queryB: Axial | null;
  queryLos: LosResult | null;
  /** 鼠标悬停产生的临时查询线（优先于 queryLos 展示）。 */
  liveLos: LosResult | null;
  hintAction: Action | null;
  showCoords: boolean;
  time: number;
  /** 勘测员头顶 chip 的海拔；与可视域原点解耦（任意 A 格可视域时仍正确）。 */
  playerEyeZ?: number | null;
}

const ELEVATION_COLORS = ['#2b4a52', '#3f6b53', '#77713f', '#96652f', '#bd7c36', '#e3e7ee'];

function elevationColor(h: number): string {
  if (h <= 0) return ELEVATION_COLORS[0];
  if (h >= 5) return ELEVATION_COLORS[5];
  return ELEVATION_COLORS[h] ?? ELEVATION_COLORS[ELEVATION_COLORS.length - 1];
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class HexRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cam: Camera;
  private map: MapDef;

  constructor(canvas: HTMLCanvasElement, map: MapDef) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');
    this.ctx = ctx;
    this.map = map;
    const rect = canvas.getBoundingClientRect();
    this.cam = fitCamera(map, rect.width || 800, rect.height || 600);
  }

  setMap(map: MapDef): void {
    this.map = map;
    this.resize();
  }

  resize(cssW?: number, cssH?: number): Camera {
    const parent = this.canvas.parentElement;
    const w = cssW ?? parent?.clientWidth ?? 800;
    const h = cssH ?? parent?.clientHeight ?? 600;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cam = fitCamera(this.map, w, h);
    return this.cam;
  }

  get camera(): Camera {
    return this.cam;
  }

  center(a: Axial): { x: number; y: number } {
    const p = axialToPixel(a, this.cam.size);
    return { x: p.x + this.cam.ox, y: p.y + this.cam.oy };
  }

  /** CSS 像素坐标 -> 界内六边格；点到地图外返回 null。 */
  pick(cssX: number, cssY: number): Axial | null {
    const x = (cssX - this.cam.ox) / this.cam.size;
    const y = (cssY - this.cam.oy) / this.cam.size;
    const h = pixelToHex({ x, y }, 1);
    const R = this.map.shape.radius;
    if (
      Math.abs(h.q) <= R &&
      Math.abs(h.r) <= R &&
      Math.abs(h.q + h.r) <= R
    ) {
      return h;
    }
    return null;
  }

  hexPath(a: Axial, inflate = 1): void {
    const { x, y } = this.center(a);
    const s = this.cam.size * inflate;
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30);
      const px = x + s * Math.cos(ang);
      const py = y + s * Math.sin(ang);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  draw(model: DrawModel): void {
    const ctx = this.ctx;
    const { cssW, cssH } = this.cam;
    ctx.clearRect(0, 0, cssW, cssH);
    this.drawBackground(cssW, cssH);

    const tiles = hexRadiusTiles(this.map.shape.radius);

    // 1) 地块底色
    for (const h of tiles) this.drawTileBase(h);

    // 2) 迷雾：既没有历史记录、当前也不在视线内的格才压暗。
    //    当前可见格保持明亮（“当前可见”），记录格另加暖色（“曾见”）。
    for (const h of tiles) {
      const key = `${h.q},${h.r}`;
      const inView = model.view?.visible.has(key) ?? false;
      if (!model.state.records[key] && !inView) this.drawFog(h);
    }

    // 3) 曾见记录层（暖色）
    for (const key of Object.keys(model.state.records)) {
      const [qs, rs] = key.split(',');
      this.drawSeen({ q: Number(qs), r: Number(rs) });
    }

    // 4) 当前可视层（青色）
    if (model.view) {
      for (const key of model.view.visible) {
        const [qs, rs] = key.split(',');
        this.drawVisibleWash({ q: Number(qs), r: Number(rs) });
      }
    }

    // 5) 坐标 / 高度标注
    for (const h of tiles) this.drawTileLabels(h, model.showCoords);

    // 6) 起点
    this.drawStart(this.map.start, model.time);

    // 7) 合法移动提示
    for (const opt of model.moveOptions) this.drawMoveOption(opt, model.time);

    // 8) 提示路线
    if (model.hintAction?.type === 'move') {
      this.drawHintRing(model.hintAction.to, model.time);
    }

    // 9) 障碍
    for (const o of this.map.obstacles ?? []) this.drawObstacle(o);

    // 10) 信标：只画已发现的（未发现不泄露位置）
    for (const b of this.map.beacons) {
      if (model.state.foundIds.includes(b.id)) {
        const visibleNow = model.view?.visible.has(`${b.q},${b.r}`) ?? false;
        this.drawBeacon(b, model.time, visibleNow);
      }
    }

    // 11) 选中 / 悬停描边
    if (model.selected) this.drawOutline(model.selected, '#e2e8f0', 2, [6, 4]);
    if (model.hover && !(model.selected && same(model.hover, model.selected))) {
      this.drawOutline(model.hover, 'rgba(255,255,255,0.55)', 1.5, []);
    }

    // 12) 勘测员
    const playerEyeZ =
      model.playerEyeZ === undefined ? (model.view?.eyeZ ?? null) : model.playerEyeZ;
    this.drawPlayer(model.state.player, playerEyeZ, model.time);

    // 13) 视线查询层
    this.drawQuery(model);
  }

  private drawBackground(w: number, h: number): void {
    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#12222c');
    g.addColorStop(1, '#0a131a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // 细点阵纹理（本地程序化，无图片）
    ctx.fillStyle = 'rgba(148, 197, 210, 0.05)';
    const gap = 26;
    for (let y = gap / 2; y < h; y += gap) {
      for (let x = gap / 2; x < w; x += gap) {
        ctx.fillRect(x, y, 1.4, 1.4);
      }
    }
  }

  private drawTileBase(h: Axial): void {
    const ctx = this.ctx;
    const height = heightAt(this.map, h.q, h.r);
    this.hexPath(h, 0.985);
    ctx.fillStyle = elevationColor(height);
    ctx.fill();
    // 顶部微光，制造一点地块质感
    ctx.save();
    this.hexPath(h, 0.985);
    ctx.clip();
    const { x, y } = this.center(h);
    const grad = ctx.createLinearGradient(x, y - this.cam.size, x, y + this.cam.size);
    grad.addColorStop(0, 'rgba(255,255,255,0.10)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - this.cam.size * 1.2, y - this.cam.size * 1.2, this.cam.size * 2.4, this.cam.size * 2.4);
    ctx.restore();
    this.hexPath(h, 0.985);
    ctx.strokeStyle = 'rgba(214, 236, 244, 0.10)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawFog(h: Axial): void {
    const ctx = this.ctx;
    this.hexPath(h, 0.985);
    ctx.fillStyle = 'rgba(5, 11, 16, 0.5)';
    ctx.fill();
  }

  private drawSeen(h: Axial): void {
    const ctx = this.ctx;
    this.hexPath(h, 0.94);
    ctx.fillStyle = 'rgba(240, 186, 84, 0.10)';
    ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(245, 196, 96, 0.6)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawVisibleWash(h: Axial): void {
    const ctx = this.ctx;
    this.hexPath(h, 0.985);
    ctx.fillStyle = 'rgba(94, 220, 255, 0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(125, 228, 255, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  private drawTileLabels(h: Axial, showCoords: boolean): void {
    const ctx = this.ctx;
    const { x, y } = this.center(h);
    const height = heightAt(this.map, h.q, h.r);
    const s = this.cam.size;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (height > 0) {
      ctx.font = `700 ${Math.max(9, s * 0.3)}px ui-sans-serif, system-ui`;
      ctx.fillStyle = height >= 3 ? 'rgba(255,236,200,0.92)' : 'rgba(236,247,245,0.85)';
      // 高度小三角 + 数字
      ctx.fillText(`▲${height}`, x, y - s * 0.42);
    }
    if (showCoords) {
      ctx.font = `${Math.max(8, s * 0.24)}px ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(220,235,245,0.6)';
      ctx.fillText(`${h.q},${h.r}`, x, y + s * 0.42);
    }
  }

  private drawStart(h: Axial, time: number): void {
    const { x, y } = this.center(h);
    const ctx = this.ctx;
    const s = this.cam.size;
    const pulse = 0.5 + 0.5 * Math.sin(time / 480);
    ctx.beginPath();
    ctx.arc(x, y, s * (0.62 + pulse * 0.05), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(125, 211, 252, ${0.25 + pulse * 0.2})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    // 小旗
    ctx.strokeStyle = '#e0f2fe';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - s * 0.18, y + s * 0.34);
    ctx.lineTo(x - s * 0.18, y - s * 0.4);
    ctx.stroke();
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(x - s * 0.18, y - s * 0.4);
    ctx.lineTo(x + s * 0.28, y - s * 0.26);
    ctx.lineTo(x - s * 0.18, y - s * 0.12);
    ctx.closePath();
    ctx.fill();
  }

  private drawMoveOption(opt: MoveOption, time: number): void {
    const ctx = this.ctx;
    const { x, y } = this.center(opt.to);
    const s = this.cam.size;
    if (opt.legal) {
      const pulse = 0.5 + 0.5 * Math.sin(time / 360 + opt.to.q);
      this.hexPath(opt.to, 0.9);
      ctx.fillStyle = `rgba(74, 222, 128, ${0.16 + pulse * 0.1})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(74, 222, 128, 0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 中心脚印点
      ctx.beginPath();
      ctx.arc(x, y - s * 0.05, s * 0.13, 0, Math.PI * 2);
      ctx.fillStyle = '#4ade80';
      ctx.fill();
      this.drawCostBadge(x, y + s * 0.42, `-${opt.cost}`, '#166534', '#bbf7d0');
    } else if (opt.inMap && !opt.blockedBy) {
      // 可通行但预算不足
      this.hexPath(opt.to, 0.82);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(148,163,184,0.4)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
      this.drawCostBadge(x, y + s * 0.4, `-${opt.cost}`, '#3f3f46', '#a1a1aa');
    }
  }

  private drawCostBadge(x: number, y: number, text: string, bg: string, fg: string): void {
    const ctx = this.ctx;
    ctx.font = `700 ${Math.max(9, this.cam.size * 0.26)}px ui-sans-serif, system-ui`;
    const w = ctx.measureText(text).width + 10;
    const h = this.cam.size * 0.34;
    roundRectPath(ctx, x - w / 2, y - h / 2, w, h, h / 2);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }

  private drawHintRing(h: Axial, time: number): void {
    const ctx = this.ctx;
    const { x, y } = this.center(h);
    const s = this.cam.size;
    const p = (time % 900) / 900;
    ctx.beginPath();
    ctx.arc(x, y, s * (0.4 + p * 0.5), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(251, 191, 36, ${1 - p})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    this.drawOutline(h, '#fbbf24', 3, [8, 5]);
  }

  private drawOutline(h: Axial, color: string, width: number, dash: number[]): void {
    const ctx = this.ctx;
    this.hexPath(h, 0.97);
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawObstacle(o: Axial & { kind?: string }): void {
    const kind = obstacleAt(this.map, o.q, o.r)?.kind ?? o.kind ?? 'rock';
    const { x, y } = this.center(o);
    const ctx = this.ctx;
    const s = this.cam.size;
    if (kind === 'wall') {
      // 石墙：错缝砖块 + 压顶
      const w = s * 1.25;
      const h = s * 0.62;
      roundRectPath(ctx, x - w / 2, y - h / 2 + s * 0.08, w, h, 4);
      ctx.fillStyle = '#8b98a7';
      ctx.fill();
      ctx.strokeStyle = '#5b6673';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 砖缝
      ctx.strokeStyle = 'rgba(40,48,58,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - w / 2 + 3, y);
      ctx.lineTo(x + w / 2 - 3, y);
      const bx = [-w / 6, w / 6];
      for (const off of bx) {
        ctx.moveTo(x + off, y - h / 2 + 4);
        ctx.lineTo(x + off, y);
        ctx.moveTo(x + off + w / 4, y);
        ctx.lineTo(x + off + w / 4, y + h / 2 - 2);
      }
      ctx.stroke();
      // 压顶高光
      roundRectPath(ctx, x - w / 2 - 2, y - h / 2 - 3 + s * 0.08, w + 4, s * 0.16, 3);
      ctx.fillStyle = '#b6c2cf';
      ctx.fill();
    } else if (kind === 'spire') {
      ctx.fillStyle = '#7c6a55';
      ctx.beginPath();
      ctx.moveTo(x, y - s * 0.62);
      ctx.lineTo(x + s * 0.42, y + s * 0.4);
      ctx.lineTo(x - s * 0.42, y + s * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.moveTo(x, y - s * 0.62);
      ctx.lineTo(x, y + s * 0.4);
      ctx.lineTo(x - s * 0.42, y + s * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(30,24,18,0.6)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y - s * 0.62);
      ctx.lineTo(x + s * 0.42, y + s * 0.4);
      ctx.lineTo(x - s * 0.42, y + s * 0.4);
      ctx.closePath();
      ctx.stroke();
    } else {
      // 岩堆
      ctx.fillStyle = '#6b7684';
      for (const [dx, dy, rr] of [
        [-0.22, 0.12, 0.26],
        [0.18, 0.16, 0.22],
        [0.02, -0.12, 0.3],
      ] as const) {
        ctx.beginPath();
        ctx.arc(x + dx * s, y + dy * s, rr * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(30,38,46,0.6)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }
  }

  private drawBeacon(b: Axial & { id: string; name?: string }, time: number, visibleNow: boolean): void {
    const { x, y } = this.center(b);
    const ctx = this.ctx;
    const s = this.cam.size;
    const glow = 0.5 + 0.5 * Math.sin(time / 520 + b.id.length);
    ctx.save();
    ctx.globalAlpha = visibleNow ? 1 : 0.72;
    // 光晕
    const g = ctx.createRadialGradient(x, y, 2, x, y, s * (0.9 + glow * 0.15));
    g.addColorStop(0, 'rgba(245, 197, 66, 0.5)');
    g.addColorStop(1, 'rgba(245, 197, 66, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, s * 1.05, 0, Math.PI * 2);
    ctx.fill();

    // 三脚架
    ctx.strokeStyle = '#fde68a';
    ctx.lineWidth = Math.max(1.6, s * 0.07);
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.42);
    ctx.lineTo(x - s * 0.3, y + s * 0.4);
    ctx.moveTo(x, y - s * 0.42);
    ctx.lineTo(x + s * 0.3, y + s * 0.4);
    ctx.moveTo(x - s * 0.2, y + s * 0.02);
    ctx.lineTo(x + s * 0.2, y + s * 0.02);
    ctx.stroke();
    // 信标灯（菱形）
    ctx.fillStyle = '#f5c542';
    ctx.strokeStyle = '#7c4a03';
    ctx.lineWidth = 1.4;
    const r = s * 0.2;
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.62 - r * 0.4);
    ctx.lineTo(x + r, y - s * 0.62 + r * 0.5);
    ctx.lineTo(x, y - s * 0.62 + r * 1.4);
    ctx.lineTo(x - r, y - s * 0.62 + r * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // 已标定小勾
    ctx.beginPath();
    ctx.arc(x + s * 0.42, y - s * 0.42, s * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = '#22c55e';
    ctx.fill();
    ctx.strokeStyle = '#052e16';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + s * 0.33, y - s * 0.42);
    ctx.lineTo(x + s * 0.4, y - s * 0.34);
    ctx.lineTo(x + s * 0.52, y - s * 0.52);
    ctx.stroke();
    ctx.restore();
  }

  private drawPlayer(h: Axial, eyeZ: number | null, time: number): void {
    const { x, y } = this.center(h);
    const ctx = this.ctx;
    const s = this.cam.size;
    const pulse = 0.5 + 0.5 * Math.sin(time / 420);
    ctx.beginPath();
    ctx.arc(x, y, s * 0.52 + pulse * 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(251, 191, 36, 0.18)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, s * 0.46, 0, Math.PI * 2);
    ctx.fillStyle = '#0b2530';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fbbf24';
    ctx.stroke();
    // 勘测员简形：头盔 + 肩
    ctx.fillStyle = '#a5f3fc';
    ctx.beginPath();
    ctx.arc(x, y - s * 0.12, s * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y + s * 0.28, s * 0.24, Math.PI, 0);
    ctx.fill();
    // 海拔 chip
    if (eyeZ !== null) {
      this.drawCostBadge(x, y - s * 0.72, `海拔 ${eyeZ}`, '#0e7490', '#cffafe');
    }
  }

  private drawQuery(model: DrawModel): void {
    const result = model.liveLos ?? model.queryLos;
    const a = model.liveLos ? model.liveLos.observer : model.queryA;
    if (model.queryA) this.drawQueryPin(model.queryA, 'A', '#38bdf8');
    if (model.queryB && !model.liveLos) this.drawQueryPin(model.queryB, 'B', '#a78bfa');
    if (model.hover && model.mode === 'query' && model.queryA && !model.liveLos) {
      // 仅高亮悬停目标
      this.drawOutline(model.hover, 'rgba(167,139,250,0.8)', 1.6, [3, 3]);
    }
    if (!result || !a) return;

    const ctx = this.ctx;
    const A = toUV(result.observer);
    const T = toUV(result.target);
    const ax = uvToPixel(A, this.cam.size);
    const tx = uvToPixel(T, this.cam.size);
    const p1 = { x: ax.x + this.cam.ox, y: ax.y + this.cam.oy };
    const p2 = { x: tx.x + this.cam.ox, y: tx.y + this.cam.oy };

    // 途经格描边
    for (const tr of result.traversed) {
      this.hexPath(tr, 0.9);
      ctx.strokeStyle = result.clear ? 'rgba(74,222,128,0.35)' : 'rgba(248,113,113,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 视线
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = result.clear ? '#4ade80' : '#f87171';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();

    if (result.clear) return;
    const p = result.primary!;
    // 阻挡格红框
    this.drawOutline(p, '#ef4444', 3, []);
    // 接触点
    const tu = ratToNumber(p.hitT);
    const hu = A.u + tu * (T.u - A.u);
    const hv = A.v + tu * (T.v - A.v);
    const hp0 = uvToPixel({ u: hu, v: hv }, this.cam.size);
    const hx = hp0.x + this.cam.ox;
    const hy = hp0.y + this.cam.oy;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#ef4444';
    const d = this.cam.size * 0.18;
    ctx.fillRect(-d / 2, -d / 2, d, d);
    ctx.strokeStyle = '#fee2e2';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(-d / 2, -d / 2, d, d);
    ctx.restore();
    // 阻挡格上方标签
    const c = this.center(p);
    this.drawCostBadge(c.x, c.y - this.cam.size * 0.78, '阻挡', '#7f1d1d', '#fecaca');
  }

  private drawQueryPin(h: Axial, label: string, color: string): void {
    const { x, y } = this.center(h);
    const ctx = this.ctx;
    const s = this.cam.size;
    ctx.beginPath();
    ctx.arc(x, y - s * 0.05, s * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#082f49';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#082f49';
    ctx.font = `800 ${s * 0.34}px ui-sans-serif, system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y - s * 0.04);
  }
}

function same(a: Axial, b: Axial): boolean {
  return a.q === b.q && a.r === b.r;
}
