import type { EdgeView, GameView, PoolView } from '../types.ts';
import type { Point } from './scene.ts';
import {
  edgePoints,
  palette,
  polylineMidpoint,
  poolRect,
  waterHeight,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from './scene.ts';

/** 只依赖 Canvas 2D 常用子集的绘制接口，便于用录制上下文做单元测试。 */
export interface RenderContext {
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  setLineDash(dashes: number[]): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

export interface RenderOptions {
  readonly width?: number;
  readonly height?: number;
  /** 悬停高亮。 */
  readonly highlightGate?: string | null;
  readonly highlightPool?: string | null;
}

/**
 * 画一帧水道场景。坐标都是关卡布局坐标（WORLD_WIDTH × WORLD_HEIGHT），
 * 调用方通过 CSS 与 devicePixelRatio 把画布缩放到容器。
 */
export function renderScene(
  context: RenderContext,
  view: GameView,
  options: RenderOptions = {},
): void {
  const width = options.width ?? WORLD_WIDTH;
  const height = options.height ?? WORLD_HEIGHT;
  const poolsById = new Map<string, PoolView>(view.pools.map((pool) => [pool.id, pool]));

  context.save();
  context.clearRect(0, 0, width, height);
  context.fillStyle = palette.background;
  context.fillRect(0, 0, width, height);
  drawGrid(context, width, height);

  // 支路在最底层，避免压住池子与文字。
  for (const edge of view.edges) drawEdge(context, edge, poolsById);
  for (const pool of view.pools) drawPool(context, pool, view, options.highlightPool === pool.id);
  for (const gate of view.gates) drawGate(context, gate, options.highlightGate === gate.id);

  drawGoalBanner(context, view);
  drawTurnBadge(context, view);
  context.restore();
}

function drawGrid(context: RenderContext, width: number, height: number): void {
  context.save();
  context.strokeStyle = palette.grid;
  context.lineWidth = 1;
  context.setLineDash([]);
  for (let x = 40; x < width; x += 40) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 40; y < height; y += 40) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.restore();
}

function drawEdge(
  context: RenderContext,
  edge: EdgeView,
  poolsById: ReadonlyMap<string, PoolView>,
): void {
  const points = edgePoints(edge, poolsById);
  if (points.length < 2) return;

  const last = edge.throughputLastTurn;
  const active = last > 0;
  const showingPreview = edge.previewOpen !== edge.open;

  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  // 通过量越大，线条越粗，直观提示“这里过得更多”。
  context.lineWidth = active ? Math.min(11, 3 + last * 1.2) : 3;
  context.strokeStyle = active ? palette.edgeActive : edge.open ? palette.edge : palette.edgeIdle;
  context.globalAlpha = edge.previewOpen ? 1 : 0.5;
  context.setLineDash(showingPreview && !edge.previewOpen ? [7, 5] : []);
  strokePolyline(context, points);
  context.restore();

  const middle = polylineMidpoint(points);
  const direction = directionAt(points, middle);
  drawArrow(context, middle, direction, active ? palette.edgeActive : palette.edge);

  // 标签沿支路法线偏移，避免压住闸门徽标与箭头。
  const offset = 15;
  const labelAt = {
    x: middle.x - direction.y * offset,
    y: middle.y + direction.x * offset,
  };

  // 有实际通过量时显示数字；若本回合布置会让它打开，则显示“可达上限”。
  if (active) {
    drawEdgeLabel(context, `${last}`, labelAt, palette.edgeActive, false);
  } else if (showingPreview && edge.previewOpen) {
    drawEdgeLabel(context, `≤${edge.capacity}`, labelAt, palette.edgeActive, true);
  } else if (!edge.open && showingPreview) {
    drawEdgeLabel(context, '关', labelAt, palette.muted, true);
  }
}

function strokePolyline(context: RenderContext, points: readonly Point[]): void {
  context.beginPath();
  context.moveTo(points[0]!.x, points[0]!.y);
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index]!.x, points[index]!.y);
  }
  context.stroke();
}

function directionAt(points: readonly Point[], at: Point): Point {
  let best: Point = { x: 1, y: 0 };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const distance = Math.hypot((a.x + b.x) / 2 - at.x, (a.y + b.y) / 2 - at.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      best = { x: dx / length, y: dy / length };
    }
  }
  return best;
}

function drawArrow(context: RenderContext, at: Point, direction: Point, color: string): void {
  const size = 7;
  const px = -direction.y;
  const py = direction.x;
  context.save();
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(at.x + direction.x * size, at.y + direction.y * size);
  context.lineTo(at.x - direction.x * size * 0.5 + px * size * 0.7,
    at.y - direction.y * size * 0.5 + py * size * 0.7);
  context.lineTo(at.x - direction.x * size * 0.5 - px * size * 0.7,
    at.y - direction.y * size * 0.5 - py * size * 0.7);
  context.closePath();
  context.fill();
  context.restore();
}

