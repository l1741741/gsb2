// 照度模型与多灯叠加。
//
// 照度单位为相对值：单灯在距离 d 处的照度为
//   power / (1 + (d/halfRange)^2)
// 即 d = halfRange 时照度减半，halfRange 固定取 range 的一半，
// range 处约为满功率的 16.7%，再往外按 0 处理（与可见多边形边界一致）。
// 多盏灯按场景中固定的灯具数组顺序逐盏累加，结果与绘制顺序无关，
// 因此拖动一盏灯时静止灯的照明不会闪动。

import { distance } from './geometry.js';
import { buildVisibilityPolygon, pointInCone, pointInVisibility } from './visibility.js';

export function lightIlluminance(light, point, polygon) {
  if (light.enabled === false) return 0;
  const d = distance(light, point);
  if (d > light.range) return 0;
  if (!pointInCone(light, point)) return 0;
  if (!pointInVisibility(point, polygon)) return 0;
  const halfRange = light.range / 2;
  return light.power / (1 + (d / halfRange) ** 2);
}

// 预计算所有启用灯具的可见多边形，按灯 id 索引。
export function buildLightPolygons(scene, segments) {
  const polygons = new Map();
  for (const light of scene.lights) {
    if (light.enabled === false) continue;
    polygons.set(light.id, buildSafePolygon(light, segments));
  }
  return polygons;
}

// 灯心落在遮挡体内部等退化情形下兜底为零面积区域，避免抛出异常打断预览。
function buildSafePolygon(light, segments) {
  try {
    const polygon = buildVisibilityPolygon(light, segments);
    return polygon.length >= 3 ? polygon : [];
  } catch {
    return [];
  }
}

// 探针：返回某点由哪些灯照亮及各自贡献。结果按灯具数组顺序排列。
export function probePoint(scene, segments, point, polygons = buildLightPolygons(scene, segments)) {
  const contributions = [];
  let total = 0;
  for (const light of scene.lights) {
    const polygon = polygons.get(light.id);
    const illuminance = polygon ? lightIlluminance(light, point, polygon) : 0;
    if (illuminance > 0) {
      contributions.push({ lightId: light.id, name: light.name, illuminance });
      total += illuminance;
    }
  }
  return {
    point: { x: point.x, y: point.y },
    total,
    contributions,
    belowThreshold: total < scene.settings.threshold,
  };
}

export function totalIlluminance(scene, segments, point, polygons) {
  return probePoint(scene, segments, point, polygons).total;
}

// 门限暗区网格：在世界坐标中按 cellSize 采样，
// 仅记录总照度低于门限的单元，供渲染层叠加半透明暗区。
// 网格与相机无关，缩放/平移不会改变判定结果。
export function buildDimGrid(scene, segments, polygons = buildLightPolygons(scene, segments)) {
  const { width, height } = scene.bounds;
  const cell = scene.settings.cellSize;
  const cells = [];
  for (let y = cell / 2; y < height; y += cell) {
    for (let x = cell / 2; x < width; x += cell) {
      const total = totalIlluminance(scene, segments, { x, y }, polygons);
      if (total < scene.settings.threshold) {
        cells.push({ x: x - cell / 2, y: y - cell / 2, size: cell });
      }
    }
  }
  return { cellSize: cell, width, height, cells, threshold: scene.settings.threshold };
}

// 用于缓存失效的签名：任何影响照度的参数变化都会改变签名。
export function lightSignature(scene) {
  return JSON.stringify({
    segments: scene.walls.map((w) => [w.a, w.b])
      .concat(scene.partitions.flatMap((p) => [p.a, p.b, p.openings ?? []]))
      .concat(scene.columns.map((c) => [c.center, c.radius])),
    lights: scene.lights.map((l) => [l.x, l.y, l.aim, l.fov, l.range, l.power, l.enabled]),
    bounds: scene.bounds,
    cellSize: scene.settings.cellSize,
    threshold: scene.settings.threshold,
  });
}
