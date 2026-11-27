/**
 * 结果导出为可核对的 JSON：固定键序、固定小数位，
 * 同一份轮廓与参数在任意机器、任意次数运行下字节一致。
 */
import type {
  ContourInput,
  InputLoopInfo,
  OffsetParams,
  OffsetResult,
  Point,
} from './types.js';
import type { ValidationReport } from './validate.js';

/** 坐标保留的小数位数（输入单位）。内部整数缩放为 1e6，输出统一 6 位。 */
export const EXPORT_DECIMALS = 6;

export function roundPoint(p: Point, decimals = EXPORT_DECIMALS): Point {
  const f = 10 ** decimals;
  return {
    x: Math.round(p.x * f) / f,
    y: Math.round(p.y * f) / f,
  };
}

interface SerialLoop {
  id: string;
  role: 'outer' | 'hole';
  depth: number;
  componentId: string;
  sourceLoops: number[];
  signedArea: number;
  points: Point[];
}

interface SerialRun {
  distance: number;
  join: OffsetParams['join'];
  miterLimit: number;
  arcTolerance: number;
  cleanTolerance: number;
  empty: boolean;
  stats: OffsetResult['stats'];
  /** 每个实体组件一列，值为该组件包含的环 id，顺序即嵌套顺序。 */
  components: string[][];
  loops: SerialLoop[];
  removedSlivers: {
    id: string;
    kind: 'removed' | 'added';
    area: number;
    points: Point[];
  }[];
}

export interface BatchExport {
  format: 'offset-tool/results';
  formatVersion: 1;
  generatedAt: string;
  input: {
    name: string;
    loops: { role: InputLoopInfo['role']; points: Point[] }[];
  };
  validation: {
    valid: boolean;
    issueCount: number;
    issues: ValidationReport['issues'];
  };
  runs: SerialRun[];
}

function serializeResult(params: OffsetParams, result: OffsetResult): SerialRun {
  return {
    distance: params.distance,
    join: params.join,
    miterLimit: params.miterLimit,
    arcTolerance: params.arcTolerance,
    cleanTolerance: params.cleanTolerance,
    empty: result.empty,
    stats: result.stats,
    components: result.components.map((comp) => comp.map((l) => l.id)),
    loops: result.loops.map((l) => ({
      id: l.id,
      role: l.role,
      depth: l.depth,
      componentId: l.componentId,
      sourceLoops: [...l.sourceLoops].sort((a, b) => a - b),
      signedArea: l.signedArea,
      points: l.points.map((p) => roundPoint(p)),
    })),
    removedSlivers: result.removedSlivers.map((s) => ({
      id: s.id,
      kind: s.kind,
      area: s.area,
      points: s.points.map((p) => roundPoint(p)),
    })),
  };
}

/**
 * 稳定序列化：对象键按字典序输出，数组保持几何顺序。
 * 显式排序键，避免依赖引擎的属性插入顺序行为。
 */
export function stableStringify(value: unknown, decimals = EXPORT_DECIMALS): string {
  const seen = new WeakSet<object>();
  const serialize = (v: unknown, indent: number): string => {
    const pad = '  '.repeat(indent);
    const padInner = '  '.repeat(indent + 1);
    if (v === null) return 'null';
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('无法序列化非有限数');
      if (Number.isInteger(v)) return String(v);
      const f = 10 ** decimals;
      return String(Math.round(v * f) / f);
    }
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const items = v.map((item) => padInner + serialize(item, indent + 1));
      return `[\n${items.join(',\n')}\n${pad}]`;
    }
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) throw new Error('导出数据存在循环引用');
    seen.add(obj);
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    if (keys.length === 0) return '{}';
    const items = keys.map((k) => {
      const val = serialize(obj[k], indent + 1);
      return `${padInner}${JSON.stringify(k)}: ${val}`;
    });
    return `{\n${items.join(',\n')}\n${pad}}`;
  };
  return serialize(value, 0) + '\n';
}

export function buildBatchExport(
  input: ContourInput,
  info: InputLoopInfo[],
  validation: ValidationReport,
  runs: { params: OffsetParams; result: OffsetResult }[],
  generatedAt: string,
): BatchExport {
  return {
    format: 'offset-tool/results',
    formatVersion: 1,
    generatedAt,
    input: {
      name: input.name,
      loops: input.loops.map((loop, i) => ({
        role: info[i]?.role ?? 'outer',
        points: loop.map((p) => roundPoint(p)),
      })),
    },
    validation: {
      valid: validation.valid,
      issueCount: validation.issues.length,
      issues: validation.issues,
    },
    runs: runs.map(({ params, result }) => serializeResult(params, result)),
  };
}
