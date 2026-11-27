// 模板（全批设定）与单页覆盖。
// 两者使用彼此独立的 storage key，可分别保存、导出、导入，互不覆盖。

export const TEMPLATE_STORAGE_KEY = 'page-corrector:template:v1';
export const OVERRIDES_STORAGE_KEY = 'page-corrector:overrides:v1';
export const ADOPTED_STORAGE_KEY = 'page-corrector:adopted:v1';

export const CONFIG_VERSION = 1;

/** 初始四角：相对画面内缩 10% 的矩形（归一化坐标，与具体分辨率无关）。 */
export function defaultCornersNormalized() {
  return [
    { x: 0.12, y: 0.1 },
    { x: 0.88, y: 0.1 },
    { x: 0.88, y: 0.9 },
    { x: 0.12, y: 0.9 },
  ];
}

export function createDefaultTemplate() {
  return {
    configVersion: CONFIG_VERSION,
    name: '全批模板',
    cornersNormalized: defaultCornersNormalized(),
    ratio: { id: 'a4', w: 210, h: 297 },
    outputWidth: 1654,
    maskColor: '#ffffff',
    // 区域一律存纸面归一化坐标：{id,type:'keep'|'mask',shape:'rect',x,y,w,h,label?}
    regions: [],
  };
}

function isPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0));
}

export function normalizeRegion(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type === 'keep' ? 'keep' : 'mask';
  const x = clamp01(raw.x);
  const y = clamp01(raw.y);
  const w = Math.min(1 - x, Math.max(0, Number(raw.w) || 0));
  const h = Math.min(1 - y, Math.max(0, Number(raw.h) || 0));
  if (w <= 0 || h <= 0) return null;
  return {
    id: String(raw.id || `region-${index + 1}`),
    type,
    shape: 'rect',
    x,
    y,
    w,
    h,
    label: typeof raw.label === 'string' ? raw.label : '',
    enabled: raw.enabled !== false,
  };
}

/** 把任意读入的 JSON 修整为合法配置；缺字段用默认值补齐。 */
export function normalizeConfig(raw) {
  const base = createDefaultTemplate();
  if (!raw || typeof raw !== 'object') return base;

  let corners = base.cornersNormalized;
  if (Array.isArray(raw.cornersNormalized) && raw.cornersNormalized.length === 4
      && raw.cornersNormalized.every(isPoint)) {
    corners = raw.cornersNormalized.map((p) => ({
      x: Math.min(1.5, Math.max(-0.5, Number(p.x))),
      y: Math.min(1.5, Math.max(-0.5, Number(p.y))),
    }));
  }

  let ratio = base.ratio;
  if (raw.ratio && Number.isFinite(Number(raw.ratio.w)) && Number.isFinite(Number(raw.ratio.h))
      && Number(raw.ratio.w) > 0 && Number(raw.ratio.h) > 0) {
    ratio = {
      id: typeof raw.ratio.id === 'string' ? raw.ratio.id : 'custom',
      w: Number(raw.ratio.w),
      h: Number(raw.ratio.h),
    };
  }

  const outputWidth = Number(raw.outputWidth);
  return {
    configVersion: CONFIG_VERSION,
    name: typeof raw.name === 'string' ? raw.name : base.name,
    cornersNormalized: corners,
    ratio,
    outputWidth: Number.isFinite(outputWidth) && outputWidth >= 64
      ? Math.min(8000, Math.round(outputWidth))
      : base.outputWidth,
    maskColor: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw.maskColor || '')
      ? raw.maskColor
      : '#ffffff',
    regions: Array.isArray(raw.regions)
      ? raw.regions.map((r, i) => normalizeRegion(r, i)).filter(Boolean)
      : [],
  };
}

// --- 底层 storage 读写（可注入内存 storage，便于测试） ----------------------

export function loadJSON(storage, key, fallback) {
  try {
    const text = storage?.getItem?.(key);
    if (!text) return fallback;
    return JSON.parse(text);
  } catch (err) {
    console.warn?.('读取本地设定失败', key, err);
    return fallback;
  }
}

export function saveJSON(storage, key, value) {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn?.('保存本地设定失败', key, err);
    return false;
  }
}

export function loadTemplate(storage) {
  return normalizeConfig(loadJSON(storage, TEMPLATE_STORAGE_KEY, null));
}

export function saveTemplate(storage, template) {
  return saveJSON(storage, TEMPLATE_STORAGE_KEY, normalizeConfig(template));
}

export function loadOverrides(storage) {
  const raw = loadJSON(storage, OVERRIDES_STORAGE_KEY, {});
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [pageKey, cfg] of Object.entries(raw)) {
      out[pageKey] = normalizeConfig(cfg);
    }
  }
  return out;
}

export function saveAllOverrides(storage, overrides) {
  return saveJSON(storage, OVERRIDES_STORAGE_KEY, overrides);
}

export function saveOverride(storage, overrides, pageKey, config) {
  const next = { ...overrides, [pageKey]: normalizeConfig(config) };
  saveAllOverrides(storage, next);
  return next;
}

export function clearOverride(storage, overrides, pageKey) {
  const next = { ...overrides };
  delete next[pageKey];
  saveAllOverrides(storage, next);
  return next;
}

/** 真实文件的稳定标识：同名同大小同修改时间视为同一页。 */
export function pageKeyOf(meta) {
  if (meta?.key) return String(meta.key);
  return `${meta?.name ?? 'unnamed'}#${meta?.size ?? 0}#${meta?.lastModified ?? 0}`;
}

/**
 * 解析某一页最终采用的配置。
 * 覆盖与全批模板独立存储，合并只发生在这里：有覆盖用覆盖，否则用模板。
 */
export function resolveConfig(template, overrides, pageKey) {
  const override = Object.prototype.hasOwnProperty.call(overrides, pageKey)
    ? overrides[pageKey]
    : null;
  return {
    config: override ? normalizeConfig(override) : normalizeConfig(template),
    source: override ? 'override' : 'template',
    override,
  };
}

/**
 * 配置签名：用于判断已导出/缓存的结果是否仍然新鲜。
 * 角点归一化坐标保留 6 位小数，避免无意义的缓存失效。
 */
export function configSignature(config) {
  const c = normalizeConfig(config);
  const roundedCorners = c.cornersNormalized.map((p) => ({
    x: Math.round(p.x * 1e6) / 1e6,
    y: Math.round(p.y * 1e6) / 1e6,
  }));
  const roundedRegions = c.regions.map((r) => ({
    id: r.id, type: r.type, x: r.x, y: r.y, w: r.w, h: r.h, enabled: r.enabled,
  }));
  return JSON.stringify({
    v: c.configVersion,
    c: roundedCorners,
    r: [c.ratio.id, c.ratio.w, c.ratio.h],
    o: c.outputWidth,
    m: c.maskColor,
    g: roundedRegions,
  });
}
