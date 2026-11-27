/**
 * Canvas 2D 渲染器：把排版结果画到画布上。
 * 所有地图几何先经 Camera 转屏幕坐标；连线、标签、冲突高亮均与数据同坐标。
 */
import type { Camera } from '../core/camera.js';
import type { ForbiddenZone, PlacedLabel } from '../core/model.js';
import type { Rect, Point } from '../core/geometry.js';
import { leaderLineFor } from '../core/conflicts.js';
import type { TextMeasurer } from '../core/text-measurer.js';

export interface RenderPalette {
  background: string;
  mapFill: string;
  mapStroke: string;
  grid: string;
  forbiddenFill: string;
  forbiddenStroke: string;
  anchor: string;
  anchorFolded: string;
  leader: string;
  leaderConflict: string;
  labelFill: string;
  labelStroke: string;
  labelText: string;
  pinnedFill: string;
  conflictStroke: string;
}

export const DEFAULT_PALETTE: RenderPalette = {
  background: '#0f1620',
  mapFill: '#162331',
  mapStroke: '#3c5266',
  grid: 'rgba(120, 150, 175, 0.16)',
  forbiddenFill: 'rgba(214, 69, 69, 0.16)',
  forbiddenStroke: 'rgba(224, 92, 92, 0.85)',
  anchor: '#5db3ff',
  anchorFolded: '#7d8da0',
  leader: 'rgba(200, 214, 228, 0.75)',
  leaderConflict: '#ff7676',
  labelFill: '#f5f7fa',
  labelStroke: '#9fb2c4',
  labelText: '#1d2a38',
  pinnedFill: '#ffe9b8',
  conflictStroke: '#e05c5c',
};

export interface RenderInput {
  camera: Camera;
  mapBounds: Rect;
  forbidden: ForbiddenZone[];
  labels: PlacedLabel[];
  measurer: TextMeasurer;
  style: import('../core/model.js').LabelStyle;
  palette?: Partial<RenderPalette>;
  showGrid?: boolean;
}

function roundedRectPath(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const rr = Math.min(radius, r.width / 2, r.height / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + rr, r.y);
  ctx.arcTo(r.x + r.width, r.y, r.x + r.width, r.y + r.height, rr);
  ctx.arcTo(r.x + r.width, r.y + r.height, r.x, r.y + r.height, rr);
  ctx.arcTo(r.x, r.y + r.height, r.x, r.y, rr);
  ctx.arcTo(r.x, r.y, r.x + r.width, r.y, rr);
  ctx.closePath();
}

export class MapCanvasRenderer {
  draw(ctx: CanvasRenderingContext2D, input: RenderInput): void {
    const palette = { ...DEFAULT_PALETTE, ...(input.palette ?? {}) };
    const { camera, mapBounds, forbidden, labels, measurer, style } = input;
    const w = camera.viewportWidth;
    const h = camera.viewportHeight;

    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(camera.rotation);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.centerX, -camera.centerY);
    // 此后直接用地图坐标绘制

    if (input.showGrid !== false) this.#drawGrid(ctx, camera, mapBounds, palette);
    this.#drawMapBounds(ctx, mapBounds, palette);
    this.#drawForbidden(ctx, forbidden, camera, palette);

    const visible = labels.filter((l) => !l.folded);
    const folded = labels.filter((l) => l.folded);

    // 锚点（折叠的画空心点）
    for (const label of labels) {
      this.#drawAnchor(ctx, label, palette);
    }

    // 连线
    for (const label of visible) {
      const leader = leaderLineFor(label);
      if (!leader) continue;
      const hasCrossConflict = label.conflicts.some((c) => c.kind === 'leader-cross');
      ctx.strokeStyle = hasCrossConflict ? palette.leaderConflict : palette.leader;
      ctx.lineWidth = 1.5 / camera.scale;
      ctx.setLineDash(hasCrossConflict ? [4 / camera.scale, 3 / camera.scale] : []);
      ctx.beginPath();
      ctx.moveTo(leader.from.x, leader.from.y);
      ctx.lineTo(leader.to.x, leader.to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 标签
    for (const label of visible) {
      this.#drawLabel(ctx, label, style, measurer, camera, palette);
    }

    // 折叠编号标记
    for (const label of folded) {
      this.#drawFoldedMarker(ctx, label, camera, palette);
    }

    ctx.restore();
  }

  #drawMapBounds(ctx: CanvasRenderingContext2D, bounds: Rect, palette: RenderPalette): void {
    ctx.fillStyle = palette.mapFill;
    ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    ctx.strokeStyle = palette.mapStroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  #drawGrid(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    bounds: Rect,
    palette: RenderPalette,
  ): void {
    // 网格间距取屏幕约 80px，向上取整到 1/2/5×10^n
    const raw = 80 / camera.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1 / camera.scale;
    ctx.beginPath();
    for (let x = Math.ceil(bounds.x / step) * step; x <= bounds.x + bounds.width; x += step) {
      ctx.moveTo(x, bounds.y);
      ctx.lineTo(x, bounds.y + bounds.height);
    }
    for (let y = Math.ceil(bounds.y / step) * step; y <= bounds.y + bounds.height; y += step) {
      ctx.moveTo(bounds.x, y);
      ctx.lineTo(bounds.x + bounds.width, y);
    }
    ctx.stroke();
  }

