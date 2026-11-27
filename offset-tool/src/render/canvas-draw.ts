/**
 * 与环境无关的 Canvas 2D 绘制层。
 * 同一个 drawScene 同时服务浏览器预览和 Node 端离屏画布（见 png.ts），
 * 保证 PNG 预览与界面所见走同一条绘制代码路径。
 */
import type { GeometryIssue, Loop, OffsetResult, Point, ResultLoop } from '../geometry/types.js';
import type { ValidationReport } from '../geometry/validate.js';
import { boundsOfLoops } from '../geometry/primitives.js';

export interface RenderStyle {
  background: string;
  originalOuter: string;
  originalHole: string;
  resultOuter: string;
  resultHole: string;
  sliverRemoved: string;
  sliverAdded: string;
  issue: string;
  label: string;
  componentFill: string[];
}

export const DEFAULT_STYLE: RenderStyle = {
  background: '#ffffff',
  originalOuter: '#374151',
  originalHole: '#9ca3af',
  resultOuter: '#1d4ed8',
  resultHole: '#0891b2',
  sliverRemoved: 'rgba(220, 38, 38, 0.28)',
  sliverAdded: 'rgba(5, 150, 105, 0.22)',
  issue: '#dc2626',
  label: '#111827',
  componentFill: [
    'rgba(29, 78, 216, 0.10)',
    'rgba(124, 58, 237, 0.10)',
    'rgba(217, 119, 6, 0.10)',
    'rgba(5, 150, 105, 0.10)',
  ],
};

export interface Camera {
  /** 世界坐标到画布坐标的缩放。 */
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function fitCamera(
  loops: Loop[],
  width: number,
  height: number,
  margin = 28,
): Camera {
  const b = boundsOfLoops(loops);
  const w = Math.max(1e-9, b.maxX - b.minX);
  const h = Math.max(1e-9, b.maxY - b.minY);
  const scale = Math.min((width - margin * 2) / w, (height - margin * 2) / h);
  // 世界 (x,y) -> 画布 (x', y')：y 轴翻转，使数学坐标向上为正
  const offsetX = (width - w * scale) / 2 - b.minX * scale;
  const offsetY = (height + h * scale) / 2 + b.minY * scale;
  return { scale, offsetX, offsetY };
}

export function worldToCanvas(p: Point, cam: Camera): Point {
  return {
    x: p.x * cam.scale + cam.offsetX,
    y: -p.y * cam.scale + cam.offsetY,
  };
}

/** 最小化的 Canvas 2D 上下文接口，浏览器 CanvasRenderingContext2D 与 Node 自实现均满足。 */
export interface DrawContext {
  canvas: { width: number; height: number };
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
  setLineDash?(dash: number[]): void;
}

function traceLoop(ctx: DrawContext, loop: Loop, cam: Camera): void {
  ctx.beginPath();
  loop.forEach((p, i) => {
    const c = worldToCanvas(p, cam);
    if (i === 0) ctx.moveTo(c.x, c.y);
    else ctx.lineTo(c.x, c.y);
  });
  ctx.closePath();
}

export interface SceneOptions {
  showOriginal: boolean;
  showResult: boolean;
  showSlivers: boolean;
  showIssues: boolean;
  showLabels: boolean;
  showOrientation: boolean;
}

export const DEFAULT_SCENE_OPTIONS: SceneOptions = {
  showOriginal: true,
  showResult: true,
  showSlivers: true,
  showIssues: true,
  showLabels: true,
  showOrientation: true,
};

export interface SceneInput {
  inputLoops: Loop[];
  result: OffsetResult | null;
  validation: ValidationReport | null;
}

export function drawScene(
  ctx: DrawContext,
  scene: SceneInput,
  options: SceneOptions,
  style: RenderStyle = DEFAULT_STYLE,
  camera?: Camera,
): Camera {
  const { width, height } = ctx.canvas;
  const allLoops: Loop[] = [...scene.inputLoops];
  if (scene.result) {
    for (const l of scene.result.loops) allLoops.push(l.points);
    for (const s of scene.result.removedSlivers) allLoops.push(s.points);
  }
  const cam = camera ?? fitCamera(allLoops.length ? allLoops : [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]], width, height);

  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.lineWidth = 1.5;