function drawEdgeLabel(
  context: RenderContext,
  text: string,
  at: Point,
  color: string,
  dashed: boolean,
): void {
  context.save();
  context.font = '700 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const width = context.measureText(text).width + 14;
  context.fillStyle = '#0d202b';
  context.strokeStyle = dashed ? palette.panelEdge : color;
  context.lineWidth = 1;
  if (dashed) context.setLineDash([3, 3]);
  roundedRectPath(context, at.x - width / 2, at.y - 11, width, 22, 6);
  context.fill();
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = color;
  context.fillText(text, at.x, at.y + 1);
  context.restore();
}

function drawPool(context: RenderContext, pool: PoolView, view: GameView, highlighted: boolean): void {
  const rect = poolRect(pool);
  const isGoal = view.goal.pool === pool.id;
  const ratio = pool.capacity <= 0 ? 0 : Math.min(1, Math.max(0, pool.level / pool.capacity));
  const waterHeightPx = waterHeight(pool);
  const surfaceY = rect.y + rect.height - waterHeightPx;

  context.save();

  // 池槽底色：检修格用土黄色区分。
  context.fillStyle = pool.maintenance ? palette.maintenance : palette.empty;
  roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, 8);
  context.fill();

  // 水体（矩形，内缩 2px 让圆角边框可见）。
  if (pool.level > 0) {
    context.fillStyle = waterColor(ratio);
    context.globalAlpha = 0.9;
    context.fillRect(rect.x + 2, surfaceY, rect.width - 4, rect.y + rect.height - surfaceY - 2);
    context.globalAlpha = 1;
    context.strokeStyle = palette.waterSurface;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(rect.x + 3, surfaceY);
    context.lineTo(rect.x + rect.width - 3, surfaceY);
    context.stroke();
  }

  // 边框
  context.strokeStyle = highlighted
    ? palette.waterSurface
    : pool.maintenance
      ? palette.maintenanceEdge
      : isGoal
        ? palette.goal
        : palette.panelEdge;
  context.lineWidth = isGoal || highlighted ? 2.5 : 1.5;
  roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, 8);
  context.stroke();

  // 容量线（池顶虚线），水位到达这里就是溢流线。
  context.strokeStyle = palette.muted;
  context.lineWidth = 1;
  context.globalAlpha = 0.55;
  context.setLineDash([5, 4]);
  context.beginPath();
  context.moveTo(rect.x + 4, rect.y + 5);
  context.lineTo(rect.x + rect.width - 4, rect.y + 5);
  context.stroke();
  context.setLineDash([]);
  context.globalAlpha = 1;

  // 名称与水位数值
  context.fillStyle = palette.text;
  context.font = '600 15px ui-sans-serif, system-ui, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillText(pool.label, rect.x, rect.y - 12);

  const flooded = pool.maintenance && pool.level > pool.safeLevel;
  context.fillStyle = flooded ? palette.danger : palette.text;
  context.font = '700 15px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.textAlign = 'right';
  context.fillText(`${pool.level}/${pool.capacity}`, rect.x + rect.width, rect.y + rect.height + 18);

  if (pool.maintenance) {
    context.fillStyle = palette.maintenanceEdge;
    context.font = '12px ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'left';
    context.fillText(`安全线 ${pool.safeLevel}`, rect.x, rect.y + rect.height + 18);
  } else if (isGoal) {
    context.fillStyle = palette.goal;
    context.font = '12px ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'left';
    context.fillText(`目标 ≥ ${view.goal.atLeast}`, rect.x, rect.y + rect.height + 18);
  }

  if (pool.spillLastTurn > 0) {
    context.fillStyle = palette.danger;
    context.font = '700 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textAlign = 'right';
    context.fillText(`溢流 ${pool.spillLastTurn}`, rect.x + rect.width, rect.y - 12);
  }

  context.restore();
}

function waterColor(ratio: number): string {
  if (ratio >= 1) return palette.waterHigh;
  if (ratio >= 0.5) return palette.waterMid;
  return palette.waterLow;
}

/** 生成一条圆角矩形路径（不填充），调用方决定 fill/stroke。 */
function roundedRectPath(
  context: RenderContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
  context.lineTo(x + width, y + height - r);
  context.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
  context.lineTo(x + r, y + height);
  context.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
  context.lineTo(x, y + r);
  context.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  context.closePath();
}

