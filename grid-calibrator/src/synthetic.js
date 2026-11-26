// Browser Canvas drawing for the built-in bent calibration grid and check chart.
import {
  DEFAULT_WARP,
  idealGridPoint,
  warpChartPoint,
  warpedGridPoint,
} from './distortion.js';
import { checkpointKeys } from './state.js';

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');
  return { canvas, ctx };
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('生成的示例图片加载失败'));
    image.src = dataUrl;
  });
}

function warpedLine(ctx, warp, from, to, segments = 72) {
  ctx.beginPath();
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const p = warpChartPoint(x, y, warp);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawCross(ctx, x, y, radius, color, lineWidth = 1.5) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(x - radius, y);
  ctx.lineTo(x + radius, y);
  ctx.moveTo(x, y - radius);
  ctx.lineTo(x, y + radius);
  ctx.stroke();
  ctx.restore();
}

function cellBoundary(warp, col, row, steps = 10) {
  const p00 = idealGridPoint(warp, col, row);
  const p10 = idealGridPoint(warp, col + 1, row);
  const p11 = idealGridPoint(warp, col + 1, row + 1);
  const p01 = idealGridPoint(warp, col, row + 1);
  const points = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push(warpChartPoint(p00.x + (p10.x - p00.x) * t, p00.y + (p10.y - p00.y) * t, warp));
  }
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    points.push(warpChartPoint(p10.x + (p11.x - p10.x) * t, p10.y + (p11.y - p10.y) * t, warp));
  }
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    points.push(warpChartPoint(p11.x + (p01.x - p11.x) * t, p11.y + (p01.y - p11.y) * t, warp));
  }
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    points.push(warpChartPoint(p01.x + (p00.x - p01.x) * t, p01.y + (p00.y - p01.y) * t, warp));
  }
  return points;
}

function fillWarpedCell(ctx, warp, col, row, fillStyle) {
  const points = cellBoundary(warp, col, row);
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.fill();
}

export function drawCalibrationGrid(ctx, warp = DEFAULT_WARP) {
  const { width, height, columns, rows } = warp;
  ctx.fillStyle = '#fbfcff';
  ctx.fillRect(0, 0, width, height);

  // Subtle paper border.
  ctx.strokeStyle = '#d7dee9';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, width - 20, height - 20);

  ctx.lineCap = 'round';

  // Grid lines.
  for (let col = 0; col < columns; col += 1) {
    const from = idealGridPoint(warp, col, 0);
    const to = idealGridPoint(warp, col, rows - 1);
    const major = col === 0 || col === columns - 1 || col === Math.floor(columns / 2);
    ctx.strokeStyle = major ? 'rgba(37, 99, 235, 0.72)' : 'rgba(71, 85, 105, 0.42)';
    ctx.lineWidth = major ? 2 : 1;
    warpedLine(ctx, warp, from, to);
  }
  for (let row = 0; row < rows; row += 1) {
    const from = idealGridPoint(warp, 0, row);
    const to = idealGridPoint(warp, columns - 1, row);
    const major = row === 0 || row === rows - 1 || row === Math.floor(rows / 2);
    ctx.strokeStyle = major ? 'rgba(37, 99, 235, 0.72)' : 'rgba(71, 85, 105, 0.42)';
    ctx.lineWidth = major ? 2 : 1;
    warpedLine(ctx, warp, from, to);
  }

  // Intersection targets.
  const checks = checkpointKeys(columns, rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const p = warpedGridPoint(warp, col, row);
      const isCheck = checks.has(`${col}:${row}`);
      ctx.fillStyle = isCheck ? '#dc2626' : '#111827';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isCheck ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
      drawCross(ctx, p.x, p.y, isCheck ? 10 : 7, isCheck ? 'rgba(220,38,38,.55)' : 'rgba(17,24,39,.45)', 1);
    }
  }

  ctx.fillStyle = '#334155';
  ctx.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('DIGITAL BENT CALIBRATION GRID', 28, 38);
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#64748b';
  ctx.fillText(`${columns}×${rows} intersections · red = held-out checkpoints`, 28, 60);
}

export function drawCheckChart(ctx, warp = DEFAULT_WARP) {
  const { width, height, columns, rows } = warp;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < columns - 1; col += 1) {
      if ((row + col) % 2 === 0) {
        fillWarpedCell(ctx, warp, col, row, '#111827');
      }
    }
  }

  // Thin grid ruler lines over the checkerboard.
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.9)';
  ctx.lineWidth = 1.5;
  for (let col = 0; col < columns; col += 1) {
    warpedLine(ctx, warp, idealGridPoint(warp, col, 0), idealGridPoint(warp, col, rows - 1));
  }
  for (let row = 0; row < rows; row += 1) {
    warpedLine(ctx, warp, idealGridPoint(warp, 0, row), idealGridPoint(warp, columns - 1, row));
  }

  // Measurement landmarks.
  const center = warpedGridPoint(warp, (columns - 1) / 2, (rows - 1) / 2);
  drawCross(ctx, center.x, center.y, 18, '#ef4444', 3);
  ctx.save();
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 3;
  for (const [col, row] of [[0, 0], [columns - 1, 0], [0, rows - 1], [columns - 1, rows - 1]]) {
    const p = warpedGridPoint(warp, col, row);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Readable header outside the main checker field.
  ctx.fillStyle = 'rgba(255,255,255,.86)';
  ctx.fillRect(20, 18, 330, 42);
  ctx.fillStyle = '#111827';
  ctx.font = 'bold 18px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('BENT CHECK CHART', 32, 45);
}

export async function generateCalibrationSample(warp = DEFAULT_WARP) {
  const { canvas, ctx } = makeCanvas(warp.width, warp.height);
  drawCalibrationGrid(ctx, warp);
  const dataUrl = canvas.toDataURL('image/png');
  const image = await loadImage(dataUrl);
  return { canvas, ctx, dataUrl, image, width: warp.width, height: warp.height, warp };
}

export async function generateCheckSample(warp = DEFAULT_WARP) {
  const { canvas, ctx } = makeCanvas(warp.width, warp.height);
  drawCheckChart(ctx, warp);
  const dataUrl = canvas.toDataURL('image/png');
  const image = await loadImage(dataUrl);
  return { canvas, ctx, dataUrl, image, width: warp.width, height: warp.height, warp };
}
