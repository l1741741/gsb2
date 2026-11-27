/**
 * 输入 JSON 的数据模型与校验。
 *
 * 输入文件结构（样例见 demo/sample-floorplan.json）：
 * {
 *   "map":       { "bounds": {x,y,width,height} },          // 地图坐标范围
 *   "forbidden": [ {x,y,width,height,"id"?,"reason"?} ],   // 禁放区（如入口、通道）
 *   "anchors":   [ { id, x, y, text, priority, "width"?, "height"?, "pinned"? } ],
 *   "canvas":    { "width", "height" }                      // 可选：目标画布规格
 * }
 */
import type { Point, Rect } from './geometry.js';

export interface ForbiddenZone extends Rect {
  id: string;
  reason?: string;
}

export interface AnchorInput {
  id: string;
  x: number;
  y: number;
  /** 展签文案，长短不限，测量宽度时由 TextMeasurer 决定实际像素 */
  text: string;
  /** 优先级：数字越大越重要，越晚被折叠；建议 1..5 */
  priority: number;
  /** 可选：直接指定标签尺寸（屏幕像素），缺省由字体测量得到 */
  width?: number;
  height?: number;
  /** 人工固定：排版时位置锁定，只做冲突检测不参与自动布局 */
  pinned?: boolean;
}

export interface FloorplanInput {
  map: { bounds: Rect };
  forbidden?: ForbiddenZone[];
  anchors: AnchorInput[];
  canvas?: { width: number; height: number };
  /** 字体设置，决定标签测量与绘制 */
  style?: LabelStyleInput;
}

export interface LabelStyleInput {
  fontFamily?: string;
  fontSize?: number;
  paddingX?: number;
  paddingY?: number;
  lineHeight?: number;
  /** 窄屏标签的最大宽度，超出自动换行 */
  maxTextWidth?: number;
}

export interface LabelStyle {
  fontFamily: string;
  fontSize: number;
  paddingX: number;
  paddingY: number;
  lineHeight: number;
  maxTextWidth: number;
}

export const DEFAULT_STYLE: LabelStyle = {
  fontFamily:
    '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  fontSize: 13,
  paddingX: 10,
  paddingY: 7,
  lineHeight: 1.35,
  maxTextWidth: 220,
};

export function resolveStyle(input?: LabelStyleInput): LabelStyle {
  return { ...DEFAULT_STYLE, ...(input ?? {}) };
}

/** 排版后的单个标签状态。坐标统一为“地图单位”，便于跨画布规格恢复。 */
export interface PlacedLabel {
  anchorId: string;
  /** 标签矩形（地图单位）。折叠标签为 null。 */
  rect: Rect | null;
  /** 锚点在地图坐标系中的位置 */
  anchor: Point;
  text: string;
  priority: number;
  /** 标签尺寸（屏幕像素，测量结果缓存） */
  pixelWidth: number;
  pixelHeight: number;
  folded: boolean;
  pinned: boolean;
  /** 人工固定位置（地图单位矩形）；重新排版时优先恢复 */
  manualRect: Rect | null;
  /** 折叠原因，仅折叠标签有值 */
  foldReason?: FoldReason;
  /** 当前仍未解决的冲突 */
  conflicts: Conflict[];
}

export type ConflictKind =
  | 'label-overlap' // 压到另一张标签
  | 'forbidden-zone' // 压到禁放区
  | 'anchor-covered' // 盖住关键锚点
  | 'leader-cross' // 连线与另一条连线交叉
  | 'out-of-bounds'; // 超出画布可视范围

export interface Conflict {
  kind: ConflictKind;
  /** 对方对象 id：另一标签的 anchorId、禁放区 id 或锚点 id */
  targetId: string;
  /** 可读说明，直接显示在边栏 */
  detail: string;
}

export type FoldReasonCode =
  | 'no-space' // 找不到满足间距的候选位
  | 'forbidden-zone' // 所有候选位都落在禁放区
  | 'overlap' // 所有候选位都与已放置标签冲突
  | 'out-of-view' // 锚点在当前可视范围之外
  | 'low-priority-budget'; // 画面容量预算不足，按优先级淘汰

export interface FoldReason {
  code: FoldReasonCode;
  detail: string;
}

/** 保存到磁盘的设计文件：输入 + 人工改动 + 视图，恢复后应得到同一结果。 */
export interface DesignDocument {
  version: 1;
  input: FloorplanInput;
  /** key 为 anchorId */
  manualOverrides: Record<string, ManualOverride>;
  /** 被手动折叠/展开的标签，key 为 anchorId */
  manualFolds: Record<string, boolean>;
  camera: CameraSnapshot;
  /** 保存时的画布规格与排版结果，供恢复时核对 */
  canvas: { width: number; height: number };
  layout: SerializedLayout;
  savedAt: string;
}