function drawGate(context: RenderContext, gate: GameView['gates'][number], highlighted: boolean): void {
  if (!gate.layout) return;
  const { x, y } = gate.layout;
  const effective = gate.pending ?? gate.committed;
  const open = effective === 'open';
  const pending = gate.pending !== null;

  context.save();
  context.fillStyle = open
    ? (pending ? '#245c3f' : '#1d4936')
    : (pending ? '#5b2a26' : '#3a2320');
  roundedRectPath(context, x - 11, y - 12, 22, 24, 5);
  context.fill();
  context.strokeStyle = open ? palette.gateOpen : palette.gateClosed;
  context.lineWidth = highlighted ? 3 : pending ? 2.4 : 1.6;
  if (pending) context.setLineDash([4, 3]);
  roundedRectPath(context, x - 11, y - 12, 22, 24, 5);
  context.stroke();
  context.setLineDash([]);

  // 开：闸杆抬起靠右；关：闸杆落下挡在左侧。
  context.strokeStyle = open ? palette.gateOpen : palette.gateClosed;
  context.lineWidth = 2.5;
  context.beginPath();
  if (open) {
    context.moveTo(x + 3, y - 8);
    context.lineTo(x + 8, y - 8);
    context.lineTo(x + 8, y + 8);
  } else {
    context.moveTo(x - 5, y - 8);
    context.lineTo(x - 5, y + 8);
  }
  context.stroke();

  context.fillStyle = pending ? palette.waterSurface : palette.text;
  context.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  context.fillText(gate.id, x, y - 16);
  context.restore();
}

function drawGoalBanner(context: RenderContext, view: GameView): void {
  context.save();
  const width = 268;
  const height = 32;
  const x = 16;
  const y = 14;
  context.fillStyle = palette.panel;
  roundedRectPath(context, x, y, width, height, 8);
  context.fill();
  context.strokeStyle = palette.panelEdge;
  context.lineWidth = 1;
  roundedRectPath(context, x, y, width, height, 8);
  context.stroke();

  const goalPool = view.pools.find((pool) => pool.id === view.goal.pool);
  const achieved = goalPool ? goalPool.level >= view.goal.atLeast : false;
  context.fillStyle = achieved ? palette.gateOpen : palette.goal;
  context.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  const label = goalPool ? goalPool.label : view.goal.pool;
  context.fillText(`目标：${label} ≥ ${view.goal.atLeast}`, x + 12, y + height / 2 + 1);
  context.restore();
}

function drawTurnBadge(context: RenderContext, view: GameView): void {
  context.save();
  const width = 190;
  const height = 52;
  const x = WORLD_WIDTH - width - 16;
  const y = 14;
  context.fillStyle = palette.panel;
  roundedRectPath(context, x, y, width, height, 10);
  context.fill();
  context.strokeStyle = palette.panelEdge;
  context.lineWidth = 1;
  roundedRectPath(context, x, y, width, height, 10);
  context.stroke();

  const label = view.outcome === 'playing'
    ? `回合 ${view.turnsPlayed + 1}`
    : view.outcome === 'won' ? '通关' : '结束';
  context.fillStyle = palette.text;
  context.font = '700 22px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillText(label, x + 14, y + 32);

  const remaining = view.turnsRemaining;
  context.fillStyle = remaining <= 1 ? palette.danger : palette.muted;
  context.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  context.textAlign = 'right';
  context.fillText(`剩 ${remaining} 回合`, x + width - 14, y + 24);
  context.fillStyle = palette.muted;
  context.font = '11px ui-sans-serif, system-ui, sans-serif';
  context.fillText(`共 ${view.turnLimit} 回合`, x + width - 14, y + 40);
  context.restore();
}

/** 点击命中：先找闸门，再找池子。 */
export function hitTest(
  view: GameView,
  point: Point,
  gateRadius = 15,
): { gateId: string | null; poolId: string | null } {
  let gateId: string | null = null;
  let poolId: string | null = null;
  for (const gate of view.gates) {
    if (!gate.layout) continue;
    if (Math.abs(point.x - gate.layout.x) <= gateRadius && Math.abs(point.y - gate.layout.y) <= gateRadius) {
      gateId = gate.id;
    }
  }
  for (const pool of view.pools) {
    const rect = poolRect(pool);
    if (point.x >= rect.x && point.x <= rect.x + rect.width
      && point.y >= rect.y && point.y <= rect.y + rect.height) {
      poolId = pool.id;
    }
  }
  return { gateId, poolId };
}

/** 画布坐标 → 关卡布局坐标，处理等比缩放后的留边。 */
export function screenToWorld(
  clientX: number,
  clientY: number,
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  world: { readonly width: number; readonly height: number } = { width: WORLD_WIDTH, height: WORLD_HEIGHT },
): Point {
  const scale = Math.min(rect.width / world.width, rect.height / world.height);
  const offsetX = (rect.width - world.width * scale) / 2;
  const offsetY = (rect.height - world.height * scale) / 2;
  return {
    x: (clientX - rect.left - offsetX) / scale,
    y: (clientY - rect.top - offsetY) / scale,
  };
}
