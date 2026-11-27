/**
 * 标签自动排版引擎（纯函数、确定性、不依赖 DOM）。
 *
 * 设计要点：
 * - 标签在输入时按屏幕像素测量，进入引擎前按相机 scale 换算成地图单位，
 *   因此同一份设计在不同画布规格下重算，恢复逻辑与保存格式都以地图坐标为准。
 * - 每个锚点生成一圈候选位置（八方向 × 两圈 + 轴向微调），按
 *   禁放/重叠/盖锚点等硬约束和连线长度、偏移方向等软约束打分，取最优。
 * - 找不到可接受位置时折叠该标签，记录结构化原因；低优先级在容量预算下先折叠。
 * - 人工固定（manualOverrides / pinned）的标签不参与自动寻位，只做冲突检测，
 *   冲突由 conflicts 显式标出。
 */
import type {
  AnchorInput,
  DesignDocument,
  FoldReason,
  ForbiddenZone,
  LabelStyle,
  ManualOverride,
  PlacedLabel,
} from './model.js';
import type { Rect, Point } from './geometry.js';
import {
  clampRectToBounds,
  distance,
  inflateRect,
  intersectionArea,
  rectArea,
  rectContainsPoint,
  rectsIntersect,
  segmentIntersectsRect,
  segmentsIntersect,
} from './geometry.js';
import { detectConflicts, leaderAttachPoint } from './conflicts.js';
import type { TextMeasurer } from './text-measurer.js';

export interface LayoutOptions {
  /** 视口像素尺寸 */
  canvasWidth: number;
  canvasHeight: number;
  /** 地图单位 -> 像素 */
  scale: number;
  /** 当前视口在地图坐标系中的包围盒（旋转时为保守 AABB） */
  viewBounds: Rect;
  mapBounds: Rect;
  forbidden: ForbiddenZone[];
  anchors: AnchorInput[];
  style: LabelStyle;
  measurer: TextMeasurer;
  /** 人工移动过的标签位置（地图单位），key 为 anchorId */
  manualOverrides?: Record<string, ManualOverride>;
  /** 手动折叠(true)/展开(false)覆盖 */
  manualFolds?: Record<string, boolean>;
  /** 标签允许占据的视口面积比例，默认 0.35 */
  maxLabelCoverage?: number;
  /** 标签之间的最小屏幕像素间距 */
  pixelGap?: number;
}

export interface LayoutResult {
  labels: PlacedLabel[];
  foldedCount: number;
  visibleCount: number;
  conflictCount: number;
}

interface Candidate {
  rect: Rect;
  /** 硬约束违规量（0 表示完全干净） */
  hardPenalty: number;
  /** 软约束得分，越小越好 */
  score: number;
  failCodes: string[];
}

const DIRECTIONS: Array<[number, number]> = [
  [0, -1], // 上
  [1, 0], // 右
  [0, 1], // 下
  [-1, 0], // 左
  [1, -1], // 右上
  [-1, -1], // 左上
  [1, 1], // 右下
  [-1, 1], // 左下
];

