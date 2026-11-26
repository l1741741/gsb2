// Canvas drawing for the four workspace views. All pointer math lives in
// viewport.js; this module only renders in known image/screen coordinates.
import { imageToScreen } from './viewport.js';

const ROLE_COLORS = {
  fit: '#2563eb',
  check: '#dc2626',
};

function drawImageTransform(ctx, image, naturalWidth, naturalHeight, view) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    image,
    view.x,
    view.y,
    naturalWidth * view.scale,
    naturalHeight * view.scale,
  );
}

function roundedLabel(ctx, text, x, y, color = '#0f172a') {
  ctx.save();
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  const width = ctx.measureText(text).width + 8;
  const height = 17;
  const left = x + 9;
  const top = y - height - 7;
  ctx.fillStyle = 'rgba(255,255,255,.88)';
  ctx.strokeStyle = 'rgba(15,23,42,.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 4, top + height / 2 + 0.5);
  ctx.restore();
}

function drawConnections(ctx, points, view) {
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);
  ctx.lineWidth = 1.2 / view.scale;

  const rows = new Map();
  const cols = new Map();
  for (const point of points) {
    if (!rows.has(point.row)) rows.set(point.row, []);
    if (!cols.has(point.col)) cols.set(point.col, []);
    rows.get(point.row).push(point);
    cols.get(point.col).push(point);
  }

  ctx.strokeStyle = 'rgba(37, 99, 235, .42)';
  for (const group of rows.values()) {
    group.sort((a, b) => a.col - b.col);
    if (group.length < 2) continue;
    ctx.beginPath();
    group.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(14, 165, 233, .35)';
  for (const group of cols.values()) {
    group.sort((a, b) => a.row - b.row);
    if (group.length < 2) continue;
    ctx.beginPath();
    group.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
  }
  ctx.restore();
}

function drawResidualVectors(ctx, fitReport, view) {
  if (!fitReport?.checkDetails?.length) return;
  ctx.save();
  ctx.strokeStyle = '#f97316';
  ctx.fillStyle = '#f97316';
  ctx.lineWidth = 2;
  for (const detail of fitReport.checkDetails) {
    const a = imageToScreen(detail.predicted, view);
    const b = imageToScreen(detail.observed, view);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawMarkers(ctx, points, view, selectedId, showLabels) {
  for (const point of points) {
    const screen = imageToScreen(point, view);
    const color = ROLE_COLORS[point.role] ?? ROLE_COLORS.fit;
    const selected = point.id === selectedId;
    const radius = selected ? 8 : 6;

    ctx.save();
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius + 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 1.5;
    ctx.strokeStyle = selected ? '#facc15' : 'rgba(15,23,42,.55)';
    ctx.stroke();
    ctx.restore();

    if (showLabels) {
      roundedLabel(ctx, `R${point.row + 1}C${point.col + 1}`, screen.x, screen.y, color);
    }
  }
}

export function drawCalibrationView(ctx, options) {
  const { image, width, height, view, doc, showLabels } = options;
  if (image) drawImageTransform(ctx, image, width, height, view);
  drawConnections(ctx, doc.points, view);
  drawResidualVectors(ctx, doc.fitReport, view);
  drawMarkers(ctx, doc.points, view, doc.selectedId, showLabels);
}

export function drawOriginalView(ctx, options) {
  const { target, view } = options;
  if (!target?.image) return false;
  drawImageTransform(ctx, target.image, target.width, target.height, view);
  return true;
}

export function drawCorrectedFrame(ctx, frameCanvas, view) {
  if (!frameCanvas) return false;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    frameCanvas,
    view.x,
    view.y,
    frameCanvas.width * view.scale,
    frameCanvas.height * view.scale,
  );
  return true;
}

export function drawAlignedGrid(ctx, options) {
  const { view, crop, cellPx, columns, rows } = options;
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);
  ctx.lineWidth = 1.5 / view.scale;
  ctx.strokeStyle = 'rgba(16, 185, 129, .82)';
  ctx.fillStyle = 'rgba(6, 95, 70, .95)';
  ctx.font = `${12 / view.scale}px ui-monospace, SFMono-Regular, Menlo, monospace`;

  for (let col = 0; col < columns; col += 1) {
    const x = (col - crop.col0) * cellPx;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, (crop.row1 - crop.row0) * cellPx);
    ctx.stroke();
  }
  for (let row = 0; row < rows; row += 1) {
    const y = (row - crop.row0) * cellPx;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo((crop.col1 - crop.col0) * cellPx, y);
    ctx.stroke();
  }

  // Labels are drawn in transformed coordinates; font is divided so their
  // screen size stays constant while zooming.
  for (let col = 0; col < columns; col += 2) {
    const x = (col - crop.col0) * cellPx + 4 / view.scale;
    const y = 14 / view.scale;
    ctx.fillText(`C${col + 1}`, x, y);
  }
  for (let row = 0; row < rows; row += 1) {
    const x = 4 / view.scale;
    const y = (row - crop.row0) * cellPx + 14 / view.scale;
    ctx.fillText(`R${row + 1}`, x, y);
  }
  ctx.restore();
}

export function drawValidRectangle(ctx, rect, view) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  const x = rect.x * view.scale + view.x;
  const y = rect.y * view.scale + view.y;
  const width = rect.width * view.scale;
  const height = rect.height * view.scale;
  ctx.save();
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 5]);
  ctx.strokeRect(x, y, width, height);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(22,101,52,.92)';
  ctx.font = '12px sans-serif';
  ctx.fillText('最大有效矩形', x + 8, y + 20);
  ctx.restore();
}
