/**
 * 内置示例轮廓。坐标单位按毫米理解，原点取在板件左下角附近。
 * 每个示例同时给出设计意图与预期的偏移现象，供文档与测试引用。
 */
import type { ContourInput, Loop, Point } from './types.js';

function rect(cx: number, cy: number, w: number, h: number): Loop {
  return [
    { x: cx - w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy - h / 2 },
    { x: cx + w / 2, y: cy + h / 2 },
    { x: cx - w / 2, y: cy + h / 2 },
  ];
}

/**
 * 示例 1：狭缝（细颈双孔）板。
 * 外板 120x80，内部两个方孔之间只隔一条宽 6 的细实体颈（材料狭缝）。
 * 内缩 3 时两侧各被吃掉 3，细颈消失，两个孔合并为一个连通孔；
 * 被吃掉的细颈在 removedSlivers 中以独立细片给出，可从导出坐标核对。
 */
export function slitPlate(): ContourInput {
  const outer = rect(0, 0, 120, 80);
  const holeLeft: Loop = [
    { x: -23, y: -12 },
    { x: -3, y: -12 },
    { x: -3, y: 12 },
    { x: -23, y: 12 },
  ];
  const holeRight: Loop = [
    { x: 3, y: -12 },
    { x: 23, y: -12 },
    { x: 23, y: 12 },
    { x: 3, y: 12 },
  ];
  return {
    name: 'slit-plate',
    loops: [outer, holeLeft, holeRight],
  };
}

/**
 * 示例 2：贴边孔板。
 * 两个孔：一个距左边仅 4（贴边孔），一个居中。
 * 内缩超过 2 后贴边孔先与外边界融合消失，居中孔继续保留并扩大。
 */
export function edgeHolePlate(): ContourInput {
  const outer = rect(0, 0, 120, 80);
  const edgeHole = rect(-50, 0, 12, 12); // 孔左边 x=-56，外边界 x=-60，边距 4
  const centerHole = rect(20, 0, 16, 16);
  return {
    name: 'edge-hole-plate',
    loops: [outer, edgeHole, centerHole],
  };
}

/**
 * 示例 3：哑铃板（内缩拆两块）。
 * 两个 50x50 的方块由宽 12 的颈部连接。
 * 内缩 7 以上时颈部先断裂，一块实体拆成两个独立组件。
 */
export function dumbbellPlate(): ContourInput {
  // 手工构造 12 顶点哑铃外轮廓（颈部 y∈[-6,6]）
  const pts: Point[] = [
    { x: -65, y: -25 },
    { x: -15, y: -25 },
    { x: -15, y: -6 },
    { x: 15, y: -6 },
    { x: 15, y: -25 },
    { x: 65, y: -25 },
    { x: 65, y: 25 },
    { x: 15, y: 25 },
    { x: 15, y: 6 },
    { x: -15, y: 6 },
    { x: -15, y: 25 },
    { x: -65, y: 25 },
  ];
  return {
    name: 'dumbbell-plate',
    loops: [pts],
  };
}

/**
 * 示例 4：凹角 L 板。
 * 外扩时内角的偏移线本来会互相穿过，Clipper 自交清理后只保留外边。
 */
export function concaveLPlate(): ContourInput {
  const pts: Point[] = [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
    { x: 80, y: 30 },
    { x: 30, y: 30 },
    { x: 30, y: 70 },
    { x: 0, y: 70 },
  ];
  return { name: 'concave-l-plate', loops: [pts] };
}

/**
 * 反例：自交蝴蝶结轮廓。validate 必须拦截并给出交点坐标，
 * 偏移引擎拒绝执行。
 */
export function selfIntersectingBowtie(): ContourInput {
  const pts: Point[] = [
    { x: 0, y: 0 },
    { x: 60, y: 40 },
    { x: 60, y: 0 },
    { x: 0, y: 40 },
  ];
  return { name: 'self-intersecting-bowtie', loops: [pts] };
}

export interface ExampleDef {
  input: ContourInput;
  description: string;
  /** 文档与批处理默认使用的距离序列。 */
  distances: number[];
}

export const EXAMPLES: ExampleDef[] = [
  {
    input: slitPlate(),
    description: '狭缝板：内缩 3 后宽 6 的细颈被吃掉，两个孔合并为一个，删除的细颈单独标出',
    distances: [0, -2, -3, -6],
  },
  {
    input: edgeHolePlate(),
    description: '贴边孔板：贴边孔先于居中孔与外边界融合，孔洞连通关系变化可见',
    distances: [0, -2, -3, -6],
  },
  {
    input: dumbbellPlate(),
    description: '哑铃板：颈部内缩断裂，一个实体拆成两个独立组件',
    distances: [0, -4, -7, -10],
  },
  {
    input: concaveLPlate(),
    description: '凹角 L 板：大距离外扩时凹角自交被清理，自交段不成为零件外边',
    distances: [0, 6, 14],
  },
  {
    input: selfIntersectingBowtie(),
    description: '自交反例：校验阶段拦截并定位交点，不产生偏移结果',
    distances: [0, 5],
  },
];