export interface ManualOverride {
  /** 标签左上角（地图单位） */
  x: number;
  y: number;
}

export interface CameraSnapshot {
  /** 视口中心对应的地图坐标 */
  centerX: number;
  centerY: number;
  /** 地图单位 -> 屏幕像素的缩放 */
  scale: number;
  rotation: number;
}

export interface SerializedLayout {
  labels: Array<{
    anchorId: string;
    rect: Rect | null;
    folded: boolean;
    foldReason: FoldReason | null;
    conflicts: Conflict[];
  }>;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validRect(r: unknown): r is Rect {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    isFiniteNumber(o.x) &&
    isFiniteNumber(o.y) &&
    isFiniteNumber(o.width) &&
    isFiniteNumber(o.height) &&
    o.width > 0 &&
    o.height > 0
  );
}

/** 严格校验输入 JSON，错误信息直接面向使用者。 */
export function validateFloorplanInput(raw: unknown): FloorplanInput {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('输入必须是 JSON 对象');
  }
  const o = raw as Record<string, unknown>;
  if (!o.map || typeof o.map !== 'object' || !validRect((o.map as Record<string, unknown>).bounds)) {
    throw new TypeError('map.bounds 必须是 {x, y, width, height} 且宽高为正数');
  }
  const bounds = (o.map as { bounds: Rect }).bounds;

  const forbidden: ForbiddenZone[] = [];
  if (o.forbidden !== undefined) {
    if (!Array.isArray(o.forbidden)) throw new TypeError('forbidden 必须是数组');
    o.forbidden.forEach((zone, i) => {
      if (!validRect(zone)) throw new TypeError(`forbidden[${i}] 矩形无效`);
      forbidden.push({
        x: zone.x,
        y: zone.y,
        width: zone.width,
        height: zone.height,
        id: (zone as ForbiddenZone).id ?? `forbidden-${i + 1}`,
        reason: (zone as ForbiddenZone).reason,
      });
    });
  }

  if (!Array.isArray(o.anchors) || o.anchors.length === 0) {
    throw new TypeError('anchors 必须是非空数组');
  }
  const seen = new Set<string>();
  const anchors: AnchorInput[] = o.anchors.map((rawAnchor, i) => {
    if (!rawAnchor || typeof rawAnchor !== 'object') {
      throw new TypeError(`anchors[${i}] 必须是对象`);
    }
    const a = rawAnchor as Record<string, unknown>;
    if (typeof a.id !== 'string' || a.id.length === 0) {
      throw new TypeError(`anchors[${i}].id 必须是非空字符串`);
    }
    if (seen.has(a.id)) throw new TypeError(`anchors  id 重复: ${a.id}`);
    seen.add(a.id);
    if (!isFiniteNumber(a.x) || !isFiniteNumber(a.y)) {
      throw new TypeError(`anchors[${a.id}].x/y 必须是有限数字`);
    }
    if (typeof a.text !== 'string' || a.text.length === 0) {
      throw new TypeError(`anchors[${a.id}].text 必须是非空字符串`);
    }
    if (!isFiniteNumber(a.priority)) {
      throw new TypeError(`anchors[${a.id}].priority 必须是数字`);
    }
    const anchor: AnchorInput = {
      id: a.id,
      x: a.x,
      y: a.y,
      text: a.text,
      priority: a.priority,
    };
    if (a.width !== undefined) {
      if (!isFiniteNumber(a.width) || a.width <= 0) throw new TypeError(`anchors[${a.id}].width 无效`);
      anchor.width = a.width;
    }
    if (a.height !== undefined) {
      if (!isFiniteNumber(a.height) || a.height <= 0) throw new TypeError(`anchors[${a.id}].height 无效`);
      anchor.height = a.height;
    }
    if (a.pinned !== undefined) {
      if (typeof a.pinned !== 'boolean') throw new TypeError(`anchors[${a.id}].pinned 必须是布尔值`);
      anchor.pinned = a.pinned;
    }
    return anchor;
  });

  let canvas: FloorplanInput['canvas'];
  if (o.canvas !== undefined) {
    const c = o.canvas as Record<string, unknown>;
    if (!isFiniteNumber(c.width) || !isFiniteNumber(c.height) || c.width <= 0 || c.height <= 0) {
      throw new TypeError('canvas.width/height 必须是正数');
    }
    canvas = { width: c.width, height: c.height };
  }

  return {
    map: { bounds },
    forbidden,
    anchors,
    canvas,
    style: o.style as LabelStyleInput | undefined,
  };
}
