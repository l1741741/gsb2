/**
 * 设计文件的保存与恢复核对。
 * 恢复时以地图坐标为唯一事实来源重新排版，再与存档逐项比对，
 * 任何无法复现的位置/折叠差异都作为 restoreWarnings 返回，而不是静默吞掉。
 */
import { layoutLabels, type LayoutResult } from './layout.js';
import type { DesignDocument, PlacedLabel } from './model.js';
import type { TextMeasurer } from './text-measurer.js';
import type { LabelStyle } from './model.js';
import type { Rect } from './geometry.js';

export interface RestoreResult {
  layout: LayoutResult;
  warnings: string[];
}

const EPS = 1e-6;

function sameRect(a: PlacedLabel['rect'], b: PlacedLabel['rect']): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.x - b.x) < EPS &&
    Math.abs(a.y - b.y) < EPS &&
    Math.abs(a.width - b.width) < EPS &&
    Math.abs(a.height - b.height) < EPS
  );
}

export function restoreLayout(
  doc: DesignDocument,
  measurer: TextMeasurer,
  style: LabelStyle,
  /** 恢复时的目标画布规格；与存档不同会触发重算（地图坐标保持不变） */
  canvasWidth: number,
  canvasHeight: number,
  scale: number,
  viewBounds: Rect,
): RestoreResult {
  const layout = layoutLabels({
    canvasWidth,
    canvasHeight,
    scale,
    viewBounds,
    mapBounds: doc.input.map.bounds,
    forbidden: doc.input.forbidden ?? [],
    anchors: doc.input.anchors,
    style,
    measurer,
    manualOverrides: doc.manualOverrides,
    manualFolds: doc.manualFolds,
  });

  const warnings: string[] = [];
  const archived = new Map(doc.layout.labels.map((l) => [l.anchorId, l]));
  for (const label of layout.labels) {
    const old = archived.get(label.anchorId);
    if (!old) {
      warnings.push(`标签 ${label.anchorId} 在存档中不存在，按新输入排版`);
      continue;
    }
    if (old.folded !== label.folded) {
      warnings.push(
        `标签 ${label.anchorId} 折叠状态变化：存档 ${old.folded ? '折叠' : '显示'} → 当前 ${
          label.folded ? '折叠' : '显示'
        }`,
      );
    }
    if (!sameRect(old.rect, label.rect)) {
      warnings.push(`标签 ${label.anchorId} 的位置与存档不一致（已按当前画布重算）`);
    }
  }
  return { layout, warnings };
}

export function assertDesignDocument(raw: unknown): DesignDocument {
  if (!raw || typeof raw !== 'object') throw new TypeError('设计文件格式无效');
  const doc = raw as DesignDocument;
  if (doc.version !== 1) throw new TypeError(`不支持的设计文件版本: ${String(doc.version)}`);
  if (!doc.input || !Array.isArray(doc.input.anchors)) {
    throw new TypeError('设计文件缺少 input.anchors');
  }
  if (!doc.layout || !Array.isArray(doc.layout.labels)) {
    throw new TypeError('设计文件缺少 layout.labels');
  }
  if (!doc.camera || !Number.isFinite(doc.camera.scale)) {
    throw new TypeError('设计文件缺少 camera 快照');
  }
  return doc;
}