  #drawForbidden(
    ctx: CanvasRenderingContext2D,
    zones: ForbiddenZone[],
    camera: Camera,
    palette: RenderPalette,
  ): void {
    const spacing = 8 / camera.scale;
    for (const zone of zones) {
      ctx.fillStyle = palette.forbiddenFill;
      ctx.fillRect(zone.x, zone.y, zone.width, zone.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(zone.x, zone.y, zone.width, zone.height);
      ctx.clip();
      ctx.strokeStyle = palette.forbiddenStroke;
      ctx.lineWidth = 1.2 / camera.scale;
      ctx.beginPath();
      for (let d = zone.y - zone.width; d < zone.y + zone.height + zone.width; d += spacing) {
        ctx.moveTo(zone.x, d);
        ctx.lineTo(zone.x + zone.width, d + zone.width);
      }
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = palette.forbiddenStroke;
      ctx.lineWidth = 1.5 / camera.scale;
      ctx.strokeRect(zone.x, zone.y, zone.width, zone.height);
      if (zone.reason && camera.scale > 0.4) {
        ctx.fillStyle = palette.forbiddenStroke;
        ctx.font = `${Math.max(11 / camera.scale, 9)}px sans-serif`;
        ctx.fillText(zone.reason, zone.x + 4 / camera.scale, zone.y + 13 / camera.scale);
      }
    }
  }

  #drawAnchor(ctx: CanvasRenderingContext2D, label: PlacedLabel, palette: RenderPalette): void {
    const r = label.folded ? 4 : 5;
    ctx.beginPath();
    ctx.arc(label.anchor.x, label.anchor.y, r, 0, Math.PI * 2);
    ctx.fillStyle = label.folded ? palette.anchorFolded : palette.anchor;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = palette.background;
    ctx.stroke();
  }

  #drawFoldedMarker(
    ctx: CanvasRenderingContext2D,
    label: PlacedLabel,
    camera: Camera,
    palette: RenderPalette,
  ): void {
    const text = String(label.priority);
    ctx.font = `600 ${11 / camera.scale}px sans-serif`;
    const width = ctx.measureText(text).width + 10 / camera.scale;
    const height = 16 / camera.scale;
    const r: Rect = {
      x: label.anchor.x + 8 / camera.scale,
      y: label.anchor.y - height / 2,
      width,
      height,
    };
    roundedRectPath(ctx, r, 3 / camera.scale);
    ctx.fillStyle = palette.anchorFolded;
    ctx.fill();
    ctx.fillStyle = palette.background;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, r.x + 5 / camera.scale, label.anchor.y);
    ctx.textBaseline = 'alphabetic';
  }

  #drawLabel(
    ctx: CanvasRenderingContext2D,
    label: PlacedLabel,
    style: import('../core/model.js').LabelStyle,
    measurer: TextMeasurer,
    camera: Camera,
    palette: RenderPalette,
  ): void {
    const r = label.rect!;
    const hasConflict = label.conflicts.length > 0;
    roundedRectPath(ctx, r, 5 / camera.scale);
    ctx.fillStyle = label.pinned ? palette.pinnedFill : palette.labelFill;
    ctx.fill();
    ctx.strokeStyle = hasConflict ? palette.conflictStroke : palette.labelStroke;
    ctx.lineWidth = (hasConflict ? 2.5 : 1.2) / camera.scale;
    if (hasConflict) ctx.setLineDash([5 / camera.scale, 3 / camera.scale]);
    ctx.stroke();
    ctx.setLineDash([]);

    const measurement = measurer.measure(label.text, style);
    ctx.fillStyle = palette.labelText;
    ctx.font = `${style.fontSize / camera.scale}px ${style.lineHeight} ${style.fontFamily}`;
    ctx.textBaseline = 'top';
    const lineHeight = (style.fontSize * style.lineHeight) / camera.scale;
    const paddingX = style.paddingX / camera.scale;
    const paddingY = style.paddingY / camera.scale;
    measurement.lines.forEach((line, i) => {
      ctx.fillText(line, r.x + paddingX, r.y + paddingY + i * lineHeight);
    });
    ctx.textBaseline = 'alphabetic';

    // 固定标签的小图钉
    if (label.pinned) {
      ctx.beginPath();
      ctx.arc(r.x + r.width - 6 / camera.scale, r.y + 6 / camera.scale, 3 / camera.scale, 0, Math.PI * 2);
      ctx.fillStyle = '#c98a16';
      ctx.fill();
    }
  }
}

/** 屏幕像素 -> 命中的标签（用于拖拽与点选）。 */
export function hitTestLabel(labels: PlacedLabel[], camera: Camera, screen: Point): PlacedLabel | null {
  const mapPoint = camera.toMap(screen);
  for (const label of labels) {
    if (label.folded || !label.rect) continue;
    if (
      mapPoint.x >= label.rect.x &&
      mapPoint.x <= label.rect.x + label.rect.width &&
      mapPoint.y >= label.rect.y &&
      mapPoint.y <= label.rect.y + label.rect.height
    ) {
      return label;
    }
  }
  return null;
}
