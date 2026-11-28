import type { EdgeView, GameView, PoolView } from '../types.ts';

/** 画布的可视区域（逻辑像素）。 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 绘制所需的颜色与样式，集中在此处，UI 与场景构建共用。 */
export const palette = {
  background: '#0b1a24',
  grid: '#14303d',
  panel: '#102632',
  panelEdge: '#2a4c5b',
  waterHigh: '#3fa9d6',
  waterMid: '#2d86b3',
  waterLow: '#1f5f85',
  waterSurface: '#9fe3ff',
  empty: '#0e2531',
  maintenance: '#3a2c1a',
  maintenanceEdge: '#c9a227',
  maintenanceFlood: '#a3261c',
  text: '#e7f1f6',
  muted: '#93aab7',
  gateOpen: '#6fe0a1',
  gateClosed: '#e05a4f',
  edge: '#3d5f70',
  edgeActive: '#54b6e0',
  edgeIdle: '#253f4c',
  danger: '#ff6b5e',
  goal: '#ffd166',
} as const;

/** 池子布局在画布上的矩形。 */
export interface PoolRect {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 计算池子的水位高度（像素），水面从底部向上生长。 */
export function waterHeight(pool: PoolView): number {
  const ratio = pool.capacity <= 0 ? 0 : Math.min(1, Math.max(0, pool.level / pool.capacity));
  return ratio * pool.layout.height;
}

export function poolRect(pool: PoolView): PoolRect {
  return { id: pool.id, x: pool.layout.x, y: pool.layout.y, width: pool.layout.width, height: pool.layout.height };
}

export function poolCenter(pool: PoolView): Point {
  return { x: pool.layout.x + pool.layout.width / 2, y: pool.layout.y + pool.layout.height / 2 };
}

/** 支路的采样点：优先用关卡给出的折线；否则从起点底部连到终点顶部。 */
export function edgePoints(edge: EdgeView, pools: ReadonlyMap<string, PoolView>): readonly Point[] {
  if (edge.layout && edge.layout.points.length >= 2) {
    return edge.layout.points.map(([x, y]) => ({ x, y }));
  }
  const from = pools.get(edge.from);
  const to = pools.get(edge.to);
  if (!from || !to) return [];
  return [
    { x: from.layout.x + from.layout.width, y: from.layout.y + from.layout.height / 2 },
    { x: to.layout.x, y: to.layout.y + to.layout.height / 2 },
  ];
}

/** 折线中点，用于摆放边上的流量标签。 */
export function polylineMidpoint(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  let total = 0;
  const segments: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    segments.push(length);
    total += length;
  }
  const half = total / 2;
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = segments[index - 1]!;
    if (travelled + length >= half) {
      const t = length === 0 ? 0 : (half - travelled) / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    travelled += length;
  }
  return points.at(-1)!;
}

/** 画布视口：关卡布局坐标都落在 0..980 / 0..470 内，画布按容器等比缩放。 */
export const WORLD_WIDTH = 980;
export const WORLD_HEIGHT = 470;

/** 检查所有池子是否都在视口内，供布局自检使用。 */
export function poolsWithinViewport(view: GameView, viewport: Viewport = { width: WORLD_WIDTH, height: WORLD_HEIGHT }): boolean {
  return view.pools.every((pool) =>
    pool.layout.x >= 0
    && pool.layout.y >= 0
    && pool.layout.x + pool.layout.width <= viewport.width
    && pool.layout.y + pool.layout.height <= viewport.height);
}
