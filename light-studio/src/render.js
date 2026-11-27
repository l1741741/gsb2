// Canvas 2D 绘制层。只负责把世界坐标中的场景、照度结果画到画布上，
// 所有几何/照度计算都在其它模块完成；本模块不产生任何照明判定。

import { Camera } from './camera.js';
import { isOmni } from './scene.js';

const TAU = Math.PI * 2;

export function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function strokePath(context, points, close = false) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y);
  if (close) context.closePath();
}

export function drawBackground(context, scene) {
  context.fillStyle = '#0e1620';
  context.fillRect(-2000, -2000, scene.bounds.width + 4000, scene.bounds.height + 4000);
  context.fillStyle = '#16212e';
  context.fillRect(0, 0, scene.bounds.width, scene.bounds.height);
  // 世界坐标网格：随相机缩放，间距固定为 50 世界单位。
  context.strokeStyle = 'rgba(120, 150, 175, 0.10)';
  context.lineWidth = 1 / context.getTransform().a;
  const grid = 50;
  context.beginPath();
  for (let x = 0; x <= scene.bounds.width; x += grid) {
    context.moveTo(x, 0);
    context.lineTo(x, scene.bounds.height);
  }
  for (let y = 0; y <= scene.bounds.height; y += grid) {
    context.moveTo(0, y);
    context.lineTo(scene.bounds.width, y);
  }
  context.stroke();
}

export function drawBounds(context, scene) {
  context.strokeStyle = 'rgba(180, 205, 225, 0.45)';
  context.lineWidth = 2 / context.getTransform().a;
  context.strokeRect(0, 0, scene.bounds.width, scene.bounds.height);
}

export function drawObstacles(context, scene) {
  const lineWidth = 5 / context.getTransform().a;
  context.lineCap = 'square';
  for (const wall of scene.walls) {
    context.strokeStyle = '#9fb3c4';
    context.lineWidth = lineWidth;
    context.beginPath();
    context.moveTo(wall.a.x, wall.a.y);
    context.lineTo(wall.b.x, wall.b.y);
    context.stroke();
  }
  for (const partition of scene.partitions) {
    context.strokeStyle = '#7fa6bd';
    context.lineWidth = lineWidth;
    context.beginPath();
    context.moveTo(partition.a.x, partition.a.y);
    context.lineTo(partition.b.x, partition.b.y);
    context.stroke();
    // 门缝用青色短标记。
    context.strokeStyle = '#46d3c1';
    context.lineWidth = lineWidth * 1.6;
    for (const gap of partition.openings ?? []) {
      const horizontal = Math.abs(partition.b.x - partition.a.x)
        >= Math.abs(partition.b.y - partition.a.y);
      context.beginPath();
      if (horizontal) {
        context.moveTo(gap.start, partition.a.y);
        context.lineTo(gap.end, partition.a.y);
      } else {
        context.moveTo(partition.a.x, gap.start);
        context.lineTo(partition.a.x, gap.end);
      }
      context.stroke();
    }
  }
  for (const column of scene.columns) {
    context.fillStyle = '#8ea4b6';
    context.strokeStyle = '#c3d2de';
    context.lineWidth = 2 / context.getTransform().a;
    context.beginPath();
    context.arc(column.center.x, column.center.y, column.radius, 0, TAU);
    context.fill();
    context.stroke();
  }
}

// 逐盏灯以加法混合绘制可见多边形，灯数组顺序固定，不依赖遍历/绘制顺序。
export function drawLighting(context, scene, polygons, options = {}) {
  context.save();
  context.globalCompositeOperation = 'lighter';
  context.globalAlpha = options.lightingOpacity ?? 0.9;
  for (const light of scene.lights) {
    if (light.enabled === false) continue;
    const polygon = polygons.get(light.id);
    if (!polygon || polygon.length < 3) continue;
    const { r, g, b } = hexToRgb(light.color);
    const halfRange = light.range / 2;
    const origin = { x: light.x, y: light.y };
    // 按顶点距离做近亮远暗的径向渐变。
    let maxD = 1;
    for (const point of polygon) maxD = Math.max(maxD, Math.hypot(point.x - origin.x, point.y - origin.y));
    const gradient = context.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, maxD);
    gradient.addColorStop(0, `rgba(${r},${g},${b},${0.55 * light.power})`);
    gradient.addColorStop(Math.min(1, halfRange / maxD), `rgba(${r},${g},${b},${0.22 * light.power})`);
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
    context.fillStyle = gradient;
    strokePath(context, polygon, true);
    context.fill();
  }
  context.restore();
}

