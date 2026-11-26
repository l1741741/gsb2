// Deterministic JSON configuration serialization and validation.
import { CONFIG_APP, CONFIG_VERSION, createDocument } from './state.js';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function serializeConfig(doc) {
  // JSON round-trip removes runtime-only fields and makes saved/loaded state
  // structurally identical. activeModel is intentionally included so a last
  // usable fit survives an invalid editing state.
  return JSON.parse(JSON.stringify({
    app: CONFIG_APP,
    configVersion: CONFIG_VERSION,
    image: doc.image,
    grid: doc.grid,
    points: doc.points,
    selectedId: doc.selectedId,
    output: doc.output,
    activeModel: doc.activeModel,
    fitReport: doc.fitReport,
  }));
}

export function configToJson(doc) {
  return JSON.stringify(serializeConfig(doc), null, 2);
}

export function parseConfig(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  if (!parsed || parsed.app !== CONFIG_APP) {
    throw new Error('不是本工具保存的标定配置文件');
  }
  if (parsed.configVersion !== 1) {
    throw new Error(`不支持的配置版本：${parsed.configVersion}`);
  }
  if (!parsed.grid || !Number.isInteger(parsed.grid.columns) || !Number.isInteger(parsed.grid.rows)) {
    throw new Error('配置缺少有效的 grid.columns/grid.rows');
  }
  if (!Array.isArray(parsed.points)) {
    throw new Error('配置缺少 points 数组');
  }

  for (const point of parsed.points) {
    if (!point.id || !Number.isInteger(point.col) || !Number.isInteger(point.row)) {
      throw new Error('存在缺少 id/row/col 的标记点');
    }
    if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
      throw new Error(`标记点 ${point.id} 坐标无效`);
    }
  }

  const crop = parsed.output?.crop;
  if (!crop || !isFiniteNumber(parsed.output.cellPx) || parsed.output.cellPx <= 0) {
    throw new Error('配置缺少有效的 output.crop/cellPx');
  }
  for (const key of ['col0', 'row0', 'col1', 'row1']) {
    if (!isFiniteNumber(crop[key])) throw new Error(`配置的 crop.${key} 必须是有限数字`);
  }
  if (crop.col1 <= crop.col0 || crop.row1 <= crop.row0) {
    throw new Error('配置的裁切范围无效：右/下边界必须大于左/上边界');
  }
  if (parsed.activeModel != null) {
    const model = parsed.activeModel;
    if (!Array.isArray(model.coeffX) || !Array.isArray(model.coeffY) || !model.norm) {
      throw new Error('配置中的 activeModel 结构无效');
    }
  }

  const doc = createDocument({
    image: parsed.image ?? null,
    columns: parsed.grid.columns,
    rows: parsed.grid.rows,
    points: parsed.points,
    selectedId: parsed.selectedId ?? null,
    cellPx: parsed.output.cellPx,
    crop,
    exportMode: parsed.output.exportMode === 'valid' ? 'valid' : 'padded',
    activeModel: parsed.activeModel ?? null,
    fitReport: parsed.fitReport ?? null,
  });
  return doc;
}
