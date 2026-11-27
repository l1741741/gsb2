/**
 * 导出与存档。
 * - buildExportManifest：生成可核对的框、线、锚点坐标清单（地图坐标 + 屏幕像素双份）。
 * - exportPng：浏览器里把当前画布转 PNG；离屏渲染用 renderToPng。
 */
import type { Camera } from '../core/camera.js';
import { leaderLineFor } from '../core/conflicts.js';
import type {
  DesignDocument,
  FloorplanInput,
  PlacedLabel,
} from '../core/model.js';
import type { Rect } from '../core/geometry.js';
import { MapCanvasRenderer } from './canvas-renderer.js';
import type { TextMeasurer } from '../core/text-measurer.js';

export interface ExportManifest {
  version: 1;
  generatedAt: string;
  canvas: { width: number; height: number };
  camera: DesignDocument['camera'];
  coordinateSystem: {
    map: { bounds: Rect };
    note: string;
  };
  anchors: Array<{
    id: string;
    map: { x: number; y: number };
    screen: { x: number; y: number };
    priority: number;
    folded: boolean;
  }>;
  labelBoxes: Array<{
    anchorId: string;
    text: string;
    map: Rect | null;
    screen: Rect | null;
    pinned: boolean;
    folded: boolean;
    foldReason: PlacedLabel['foldReason'] | null;
    conflicts: PlacedLabel['conflicts'];
  }>;
  leaderLines: Array<{
    anchorId: string;
    map: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
    screen: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
  }>;
  forbidden: FloorplanInput['forbidden'];
  summary: {
    total: number;
    visible: number;
    folded: number;
    conflicts: number;
  };
}

function mapRectToScreen(r: Rect, camera: Camera): Rect {
  const tl = camera.toScreen({ x: r.x, y: r.y });
  const br = camera.toScreen({ x: r.x + r.width, y: r.y + r.height });
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
}

export function buildExportManifest(
  input: FloorplanInput,
  labels: PlacedLabel[],
  camera: Camera,
  generatedAt: string,
): ExportManifest {
  const conflictTotal = labels.reduce((sum, l) => sum + l.conflicts.length, 0);
  return {
    version: 1,
    generatedAt,
    canvas: { width: camera.viewportWidth, height: camera.viewportHeight },
    camera: camera.snapshot(),
    coordinateSystem: {
      map: { bounds: input.map.bounds },
      note: 'map 为平面图原始坐标；screen 为当前画布像素坐标，随相机缩放/旋转变化',
    },
    anchors: labels.map((l) => ({
      id: l.anchorId,
      map: { ...l.anchor },
      screen: camera.toScreen(l.anchor),
      priority: l.priority,
      folded: l.folded,
    })),
    labelBoxes: labels.map((l) => ({
      anchorId: l.anchorId,
      text: l.text,
      map: l.rect ? { ...l.rect } : null,
      screen: l.rect ? mapRectToScreen(l.rect, camera) : null,
      pinned: l.pinned,
      folded: l.folded,
      foldReason: l.foldReason ? { ...l.foldReason } : null,
      conflicts: l.conflicts.map((c) => ({ ...c })),
    })),
    leaderLines: labels.map((l) => {
      const leader = leaderLineFor(l);
      if (!leader) return { anchorId: l.anchorId, map: null, screen: null };
      return {
        anchorId: l.anchorId,
        map: { from: { ...leader.from }, to: { ...leader.to } },
        screen: {
          from: camera.toScreen(leader.from),
          to: camera.toScreen(leader.to),
        },
      };
    }),
    forbidden: input.forbidden?.map((z) => ({ ...z })) ?? [],
    summary: {
      total: labels.length,
      visible: labels.filter((l) => !l.folded).length,
      folded: labels.filter((l) => l.folded).length,
      conflicts: conflictTotal,
    },
  };
}

/** 浏览器内：按当前排版离屏渲染一张 PNG，返回 dataURL。 */
export function renderToPng(
  input: FloorplanInput,
  labels: PlacedLabel[],
  camera: Camera,
  measurer: TextMeasurer,
  style: import('../core/model.js').LabelStyle,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = camera.viewportWidth;
  canvas.height = camera.viewportHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');
  new MapCanvasRenderer().draw(ctx, {
    camera,
    mapBounds: input.map.bounds,
    forbidden: input.forbidden ?? [],
    labels,
    measurer,
    style,
  });
  return canvas.toDataURL('image/png');
}

export function buildDesignDocument(
  input: FloorplanInput,
  labels: PlacedLabel[],
  camera: Camera,
  savedAt: string,
  manualFolds: DesignDocument['manualFolds'] = {},
): DesignDocument {
  const manualOverrides: DesignDocument['manualOverrides'] = {};
  for (const label of labels) {
    if (label.manualRect) {
      manualOverrides[label.anchorId] = { x: label.manualRect.x, y: label.manualRect.y };
    }
  }
  const layout = {
    labels: labels.map((l) => ({
      anchorId: l.anchorId,
      rect: l.rect ? { ...l.rect } : null,
      folded: l.folded,
      foldReason: l.foldReason ? { ...l.foldReason } : null,
      conflicts: l.conflicts.map((c) => ({ ...c })),
    })),
  };
  return {
    version: 1,
    input,
    manualOverrides,
    manualFolds,
    camera: camera.snapshot(),
    canvas: { width: camera.viewportWidth, height: camera.viewportHeight },
    layout,
    savedAt,
  };
}
