// 平面图与灯具的数据模型、校验、序列化。
// 全部为本地数据，不依赖任何远程资源。
//
// 场景 JSON 结构见 README。隔断 partition 与墙 wall 都是轴对齐线段，
// 区别仅在于 partition 带开口 openings（门缝），展开后同样得到一组遮挡线段。

const SCHEMA_VERSION = 1;
const TAU = Math.PI * 2;

function requireFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} 必须是有限数字`);
  }
  return value;
}

function point(value, name) {
  if (!value || typeof value !== 'object') throw new TypeError(`${name} 必须是点对象 {x, y}`);
  return { x: requireFinite(value.x, `${name}.x`), y: requireFinite(value.y, `${name}.y`) };
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} 必须是非空字符串`);
  }
  return value;
}

// 轴对齐线段（水平或垂直），返回带 a/b 的统一线段结构。
function axisSegment(from, to, kind, id) {
  const a = point(from, `${id}.from`);
  const b = point(to, `${id}.to`);
  if (Math.abs(a.x - b.x) > 1e-9 && Math.abs(a.y - b.y) > 1e-9) {
    throw new RangeError(`${id} 必须是水平或垂直的轴对齐线段`);
  }
  if (Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9) {
    throw new RangeError(`${id} 长度不能为 0`);
  }
  return { a, b, kind, id };
}

function uniqueId(items, id, label) {
  if (items.some((item) => item.id === id)) {
    throw new RangeError(`${label} id 重复: ${id}`);
  }
}

// 把带开口的隔断展开为若干遮挡线段。
// 开口定义为沿隔断方向的偏移量 [start, end]（世界坐标），开门处不生成线段。
// 同时接受原始数据（from/to）与 loadScene 归一化后的（a/b）两种形态。
export function partitionSegments(partition) {
  const from = partition.from ?? partition.a;
  const to = partition.to ?? partition.b;
  const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  const start = horizontal ? Math.min(from.x, to.x) : Math.min(from.y, to.y);
  const end = horizontal ? Math.max(from.x, to.x) : Math.max(from.y, to.y);
  const openings = (partition.openings ?? [])
    .map((gap) => {
      requireFinite(gap.start, `${partition.id}.openings.start`);
      requireFinite(gap.end, `${partition.id}.openings.end`);
      if (gap.end <= gap.start) {
        throw new RangeError(`${partition.id} 的开口 end 必须大于 start`);
      }
      return [Math.max(start, gap.start), Math.min(end, gap.end)];
    })
    .filter(([s, e]) => e > s)
    .sort((p, q) => p[0] - q[0]);
  const cut = (at) => (horizontal
    ? { x: at, y: from.y }
    : { x: from.x, y: at });
  const result = [];
  let cursor = start;
  for (const [gapStart, gapEnd] of openings) {
    if (gapStart > cursor + 1e-9) {
      result.push({ a: cut(cursor), b: cut(gapStart), kind: 'partition', id: partition.id });
    }
    cursor = Math.max(cursor, gapEnd);
  }
  if (end > cursor + 1e-9) {
    result.push({ a: cut(cursor), b: cut(end), kind: 'partition', id: partition.id });
  }
  return result;
}

function normalizeLight(input, index) {
  const id = requireString(input.id ?? `light-${index + 1}`, `lights[${index}].id`);
  const light = {
    id,
    name: typeof input.name === 'string' && input.name ? input.name : id,
    x: requireFinite(input.x, `lights[${index}].x`),
    y: requireFinite(input.y, `lights[${index}].y`),
    // 朝向（弧度，0 指向 +x），全向灯忽略该值。
    aim: requireFinite(input.aim ?? 0, `lights[${index}].aim`),
    // 半锥角（弧度）。>= PI 视为全向灯。
    fov: requireFinite(input.fov ?? Math.PI, `lights[${index}].fov`),
    // 最大可照亮距离（世界单位），缩放和平移不改变它。
    range: requireFinite(input.range ?? 400, `lights[${index}].range`),
    // 满功率照度（距离为 0 处），单位为相对照度。
    power: requireFinite(input.power ?? 1, `lights[${index}].power`),
    color: typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color)
      ? input.color : '#ffe6b0',
    enabled: input.enabled !== false,
  };
  if (light.fov <= 0 || light.fov > Math.PI) {
    throw new RangeError(`lights[${index}].fov 必须在 (0, PI] 之间`);
  }
  if (light.range <= 0) throw new RangeError(`lights[${index}].range 必须为正数`);
  if (light.power <= 0) throw new RangeError(`lights[${index}].power 必须为正数`);
  light.aim = ((light.aim % TAU) + TAU) % TAU;
  return light;
}

