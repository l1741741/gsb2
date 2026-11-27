/**
 * 全局冲突检测。排版结束后统一跑一遍，确保人工固定标签的冲突也被显式标出。
 * 所有几何均在地图坐标系下计算。
 */
import type { Conflict, ForbiddenZone, PlacedLabel } from './model.js';
import type { AnchorInput } from './model.js';
import {
  inflateRect,
  intersectionArea,
  rectArea,
  rectContainsPoint,
  rectsIntersect,
  segmentIntersectsRect,
  segmentsIntersect,
  clamp,
  type Point,
  type Rect,
} from './geometry.js';

export interface LeaderLine {
  anchorId: string;
  from: Point;
  to: Point;
}

/** 连线终点：标签边框上离锚点最近的点；锚点在标签内时取最近边。 */
export function leaderAttachPoint(anchor: Point, r: Rect): Point {
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  const insideX = clamp(anchor.x, r.x, right);
  const insideY = clamp(anchor.y, r.y, bottom);
  if (anchor.x >= r.x && anchor.x <= right && anchor.y >= r.y && anchor.y <= bottom) {
    const distances = [
      { p: { x: anchor.x, y: r.y }, d: anchor.y - r.y },
      { p: { x: anchor.x, y: bottom }, d: bottom - anchor.y },
      { p: { x: r.x, y: anchor.y }, d: anchor.x - r.x },
      { p: { x: right, y: anchor.y }, d: right - anchor.x },
    ];
    return distances.reduce((best, cur) => (cur.d < best.d ? cur : best)).p;
  }
  return { x: insideX, y: insideY };
}

export function leaderLineFor(label: PlacedLabel): LeaderLine | null {
  if (label.folded || !label.rect) return null;
  return {
    anchorId: label.anchorId,
    from: label.anchor,
    to: leaderAttachPoint(label.anchor, label.rect),
  };
}

export interface ConflictInputs {
  labels: PlacedLabel[];
  forbidden: ForbiddenZone[];
  anchors: AnchorInput[];
  mapBounds: Rect;
  viewBounds: Rect;
  /** 检测间距（地图单位），由屏幕像素间距按 scale 换算 */
  gap: number;
}

export function detectConflicts(inputs: ConflictInputs): Map<string, Conflict[]> {
  const { labels, forbidden, anchors, mapBounds, viewBounds, gap } = inputs;
  const visible = labels.filter((l) => !l.folded && l.rect);
  const result = new Map<string, Conflict[]>(visible.map((l) => [l.anchorId, []]));
  const add = (anchorId: string, conflict: Conflict) => {
    result.get(anchorId)?.push(conflict);
  };

  // 1. 标签互相重叠（按 gap 外扩判定，贴太近也算冲突）
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i];
      const b = visible[j];
      if (rectsIntersect(inflateRect(a.rect!, gap), inflateRect(b.rect!, gap))) {
        const detail = `与标签「${b.text}」重叠或间距不足`;
        add(a.anchorId, { kind: 'label-overlap', targetId: b.anchorId, detail });
        add(b.anchorId, {
          kind: 'label-overlap',
          targetId: a.anchorId,
          detail: `与标签「${a.text}」重叠或间距不足`,
        });
      }
    }
  }

  // 2. 标签压到禁放区
  for (const label of visible) {
    for (const zone of forbidden) {
      const area = intersectionArea(label.rect!, zone);
      if (area > 0) {
        const pct = Math.round((area / rectArea(label.rect!)) * 100);
        add(label.anchorId, {
          kind: 'forbidden-zone',
          targetId: zone.id,
          detail: `压到禁放区 ${zone.id}${zone.reason ? `（${zone.reason}）` : ''}，约 ${pct}% 面积`,
        });
      }
    }
  }

  // 3. 标签盖住关键锚点（包括被折叠标签的锚点）
  for (const label of visible) {
    for (const anchor of anchors) {
      if (anchor.id === label.anchorId) continue;
      if (rectContainsPoint(inflateRect(label.rect!, gap * 0.5), { x: anchor.x, y: anchor.y })) {
        add(label.anchorId, {
          kind: 'anchor-covered',
          targetId: anchor.id,
          detail: `盖住锚点 ${anchor.id}（${anchor.text}）`,
        });
      }
    }
  }

  // 4. 超出地图边界或当前可视范围
  for (const label of visible) {
    const r = label.rect!;
    const outsideMap =
      r.x < mapBounds.x - 1e-9 ||
      r.y < mapBounds.y - 1e-9 ||
      r.x + r.width > mapBounds.x + mapBounds.width + 1e-9 ||
      r.y + r.height > mapBounds.y + mapBounds.height + 1e-9;
    if (outsideMap) {
      add(label.anchorId, { kind: 'out-of-bounds', targetId: 'map', detail: '标签超出地图范围' });
    } else if (!rectsIntersect(r, viewBounds)) {
      add(label.anchorId, {
        kind: 'out-of-bounds',
        targetId: 'view',
        detail: '标签位于当前可视范围之外，平移画面可重新排版',
      });
    }
  }

  // 5. 连线交叉、连线穿过禁放区
  const leaders = visible
    .map((l) => leaderLineFor(l)!)
    .filter((l): l is LeaderLine => l !== null);
  for (let i = 0; i < leaders.length; i++) {
    for (let j = i + 1; j < leaders.length; j++) {
      if (segmentsIntersect(leaders[i].from, leaders[i].to, leaders[j].from, leaders[j].to)) {
        add(leaders[i].anchorId, {
          kind: 'leader-cross',
          targetId: leaders[j].anchorId,
          detail: `连线与「${labels.find((l) => l.anchorId === leaders[j].anchorId)?.text ?? leaders[j].anchorId}」的连线交叉`,
        });
        add(leaders[j].anchorId, {
          kind: 'leader-cross',
          targetId: leaders[i].anchorId,
          detail: `连线与「${labels.find((l) => l.anchorId === leaders[i].anchorId)?.text ?? leaders[i].anchorId}」的连线交叉`,
        });
      }
    }
  }
  for (const leader of leaders) {
    for (const zone of forbidden) {
      // 端点（锚点）本身在禁放区内属于地图数据问题，不计连线违规
      if (rectContainsPoint(zone, leader.from)) continue;
      if (segmentIntersectsRect(leader.from, leader.to, zone)) {
        add(leader.anchorId, {
          kind: 'leader-cross',
          targetId: zone.id,
          detail: `连线穿过禁放区 ${zone.id}`,
        });
      }
    }
  }

  return result;
}