function priorityOrder(a: AnchorInput, b: AnchorInput): number {
  return b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 为锚点生成确定性候选矩形列表（地图单位）。 */
function buildCandidates(
  anchor: Point,
  labelW: number,
  labelH: number,
  mapBounds: Rect,
): Rect[] {
  const rects: Rect[] = [];
  const seen = new Set<string>();
  const push = (r: Rect) => {
    const clamped = clampRectToBounds(r, mapBounds);
    const key = `${Math.round(clamped.x * 1000)},${Math.round(clamped.y * 1000)}`;
    if (!seen.has(key)) {
      seen.add(key);
      rects.push(clamped);
    }
  };

  for (const ring of [1, 1.75, 2.6]) {
    for (const [dx, dy] of DIRECTIONS) {
      const offsetX = (labelW / 2 + labelW * 0.35 * ring) * Math.abs(dx);
      const offsetY = (labelH / 2 + labelH * 0.6 * ring) * Math.abs(dy);
      const r: Rect = {
        x: anchor.x + dx * offsetX - labelW / 2,
        y: anchor.y + dy * offsetY - labelH / 2,
        width: labelW,
        height: labelH,
      };
      push(r);
    }
  }
  // 轴向微移候选：处理一排密集锚点
  for (const factor of [0.5, 1.25, 3.2]) {
    push({ x: anchor.x + labelW * factor, y: anchor.y - labelH / 2, width: labelW, height: labelH });
    push({ x: anchor.x - labelW * (factor + 1), y: anchor.y - labelH / 2, width: labelW, height: labelH });
    push({ x: anchor.x - labelW / 2, y: anchor.y + labelH * factor, width: labelW, height: labelH });
    push({ x: anchor.x - labelW / 2, y: anchor.y - labelH * (factor + 1), width: labelW, height: labelH });
  }
  return rects;
}

export function layoutLabels(options: LayoutOptions): LayoutResult {
  const {
    scale,
    viewBounds,
    mapBounds,
    forbidden,
    anchors,
    style,
    measurer,
    manualOverrides = {},
    manualFolds = {},
    maxLabelCoverage = 0.35,
    pixelGap = 6,
  } = options;

  if (!(scale > 0) || !Number.isFinite(scale)) {
    throw new RangeError('scale 必须是正数');
  }
  const gap = pixelGap / scale;

  // 1. 测量标签（像素 -> 地图单位）
  const measured = anchors.map((anchor) => {
    const m = measurer.measure(anchor.text, style);
    const pixelWidth = anchor.width ?? m.width;
    const pixelHeight = anchor.height ?? m.height;
    return {
      anchor,
      pixelWidth,
      pixelHeight,
      mapWidth: pixelWidth / scale,
      mapHeight: pixelHeight / scale,
    };
  });
  // 2. 可视范围外的锚点先标记（固定/手动展开除外）
  const outOfView = new Set<string>();
  for (const item of measured) {
    const { anchor } = item;
    const inView = rectContainsPoint(viewBounds, { x: anchor.x, y: anchor.y });
    if (!inView && !anchor.pinned && manualFolds[anchor.id] !== false) {
      outOfView.add(anchor.id);
    }
  }

  // 3. 容量预算：按视口面积推算可容纳的标签数，折叠线落在最低优先级。
  // 固定标签与手动展开的标签不参与预算（它们不能被自动折叠），只统计可折叠标签面积。
  const totalLabelArea = measured.reduce((sum, m) => sum + m.mapWidth * m.mapHeight, 0);
  const foldable = measured.filter(
    (m) => !m.anchor.pinned && manualFolds[m.anchor.id] !== false && !outOfView.has(m.anchor.id),
  );
  const foldableArea = foldable.reduce((sum, m) => sum + m.mapWidth * m.mapHeight, 0);
  const fixedArea = totalLabelArea - foldableArea;
  const viewArea = Math.max(viewBounds.width * viewBounds.height, 1);
  const budgetFoldIds = new Set<string>();
  const capacity = viewArea * maxLabelCoverage - fixedArea;
  if (foldableArea > capacity) {
    const sorted = [...foldable].sort((a, b) => priorityOrder(a.anchor, b.anchor)); // 高优先级在前
    let area = foldableArea;
    for (let i = sorted.length - 1; i >= 0 && area > Math.max(capacity, 0); i--) {
      budgetFoldIds.add(sorted[i].anchor.id);
      area -= sorted[i].mapWidth * sorted[i].mapHeight;
    }
  }

  // 4. 先放置人工固定标签（pinned 或存在 manualOverride），不参与寻位。
  // allLabels 是唯一的标签集合；placedRects/placedLeaders 给候选评估提供已占地几何。
  const allLabels: PlacedLabel[] = [];
  const placedRects: Rect[] = [];
  const placedLeaders: Array<{ from: Point; to: Point }> = [];
  const autoItems: typeof measured = [];
  for (const item of measured) {
    const { anchor } = item;
    const override = manualOverrides[anchor.id];
    const base: PlacedLabel = {
      anchorId: anchor.id,
      anchor: { x: anchor.x, y: anchor.y },
      text: anchor.text,
      priority: anchor.priority,
      pixelWidth: item.pixelWidth,
      pixelHeight: item.pixelHeight,
      rect: null,
      folded: false,
      pinned: anchor.pinned === true || override !== undefined,
      manualRect: null,
      conflicts: [],
    };
    if (override) {
      base.manualRect = { x: override.x, y: override.y, width: item.mapWidth, height: item.mapHeight };
      base.rect = { ...base.manualRect };
    } else if (anchor.pinned) {
      // 输入 JSON 里 pinned 但没有人工坐标：落在锚点右上方的默认位并锁定
      base.manualRect = {
        x: anchor.x + item.mapWidth * 0.25,
        y: anchor.y - item.mapHeight * 1.4,
        width: item.mapWidth,
        height: item.mapHeight,
      };
      base.rect = clampRectToBounds(base.manualRect, mapBounds);
    } else {
      autoItems.push(item);
    }
    allLabels.push(base);
    if (base.rect) {
      placedRects.push(base.rect);
      placedLeaders.push({
        from: { x: anchor.x, y: anchor.y },
        to: leaderAttachPoint({ x: anchor.x, y: anchor.y }, base.rect),
      });
    }
  }
  const labelById = new Map(allLabels.map((l) => [l.anchorId, l]));

  // 5. 自动标签：优先级从高到低依次寻位
  autoItems.sort((a, b) => priorityOrder(a.anchor, b.anchor));

  const evaluate = (candidate: Rect, self: AnchorInput): Candidate => {
    const failCodes: string[] = [];
    let hardPenalty = 0;

    for (const zone of forbidden) {
      const area = intersectionArea(candidate, zone);
      if (area > 0) {
        hardPenalty += 1000 * (area / rectArea(candidate));
        failCodes.push(`forbidden:${zone.id}`);
      }
    }
    for (const occupied of placedRects) {
      const area = intersectionArea(candidate, inflateRect(occupied, gap));
      if (area > 0) {
        hardPenalty += 500 * (area / rectArea(candidate));
        failCodes.push('overlap');
      }
    }
    for (const other of anchors) {
      if (other.id === self.id) continue;
      if (rectContainsPoint(candidate, { x: other.x, y: other.y })) {
        hardPenalty += 300;
        failCodes.push(`anchor:${other.id}`);
      }
    }
    // 标签整体飘到当前可视范围之外时，用户根本看不到，按严重违规处理
    if (!rectsIntersect(candidate, viewBounds)) {
      hardPenalty += 600;
      failCodes.push('out-of-view');
    }

    const attach = leaderAttachPoint({ x: self.x, y: self.y }, candidate);
    const leaderLength = distance({ x: self.x, y: self.y }, attach);
    const from = { x: self.x, y: self.y };

    // 连线不能穿过禁放区
    for (const zone of forbidden) {
      if (!rectContainsPoint(zone, from) && segmentIntersectsRect(from, attach, zone)) {
        hardPenalty += 250;
        failCodes.push(`leader-forbidden:${zone.id}`);
      }
    }
    // 连线不能与已放置标签的连线交叉
    for (const placed of placedLeaders) {
      if (segmentsIntersect(from, attach, placed.from, placed.to)) {
        hardPenalty += 180;
        failCodes.push('leader-cross');
      }
    }

    const centerX = candidate.x + candidate.width / 2;
    // 局部性：连线超过标签长边 4 倍后，标签与锚点的归属已经难以辨认，
    // 按超出比例计入硬罚分，逼迫密集场景下的低优先级标签折叠而不是四散飘远。
    const localityLimit = Math.max(candidate.width, candidate.height) * 4;
    if (leaderLength > localityLimit) {
      hardPenalty += 200 * (leaderLength / localityLimit);
      failCodes.push('too-far');
    }
    // 偏好：连线短、标签在锚点上方、水平对齐
    const score =
      leaderLength * 1.2 +
      Math.abs(centerX - self.x) * 0.25 +
      Math.max(0, candidate.y - self.y) * 0.4;

    return { rect: candidate, hardPenalty, score, failCodes };
  };

  for (const item of autoItems) {
    const { anchor } = item;
    const base = labelById.get(anchor.id)!;

    const forcedFold = manualFolds[anchor.id] === true;
    const autoFolded = outOfView.has(anchor.id) || budgetFoldIds.has(anchor.id);
    if (forcedFold || autoFolded) {
      base.folded = true;
      base.rect = null;
      if (forcedFold) {
        base.foldReason = { code: 'low-priority-budget', detail: '手动折叠' };
      } else if (outOfView.has(anchor.id)) {
        base.foldReason = {
          code: 'out-of-view',
          detail: '锚点在当前可视范围之外，平移/缩小画面后重新排版可恢复',
        };
      } else {
        base.foldReason = {
          code: 'low-priority-budget',
          detail: `画面容量超限（标签总面积超过视口 ${Math.round(maxLabelCoverage * 100)}%），按优先级折叠`,
        };
      }
      continue;
    }

    const candidates = buildCandidates(
      { x: anchor.x, y: anchor.y },
      item.mapWidth,
      item.mapHeight,
      mapBounds,
    );
    const evaluated = candidates
      .map((r) => evaluate(r, anchor))
      .sort((a, b) => a.hardPenalty - b.hardPenalty || a.score - b.score);
    const best = evaluated[0];
    const cleanCandidates = evaluated.filter((c) => c.hardPenalty === 0);
    // 有干净候选时直接取其中最优；否则只接受“纯轻微重叠”的折中
    // （<8% 面积、连线在局部范围内），其余情况折叠并记录原因。
    const onlyMinorOverlap =
      best.failCodes.every((c) => c === 'overlap') && best.hardPenalty < 40;

    if (cleanCandidates.length === 0 && !onlyMinorOverlap) {
      base.folded = true;
      base.rect = null;
      base.foldReason = describeFoldFailure(best, anchor);
      continue;
    }
    base.rect = (cleanCandidates[0] ?? best).rect;
    placedRects.push(base.rect);
    placedLeaders.push({
      from: { x: anchor.x, y: anchor.y },
      to: leaderAttachPoint({ x: anchor.x, y: anchor.y }, base.rect),
    });
  }

  // 固定标签也可能被手动折叠
  for (const label of allLabels) {
    if (manualFolds[label.anchorId] === true) {
      label.folded = true;
      label.rect = null;
      label.foldReason = { code: 'low-priority-budget', detail: '手动折叠' };
    }
  }

  const sortedLabels = [...allLabels].sort((a, b) => priorityOrder(
    anchors.find((x) => x.id === a.anchorId)!,
    anchors.find((x) => x.id === b.anchorId)!,
  ));

  // 6. 全局冲突检测（含人工固定标签之间的冲突，显式标出）
  const conflictMap = detectConflicts({
    labels: sortedLabels,
    forbidden,
    anchors,
    mapBounds,
    viewBounds,
    gap,
  });
  for (const label of sortedLabels) {
    label.conflicts = conflictMap.get(label.anchorId) ?? [];
  }

  const foldedCount = sortedLabels.filter((l) => l.folded).length;
  const conflictCount = sortedLabels.reduce((sum, l) => sum + l.conflicts.length, 0);
  return {
    labels: sortedLabels,
    foldedCount,
    visibleCount: sortedLabels.length - foldedCount,
    conflictCount,
  };
}

function describeFoldFailure(worst: Candidate, anchor: AnchorInput): FoldReason {
  const codes = worst.failCodes;
  if (codes.some((c) => c.startsWith('forbidden:') || c.startsWith('leader-forbidden:'))) {
    return {
      code: 'forbidden-zone',
      detail: `锚点 ${anchor.id} 周围候选位置或连线均压到禁放区（${codes
        .filter((c) => c.includes('forbidden'))
        .map((c) => c.split(':')[1])
        .join('、')}）`,
    };
  }
  if (codes.includes('out-of-view')) {
    return {
      code: 'no-space',
      detail: `锚点 ${anchor.id} 附近的候选位置都在当前可视范围之外，平移或缩小画面后重新排版可恢复`,
    };
  }
  if (codes.some((c) => c === 'overlap' || c === 'leader-cross' || c === 'too-far')) {
    return {
      code: 'overlap',
      detail: `锚点 ${anchor.id} 周围候选位置均与已放置标签或连线冲突（${[
        ...new Set(codes.map((c) => (c === 'overlap' ? '标签重叠' : c === 'leader-cross' ? '连线交叉' : '连线过长'))),
      ].join('、')}）`,
    };
  }
  return {
    code: 'no-space',
    detail: `锚点 ${anchor.id} 周围找不到满足间距的候选位置`,
  };
}

/** 把排版结果序列化为保存格式；恢复时与新排版结果逐项核对。 */
export function serializeLayout(result: LayoutResult): DesignDocument['layout'] {
  return {
    labels: result.labels.map((l) => ({
      anchorId: l.anchorId,
      rect: l.rect ? { ...l.rect } : null,
      folded: l.folded,
      foldReason: l.foldReason ? { ...l.foldReason } : null,
      conflicts: l.conflicts.map((c) => ({ ...c })),
    })),
  };
}
