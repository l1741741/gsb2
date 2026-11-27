import {
  bearingToCanvasAngle,
  bearingToVector,
  orientedRectangle,
  pointInPolygon,
} from '../src/core/math.ts';
import { dockRectangle } from '../src/core/sim.ts';
import { zoneWinds } from '../src/core/wind.ts';
import type { Level, LevelPalette, RunFrame, Vec2 } from '../src/core/types.ts';
import { DEFAULT_PALETTE } from '../src/core/types.ts';

export interface Viewport {
  /** 世界坐标原点对应画布的左上偏移。 */
  offsetX: number;
  offsetY: number;
  /** 每米多少像素。 */
  scale: number;
}

export interface RenderState {
  level: Level;
  /** 当前回放 / 执行到的船位。 */
  frame: RunFrame | null;
  /** 已经发生的航迹。 */
  trail: Vec2[];
  /** 预计航迹（预览线）。 */
  predicted: Vec2[];
  /** 当前编辑 / 预览选中的控制点。 */
  selectedCommand: { time: number; heading: number; sheet: number } | null;
  /** 已按次序通过的浮标数。 */
  progress: number;
  /** 已发生的事件：浮标跨线、问题点等。 */
  events: Array<{ kind: 'gate' | 'issue' | 'dock'; time: number; position: Vec2; label: string }>;
  /** 当前仿真时刻，用于解析风区标签。 */
  time: number;
  /** 是否显示预计航迹。 */
  showPrediction: boolean;
  /** 是否显示风区。 */
  showZones: boolean;
  /** 是否显示浮标编号与风区名称。 */
  showLabels: boolean;
  /** 高亮浮标 id（鼠标悬停）。 */
  hoveredGate: string | null;
  /** 高亮障碍 id。 */
  hoveredObstacle: string | null;
  /** 画布中鼠标的世界坐标，null 表示不在画布上。 */
  pointer: Vec2 | null;
}

export function paletteOf(level: Level): LevelPalette {
  return { ...DEFAULT_PALETTE, ...(level.palette ?? {}) };
}

export function computeViewport(level: Level, width: number, height: number, padding = 18): Viewport {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of level.bounds) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const worldWidth = maxX - minX;
  const worldHeight = maxY - minY;
  const scale = Math.min((width - padding * 2) / worldWidth, (height - padding * 2) / worldHeight);
  const offsetX = (width - worldWidth * scale) / 2 - minX * scale;
  const offsetY = (height - worldHeight * scale) / 2 - minY * scale;
  return { offsetX, offsetY, scale };
}

export function worldToScreen(viewport: Viewport, point: Vec2): Vec2 {
  return { x: viewport.offsetX + point.x * viewport.scale, y: viewport.offsetY + point.y * viewport.scale };
}

export function screenToWorld(viewport: Viewport, point: Vec2): Vec2 {
  return { x: (point.x - viewport.offsetX) / viewport.scale, y: (point.y - viewport.offsetY) / viewport.scale };
}

/** 把整张图按当前状态画出来。纯绘制函数，不改变任何状态。 */
export function renderScene(
  context: CanvasRenderingContext2D,
  state: RenderState,
  width: number,
  height: number,
): Viewport {
  const palette = paletteOf(state.level);
  const viewport = computeViewport(state.level, width, height);

  context.save();
  context.clearRect(0, 0, width, height);

  // 水面底色。
  context.fillStyle = palette.water;
  context.fillRect(0, 0, width, height);

  drawWaterTexture(context, viewport, width, height);

  if (state.showZones) drawWindZones(context, viewport, state);

  drawDock(context, viewport, state.level, palette);

  drawObstacles(context, viewport, state, palette);

  drawRoute(context, viewport, state, palette);

  if (state.showPrediction) drawTrail(context, viewport, state.predicted, palette.predicted, 1.6, 0.9);

  drawTrail(context, viewport, state.trail, palette.wake, 2.4, 0.9);

  drawBuoys(context, viewport, state, palette);

  drawIssues(context, viewport, state, palette);

  if (state.frame) drawBoat(context, viewport, state, palette);

  drawWindIndicator(context, state, palette);

  context.restore();
  return viewport;
}

