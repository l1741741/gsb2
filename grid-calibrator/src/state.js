// Plain immutable calibration document operations and undo history.
import { defaultCrop } from './warp.js';

export const CONFIG_APP = 'grid-calibrator';
export const CONFIG_VERSION = 1;

let idSequence = 0;
export function createId(prefix = 'p') {
  idSequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSequence}`;
}

// Tests can reset the module-local sequence when they need stable ids.
export function resetIdSequence(value = 0) {
  idSequence = value;
}

export function checkpointKeys(columns, rows) {
  const c = Math.max(2, Math.floor(columns / 2));
  const r = Math.max(2, Math.floor(rows / 2));
  const keys = [
    [c, r],
    [0, r],
    [columns - 1, r],
    [c, 0],
    [c, rows - 1],
  ];

  // Add quarter points when the grid is large enough to keep edge checks
  // independent from the exact midpoint.
  if (columns >= 7 && rows >= 5) {
    keys.push(
      [Math.floor(columns / 4), Math.floor(rows / 4)],
      [columns - 1 - Math.floor(columns / 4), Math.floor(rows / 4)],
      [Math.floor(columns / 4), rows - 1 - Math.floor(rows / 4)],
    );
  }

  return new Set(keys.map(([col, row]) => `${col}:${row}`));
}

export function createRegularMarkers({
  columns,
  rows,
  imageWidth,
  imageHeight,
  marginFraction = 0.12,
  autoChecks = true,
}) {
  const checkpoints = autoChecks ? checkpointKeys(columns, rows) : new Set();
  const points = [];
  const marginX = imageWidth * marginFraction;
  const marginY = imageHeight * marginFraction;

  for (let row = 0; row < rows; row += 1) {
    const y = rows === 1
      ? imageHeight / 2
      : marginY + (row * (imageHeight - marginY * 2)) / (rows - 1);
    for (let col = 0; col < columns; col += 1) {
      const x = columns === 1
        ? imageWidth / 2
        : marginX + (col * (imageWidth - marginX * 2)) / (columns - 1);
      points.push({
        id: createId(),
        col,
        row,
        x,
        y,
        role: checkpoints.has(`${col}:${row}`) ? 'check' : 'fit',
      });
    }
  }
  return points;
}

export function createDocument(options = {}) {
  const columns = options.columns ?? 11;
  const rows = options.rows ?? 8;
  return {
    app: CONFIG_APP,
    configVersion: CONFIG_VERSION,
    image: options.image ?? null,
    grid: { columns, rows },
    points: options.points ?? [],
    selectedId: options.selectedId ?? null,
    output: {
      cellPx: options.cellPx ?? 72,
      crop: options.crop ?? defaultCrop(columns, rows),
      exportMode: options.exportMode ?? 'padded',
    },
    activeModel: options.activeModel ?? null,
    fitReport: options.fitReport ?? null,
  };
}

export function addPoint(doc, point) {
  const normalized = {
    id: point.id ?? createId(),
    col: Number(point.col ?? 0),
    row: Number(point.row ?? 0),
    x: Number(point.x ?? 0),
    y: Number(point.y ?? 0),
    role: point.role === 'check' ? 'check' : 'fit',
  };
  return {
    ...doc,
    points: [...doc.points, normalized],
    selectedId: normalized.id,
  };
}

export function movePoint(doc, id, x, y) {
  return {
    ...doc,
    points: doc.points.map((point) => (
      point.id === id
        ? { ...point, x: Number(x), y: Number(y) }
        : point
    )),
  };
}

export function updatePoint(doc, id, changes) {
  return {
    ...doc,
    points: doc.points.map((point) => (
      point.id === id ? { ...point, ...changes } : point
    )),
  };
}

export function removePoint(doc, id) {
  return {
    ...doc,
    points: doc.points.filter((point) => point.id !== id),
    selectedId: doc.selectedId === id ? null : doc.selectedId,
  };
}

export function selectPoint(doc, id) {
  return { ...doc, selectedId: id };
}

export function setGridDimensions(doc, columns, rows) {
  const nextColumns = Math.min(60, Math.max(2, Math.floor(columns)));
  const nextRows = Math.min(60, Math.max(2, Math.floor(rows)));
  return {
    ...doc,
    grid: { columns: nextColumns, rows: nextRows },
    output: {
      ...doc.output,
      crop: defaultCrop(nextColumns, nextRows),
    },
  };
}

export function setOutput(doc, changes) {
  return { ...doc, output: { ...doc.output, ...changes } };
}

export function setCrop(doc, changes) {
  return {
    ...doc,
    output: { ...doc.output, crop: { ...doc.output.crop, ...changes } },
  };
}

export function nextMissingGridLabel(doc) {
  const used = new Set(doc.points.map((p) => `${p.col}:${p.row}`));
  for (let row = 0; row < doc.grid.rows; row += 1) {
    for (let col = 0; col < doc.grid.columns; col += 1) {
      if (!used.has(`${col}:${row}`)) return { col, row };
    }
  }
  return { col: doc.grid.columns, row: doc.grid.rows };
}

export function classifyRegion(point, columns, rows) {
  const col = point.col;
  const row = point.row;
  const centerCol = (columns - 1) / 2;
  const centerRow = (rows - 1) / 2;
  const halfCol = Math.max(centerCol, 1);
  const halfRow = Math.max(centerRow, 1);
  const radial = Math.hypot((col - centerCol) / halfCol, (row - centerRow) / halfRow);
  const isEdge = col === 0 || row === 0 || col === columns - 1 || row === rows - 1;
  const isCenter = radial < 0.35;
  return isCenter ? 'center' : isEdge || radial > 0.72 ? 'edge' : 'middle';
}

export function annotateRegions(points, columns, rows) {
  return points.map((point) => ({
    ...point,
    region: classifyRegion(point, columns, rows),
  }));
}

export class UndoStack {
  constructor(initial) {
    this.current = initial;
    this.undoStack = [];
    this.redoStack = [];
  }

  commit(next) {
    if (next === this.current) return this.current;
    this.undoStack.push(this.current);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.current = next;
    this.redoStack = [];
    return this.current;
  }

  undo() {
    if (!this.undoStack.length) return this.current;
    this.redoStack.push(this.current);
    this.current = this.undoStack.pop();
    return this.current;
  }

  redo() {
    if (!this.redoStack.length) return this.current;
    this.undoStack.push(this.current);
    this.current = this.redoStack.pop();
    return this.current;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }
}

export function checkImageDimensions(image, calibrationImage) {
  if (!calibrationImage) {
    return {
      compatible: false,
      code: 'no_calibration',
      message: '尚未加载标定图，无法确认尺寸与校正坐标。',
    };
  }
  if (!image || image.width == null || image.height == null) {
    return { compatible: false, code: 'unknown_size', message: '无法读取图片尺寸。' };
  }
  if (image.width !== calibrationImage.width || image.height !== calibrationImage.height) {
    return {
      compatible: false,
      code: 'dimension_mismatch',
      message: `尺寸不匹配：图片为 ${image.width}×${image.height}，标定图为 ${calibrationImage.width}×${calibrationImage.height}。已阻止套用，请使用尺寸和裁切范围一致的图片。`,
    };
  }
  return {
    compatible: true,
    code: 'ok',
    message: `尺寸一致（${image.width}×${image.height}），将使用同一模型和裁切范围。`,
  };
}