export function loadScene(input) {
  if (!input || typeof input !== 'object') throw new TypeError('场景数据必须是对象');
  const walls = [];
  const partitions = [];
  const columns = [];
  const obstacleIds = new Set();

  for (const [index, wall] of (input.walls ?? []).entries()) {
    const id = requireString(wall.id ?? `wall-${index + 1}`, `walls[${index}].id`);
    if (obstacleIds.has(id)) throw new RangeError(`墙体/隔断/柱子 id 重复: ${id}`);
    obstacleIds.add(id);
    walls.push(axisSegment(wall.from, wall.to, 'wall', id));
  }
  for (const [index, partition] of (input.partitions ?? []).entries()) {
    const id = requireString(partition.id ?? `partition-${index + 1}`, `partitions[${index}].id`);
    if (obstacleIds.has(id)) throw new RangeError(`墙体/隔断/柱子 id 重复: ${id}`);
    obstacleIds.add(id);
    const segment = axisSegment(partition.from, partition.to, 'partition', id);
    segment.openings = partition.openings ?? [];
    partitions.push(segment);
  }
  for (const [index, column] of (input.columns ?? []).entries()) {
    const id = requireString(column.id ?? `column-${index + 1}`, `columns[${index}].id`);
    if (obstacleIds.has(id)) throw new RangeError(`墙体/隔断/柱子 id 重复: ${id}`);
    obstacleIds.add(id);
    const center = point(column.center, `columns[${index}].center`);
    const radius = requireFinite(column.radius, `columns[${index}].radius`);
    if (radius <= 0) throw new RangeError(`columns[${index}].radius 必须为正数`);
    columns.push({ id, center, radius });
  }
  const lights = [];
  for (const [index, light] of (input.lights ?? []).entries()) {
    const normalized = normalizeLight(light, index);
    uniqueId(lights, normalized.id, '灯具');
    lights.push(normalized);
  }
  const bounds = input.bounds
    ? {
        width: requireFinite(input.bounds.width, 'bounds.width'),
        height: requireFinite(input.bounds.height, 'bounds.height'),
      }
    : { width: 1000, height: 700 };
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new RangeError('bounds 宽高必须为正数');
  }
  const threshold = requireFinite(input.settings?.threshold ?? 0.15, 'settings.threshold');
  if (threshold < 0) throw new RangeError('照度门限不能为负数');
  const cellSize = requireFinite(input.settings?.cellSize ?? 14, 'settings.cellSize');
  if (cellSize <= 0) throw new RangeError('门限网格单元必须为正数');
  return {
    schemaVersion: SCHEMA_VERSION,
    name: typeof input.name === 'string' ? input.name : '未命名方案',
    bounds,
    walls,
    partitions,
    columns,
    lights,
    checkpoints: Array.isArray(input.checkpoints) ? input.checkpoints.map((cp, i) => ({
      id: requireString(cp.id ?? `checkpoint-${i + 1}`, `checkpoints[${i}].id`),
      x: requireFinite(cp.x, `checkpoints[${i}].x`),
      y: requireFinite(cp.y, `checkpoints[${i}].y`),
      // dark: 应全暗；partial: 多束光相交；visible: 至少一盏灯直接可见。
      expect: ['dark', 'partial', 'visible'].includes(cp.expect) ? cp.expect : 'visible',
      lights: Array.isArray(cp.lights) ? [...cp.lights] : null,
      note: typeof cp.note === 'string' ? cp.note : '',
    })) : [],
    settings: {
      threshold,
      cellSize,
      falloff: 'quadratic',
    },
  };
}

// 场景中所有遮挡体展开成的线段集合。柱子用 32 边近似圆。
export function sceneSegments(scene) {
  const segments = [];
  for (const wall of scene.walls) {
    segments.push({ a: wall.a, b: wall.b, kind: 'wall', id: wall.id });
  }
  for (const partition of scene.partitions) {
    segments.push(...partitionSegments(partition));
  }
  const sides = 32;
  for (const column of scene.columns) {
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      ring.push({
        x: column.center.x + Math.cos(angle) * column.radius,
        y: column.center.y + Math.sin(angle) * column.radius,
      });
    }
    for (let i = 0; i < sides; i++) {
      segments.push({
        a: ring[i],
        b: ring[(i + 1) % sides],
        kind: 'column',
        id: column.id,
      });
    }
  }
  return segments;
}

export function isOmni(light) {
  return light.fov >= Math.PI - 1e-9;
}

// 导出为可复核的纯数据（函数可直接 JSON.stringify）。
export function serializeScene(scene) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: scene.name,
    bounds: { ...scene.bounds },
    settings: { ...scene.settings },
    walls: scene.walls.map((w) => ({ id: w.id, from: { ...w.a }, to: { ...w.b } })),
    partitions: scene.partitions.map((p) => ({
      id: p.id,
      from: { ...p.a },
      to: { ...p.b },
      openings: (p.openings ?? []).map((gap) => ({ ...gap })),
    })),
    columns: scene.columns.map((c) => ({
      id: c.id,
      center: { ...c.center },
      radius: c.radius,
    })),
    lights: scene.lights.map((l) => ({ ...l })),
    checkpoints: scene.checkpoints.map((cp) => ({ ...cp })),
  };
}

export { SCHEMA_VERSION };