// 低于照度门限的暗区网格叠加。
export function drawDimGrid(context, dimGrid) {
  context.save();
  context.fillStyle = 'rgba(120, 40, 90, 0.32)';
  for (const cell of dimGrid.cells) {
    context.fillRect(cell.x, cell.y, cell.size, cell.size);
  }
  context.restore();
}

export function drawLightFixtures(context, scene, selectedId, draggingId) {
  const thin = 1.5 / context.getTransform().a;
  for (const light of scene.lights) {
    const disabled = light.enabled === false;
    context.save();
    context.translate(light.x, light.y);
    // 锥角域参考线（全向灯画射程圆）。
    context.strokeStyle = disabled ? 'rgba(150,160,170,0.25)' : 'rgba(255, 226, 160, 0.35)';
    context.lineWidth = thin;
    context.setLineDash([6 / context.getTransform().a, 6 / context.getTransform().a]);
    context.beginPath();
    if (isOmni(light)) {
      context.arc(0, 0, light.range, 0, TAU);
    } else {
      context.moveTo(0, 0);
      context.arc(0, 0, light.range, light.aim - light.fov, light.aim + light.fov);
      context.closePath();
    }
    context.stroke();
    context.setLineDash([]);
    // 朝向指示。
    if (!isOmni(light)) {
      context.strokeStyle = disabled ? 'rgba(150,160,170,0.4)' : '#ffd98a';
      context.lineWidth = 2 / context.getTransform().a;
      context.beginPath();
      context.moveTo(0, 0);
      context.lineTo(Math.cos(light.aim) * 16, Math.sin(light.aim) * 16);
      context.stroke();
    }
    // 灯体。
    const radius = 8 / context.getTransform().a;
    context.beginPath();
    context.arc(0, 0, radius, 0, TAU);
    context.fillStyle = disabled ? '#5a6570' : light.color;
    context.fill();
    context.strokeStyle = light.id === selectedId || light.id === draggingId ? '#ffffff' : 'rgba(20,28,38,0.9)';
    context.lineWidth = (light.id === selectedId ? 3 : 1.5) / context.getTransform().a;
    context.stroke();
    context.restore();
  }
}

export function drawCheckpoints(context, scene, probeResults) {
  const thin = 1.5 / context.getTransform().a;
  for (const checkpoint of scene.checkpoints) {
    const result = probeResults?.get(checkpoint.id);
    const color = checkpoint.expect === 'dark' ? '#ff7d7d'
      : checkpoint.expect === 'partial' ? '#ffd166' : '#7ee08a';
    context.save();
    context.translate(checkpoint.x, checkpoint.y);
    context.strokeStyle = color;
    context.lineWidth = thin;
    const r = 9 / context.getTransform().a;
    context.strokeRect(-r, -r, r * 2, r * 2);
    context.beginPath();
    context.moveTo(-r - 4 / context.getTransform().a, 0);
    context.lineTo(r + 4 / context.getTransform().a, 0);
    context.moveTo(0, -r - 4 / context.getTransform().a);
    context.lineTo(0, r + 4 / context.getTransform().a);
    context.stroke();
    if (result) {
      context.fillStyle = result.pass ? 'rgba(126, 224, 138, 0.25)' : 'rgba(255, 125, 125, 0.25)';
      context.beginPath();
      context.arc(0, 0, r * 1.7, 0, TAU);
      context.fill();
    }
    context.restore();
  }
}

export function drawProbe(context, probe, worldPoint) {
  if (!probe) return;
  const thin = 1.5 / context.getTransform().a;
  context.save();
  context.strokeStyle = '#67e8f9';
  context.lineWidth = thin;
  const r = 7 / context.getTransform().a;
  context.beginPath();
  context.arc(worldPoint.x, worldPoint.y, r, 0, TAU);
  context.stroke();
  context.restore();
}

// 统一渲染入口：按固定层级绘制，照明层始终在障碍层之下、暗区层之上。
export function renderFrame(canvas, context, camera, scene, view) {
  const dpr = window.devicePixelRatio || 1;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(camera.x, camera.y);
  context.scale(camera.scale, camera.scale);
  drawBackground(context, scene);
  drawLighting(context, scene, view.polygons);
  if (view.showDimGrid) drawDimGrid(context, view.dimGrid);
  drawObstacles(context, scene);
  drawCheckpoints(context, scene, view.checkpointResults);
  drawLightFixtures(context, scene, view.selectedId, view.draggingId);
  if (view.probe) drawProbe(context, view.probe, view.probeWorld);
  drawBounds(context, scene);
  context.restore();
}

export { Camera };