function drawWaterTexture(context: CanvasRenderingContext2D, viewport: Viewport, width: number, height: number): void {
  // 稀疏的等深线，纯装饰，不影响判定与命中。
  context.save();
  context.strokeStyle = 'rgba(150, 210, 225, 0.06)';
  context.lineWidth = 1;
  const spacing = viewport.scale * 36;
  context.beginPath();
  for (let x = spacing; x < width; x += spacing) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let y = spacing; y < height; y += spacing) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
  context.restore();
}

function drawWindZones(context: CanvasRenderingContext2D, viewport: Viewport, state: RenderState): void {
  const palette = paletteOf(state.level);
  const zones = zoneWinds(state.level, state.time);
  context.save();
  for (const zone of state.level.windZones) {
    const view = zones.find((item) => item.zoneId === zone.id);
    context.beginPath();
    const points = zone.vertices.map((vertex) => worldToScreen(viewport, vertex));
    const first = points[0];
    if (!first) continue;
    context.moveTo(first.x, first.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.closePath();
    context.fillStyle = palette.zone;
    context.fill();
    context.strokeStyle = 'rgba(160, 220, 235, 0.28)';
    context.lineWidth = 1;
    context.setLineDash([6, 6]);
    context.stroke();
    context.setLineDash([]);

    if (state.showLabels && view) {
      const centroid = average(points);
      context.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillStyle = palette.zoneLabel;
      context.globalAlpha = 0.85;
      context.fillText(zone.name, centroid.x, centroid.y - 6);
      context.font = '11px ui-sans-serif, system-ui, sans-serif';
      context.fillText(
        `${Math.round(view.wind.direction)}° · ${view.wind.speed.toFixed(1)} m/s`,
        centroid.x,
        centroid.y + 10,
      );
      context.globalAlpha = 1;
    }
  }
  context.restore();
}

function drawDock(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  level: Level,
  palette: LevelPalette,
): void {
  const rect = dockRectangle(level).map((point) => worldToScreen(viewport, point));
  context.save();
  context.beginPath();
  rect.forEach((point, index) => (index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
  context.closePath();
  context.fillStyle = palette.dock;
  context.globalAlpha = 0.9;
  context.fill();
  context.globalAlpha = 1;
  context.strokeStyle = 'rgba(255, 236, 200, 0.75)';
  context.lineWidth = 2;
  context.stroke();

  // 泊位入口线与限速标注。
  const dock = level.dock;
  const forward = bearingToVector(dock.heading);
  const side = bearingToVector(dock.heading + 90);
  const mouthA = worldToScreen(viewport, {
    x: dock.mouth.x + side.x * (dock.width / 2),
    y: dock.mouth.y + side.y * (dock.width / 2),
  });
  const mouthB = worldToScreen(viewport, {
    x: dock.mouth.x - side.x * (dock.width / 2),
    y: dock.mouth.y - side.y * (dock.width / 2),
  });
  context.strokeStyle = '#ffe1a8';
  context.lineWidth = 2;
  context.setLineDash([4, 3]);
  context.beginPath();
  context.moveTo(mouthA.x, mouthA.y);
  context.lineTo(mouthB.x, mouthB.y);
  context.stroke();
  context.setLineDash([]);

  const label = worldToScreen(viewport, {
    x: dock.mouth.x + forward.x * (dock.length * 0.45),
    y: dock.mouth.y + forward.y * (dock.length * 0.45),
  });
  context.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillStyle = '#2a1a0c';
  context.fillText(`${level.dock.name} · ${level.dock.speedLimit.toFixed(1)} m/s`, label.x, label.y);
  context.restore();
}

function drawObstacles(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  state: RenderState,
  palette: LevelPalette,
): void {
  context.save();
  for (const obstacle of state.level.obstacles) {
    const hovered = state.hoveredObstacle === obstacle.id;
    context.fillStyle = hovered ? '#5c6f68' : palette.obstacle;
    context.strokeStyle = hovered ? '#ffd27a' : 'rgba(20, 30, 28, 0.9)';
    context.lineWidth = 2;

    if (obstacle.kind === 'circle') {
      const center = worldToScreen(viewport, obstacle.center);
      context.beginPath();
      context.arc(center.x, center.y, obstacle.radius * viewport.scale, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      // 岩石纹理：两道内凹弧。
      context.strokeStyle = 'rgba(255,255,255,0.12)';
      context.beginPath();
      context.arc(center.x, center.y, obstacle.radius * viewport.scale * 0.6, 0.4, 2.2);
      context.stroke();
    } else {
      const points = obstacle.vertices.map((vertex) => worldToScreen(viewport, vertex));
      context.beginPath();
      points.forEach((point, index) => (index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
      context.closePath();
      context.fill();
      context.stroke();
    }
  }
  context.restore();
}

function drawRoute(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  state: RenderState,
  palette: LevelPalette,
): void {
  // 航线示意：浮标之间画淡线，帮助玩家理解次序。
  if (!state.showLabels) return;
  context.save();
  context.strokeStyle = palette.routeLine;
  context.lineWidth = 1;
  context.setLineDash([5, 6]);
  const points = state.level.route
    .map((id) => state.level.buoys.find((buoy) => buoy.id === id))
    .filter((gate): gate is NonNullable<typeof gate> => Boolean(gate))
    .map((gate) => worldToScreen(viewport, { x: (gate.a.x + gate.b.x) / 2, y: (gate.a.y + gate.b.y) / 2 }));
  const start = worldToScreen(viewport, state.level.start.position);
  context.beginPath();
  context.moveTo(start.x, start.y);
  for (const point of points) context.lineTo(point.x, point.y);
  context.stroke();
  context.restore();
}

function drawTrail(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  trail: readonly Vec2[],
  color: string,
  width: number,
  alpha: number,
): void {
  if (trail.length < 2) return;
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = color;
  context.lineWidth = width;
  context.beginPath();
  trail.forEach((point, index) => {
    const screen = worldToScreen(viewport, point);
    if (index === 0) context.moveTo(screen.x, screen.y);
    else context.lineTo(screen.x, screen.y);
  });
  context.stroke();
  context.restore();
}

function drawBuoys(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  state: RenderState,
  palette: LevelPalette,
): void {
  context.save();
  const routeIndex = new Map(state.level.route.map((id, index) => [id, index]));
  for (const gate of state.level.buoys) {
    const index = routeIndex.get(gate.id);
    const passed = index !== undefined && index < state.progress;
    const next = index !== undefined && index === state.progress;
    const color = passed ? palette.buoyPassed : next ? palette.buoyNext : palette.buoy;
    const hovered = state.hoveredGate === gate.id;

    const a = worldToScreen(viewport, gate.a);
    const b = worldToScreen(viewport, gate.b);
    context.strokeStyle = color;
    context.lineWidth = next ? 3 : 1.6;
    context.setLineDash(next ? [] : [3, 4]);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
    context.setLineDash([]);

    for (const point of [a, b]) {
      context.beginPath();
      context.arc(point.x, point.y, hovered ? 6 : next ? 5.5 : 4, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
      context.strokeStyle = 'rgba(10, 24, 32, 0.8)';
      context.lineWidth = 1.5;
      context.stroke();
    }

    if (state.showLabels && index !== undefined) {
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      context.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillStyle = color;
      context.fillText(`#${index + 1}`, center.x, center.y - 9);
    }
  }
  context.restore();
}

function drawIssues(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  state: RenderState,
  palette: LevelPalette,
): void {
  context.save();
  for (const event of state.events) {
    const point = worldToScreen(viewport, event.position);
    if (event.kind === 'issue') {
      context.strokeStyle = '#ff7a6b';
      context.fillStyle = 'rgba(255, 122, 107, 0.22)';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(point.x, point.y, 11, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.beginPath();
      context.moveTo(point.x - 5, point.y - 5);
      context.lineTo(point.x + 5, point.y + 5);
      context.moveTo(point.x + 5, point.y - 5);
      context.lineTo(point.x - 5, point.y + 5);
      context.stroke();
    } else {
      context.strokeStyle = event.kind === 'dock' ? '#ffe1a8' : palette.buoyPassed;
      context.lineWidth = 1.6;
      context.beginPath();
      context.arc(point.x, point.y, 7, 0, Math.PI * 2);
      context.stroke();
    }
  }
  context.restore();
}

function drawBoat(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  state: RenderState,
  palette: LevelPalette,
): void {
  const frame = state.frame;
  if (!frame) return;
  const position = worldToScreen(viewport, frame.position);
  const angle = bearingToCanvasAngle(frame.heading);
  const hullLength = 22;
  const hullWidth = 8;

  context.save();
  context.translate(position.x, position.y);
  context.rotate(angle);

  // 帆位可视化：帆的面积随帆位缩放。
  const sheet = Math.max(0.08, frame.sheet);
  context.fillStyle = 'rgba(240, 246, 250, 0.92)';
  context.beginPath();
  context.moveTo(1, -3);
  context.quadraticCurveTo(2 + sheet * 9, -3 - sheet * 11, 2 + sheet * 12, -2);
  context.closePath();
  context.fill();

  // 船体。
  context.fillStyle = '#183746';
  context.beginPath();
  context.moveTo(hullLength / 2, 0);
  context.quadraticCurveTo(hullLength / 4, hullWidth / 2, -hullLength / 2, hullWidth / 2);
  context.lineTo(-hullLength / 2, -hullWidth / 2);
  context.quadraticCurveTo(hullLength / 4, -hullWidth / 2, hullLength / 2, 0);
  context.closePath();
  context.fill();
  context.strokeStyle = palette.buoyNext;
  context.lineWidth = 1.2;
  context.stroke();

  context.restore();

  // 航迹方向小箭头，帮助玩家看出漂移。
  const track = worldToScreen(viewport, {
    x: frame.position.x + bearingToVector(frame.track).x * 10,
    y: frame.position.y + bearingToVector(frame.track).y * 10,
  });
  context.save();
  context.strokeStyle = 'rgba(160, 220, 235, 0.5)';
  context.lineWidth = 1;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(position.x, position.y);
  context.lineTo(track.x, track.y);
  context.stroke();
  context.restore();
}

function drawWindIndicator(context: CanvasRenderingContext2D, state: RenderState, palette: LevelPalette): void {
  const frame = state.frame;
  if (!frame) return;
  context.save();
  context.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  context.textAlign = 'left';
  context.fillStyle = palette.zoneLabel;
  const label = frame.zoneName ? `${frame.zoneName} · 风 ${Math.round(frame.windDirection)}° ${frame.windSpeed.toFixed(1)} m/s` : `风 ${Math.round(frame.windDirection)}° ${frame.windSpeed.toFixed(1)} m/s`;
  context.fillText(label, 16, 22);
  context.restore();
}

function average(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** 命中测试：用于鼠标悬停 / 选中浮标或障碍。 */
export function hitTest(level: Level, viewport: Viewport, point: Vec2): { gate: string | null; obstacle: string | null } {
  let gate: string | null = null;
  let obstacle: string | null = null;
  const world = screenToWorld(viewport, point);

  for (const buoy of level.buoys) {
    const center = { x: (buoy.a.x + buoy.b.x) / 2, y: (buoy.a.y + buoy.b.y) / 2 };
    const radius = Math.max(6, buoy.radius ?? 4) * 1.8;
    if (Math.hypot(center.x - world.x, center.y - world.y) <= radius) {
      gate = buoy.id;
      break;
    }
  }

  for (const item of level.obstacles) {
    if (item.kind === 'circle') {
      if (Math.hypot(item.center.x - world.x, item.center.y - world.y) <= item.radius) {
        obstacle = item.id;
        break;
      }
    } else if (pointInPolygon(world, item.vertices)) {
      obstacle = item.id;
      break;
    }
  }

  return { gate, obstacle };
}

export { orientedRectangle };