  // 1. 原始轮廓：先填实体（奇偶填充由环方向区分视觉），再描边
  if (options.showOriginal) {
    scene.inputLoops.forEach((loop, i) => {
      traceLoop(ctx, loop, cam);
      const isHole = isLikelyHole(loop, scene.inputLoops);
      ctx.fillStyle = isHole ? 'rgba(156,163,175,0.12)' : 'rgba(55,65,81,0.06)';
      ctx.fill();
      ctx.strokeStyle = isHole ? style.originalHole : style.originalOuter;
      ctx.setLineDash?.([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash?.([]);
      if (options.showOrientation) drawOrientationMark(ctx, loop, cam, isHole ? style.originalHole : style.originalOuter);
      if (options.showLabels) {
        const anchor = worldToCanvas(loop[0], cam);
        ctx.fillStyle = style.label;
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`#${i} ${isHole ? '孔' : '外'}`, anchor.x + 4, anchor.y - 4);
      }
    });
  }

  // 2. 删除细片 / 新增材料
  if (options.showSlivers && scene.result) {
    for (const s of scene.result.removedSlivers) {
      traceLoop(ctx, s.points, cam);
      ctx.fillStyle = s.kind === 'removed' ? style.sliverRemoved : style.sliverAdded;
      ctx.fill();
      ctx.strokeStyle = s.kind === 'removed' ? '#b91c1c' : '#047857';
      ctx.lineWidth = 1;
      ctx.setLineDash?.([2, 3]);
      ctx.stroke();
      ctx.setLineDash?.([]);
    }
  }

  // 3. 结果环：组件分色填充，外轮廓实线、孔洞粗虚线
  if (options.showResult && scene.result) {
    scene.result.components.forEach((comp, ci) => {
      const fill = style.componentFill[ci % style.componentFill.length];
      for (const l of comp) {
        if (l.role !== 'outer') continue;
        traceLoop(ctx, l.points, cam);
        ctx.fillStyle = fill;
        ctx.fill();
      }
    });
    for (const l of scene.result.loops) {
      traceLoop(ctx, l.points, cam);
      ctx.strokeStyle = l.role === 'hole' ? style.resultHole : style.resultOuter;
      ctx.lineWidth = 2;
      ctx.setLineDash?.(l.role === 'hole' ? [8, 4] : []);
      ctx.stroke();
      ctx.setLineDash?.([]);
      if (options.showOrientation) drawOrientationMark(ctx, l.points, cam, ctx.strokeStyle as string);
      if (options.showLabels) labelResultLoop(ctx, l, cam, style);
    }
  }

  // 4. 自交/问题定位标记
  if (options.showIssues && scene.validation) {
    drawIssues(ctx, scene.validation.issues, cam, style);
  }

  ctx.restore();
  return cam;
}

function isLikelyHole(loop: Loop, all: Loop[]): boolean {
  let depth = 0;
  for (const other of all) {
    if (other === loop) continue;
    // 复用首点射线判定：包含本环首点的环数
    let inside = false;
    const p = loop[0];
    for (let i = 0, j = other.length - 1; i < other.length; j = i++) {
      const a = other[j];
      const b = other[i];
      if (a.y > p.y !== b.y > p.y) {
        const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (x > p.x) inside = !inside;
      }
    }
    if (inside) depth++;
  }
  return depth % 2 === 1;
}

function drawOrientationMark(ctx: DrawContext, loop: Loop, cam: Camera, color: string): void {
  // 在首条边中点画方向箭头
  const a = worldToCanvas(loop[0], cam);
  const b = worldToCanvas(loop[1 % loop.length], cam);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const r = 5;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(mx + Math.cos(ang) * r * 1.4, my + Math.sin(ang) * r * 1.4);
  ctx.lineTo(mx - Math.cos(ang - 0.6) * r, my - Math.sin(ang - 0.6) * r);
  ctx.lineTo(mx - Math.cos(ang + 0.6) * r, my - Math.sin(ang + 0.6) * r);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function labelResultLoop(ctx: DrawContext, l: ResultLoop, cam: Camera, style: RenderStyle): void {
  const anchor = worldToCanvas(l.points[0], cam);
  ctx.fillStyle = l.role === 'hole' ? style.resultHole : style.resultOuter;
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const tag = l.role === 'hole' ? '孔' : '外';
  ctx.fillText(`${tag} ${l.id.split('-').slice(1).join('-')}`, anchor.x + 3, anchor.y + 3);
}

export function drawIssues(
  ctx: DrawContext,
  issues: GeometryIssue[],
  cam: Camera,
  style: RenderStyle,
): void {
  for (const issue of issues) {
    if (!issue.point) continue;
    const c = worldToCanvas(issue.point, cam);
    const r = 7;
    ctx.save();
    ctx.strokeStyle = style.issue;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x - r, c.y - r);
    ctx.lineTo(c.x + r, c.y + r);
    ctx.moveTo(c.x + r, c.y - r);
    ctx.lineTo(c.x - r, c.y + r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.x, c.y, r + 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
