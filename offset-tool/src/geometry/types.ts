/**
 * 公共数据类型。坐标单位与输入一致（毫米等由调用方自行约定），
 * 工具内部不做单位假设，仅在送入 Clipper 时按固定比例放大为整数。
 */

/** 二维点。 */
export interface Point {
  x: number;
  y: number;
}

/** 一条闭合环：首尾点不重复存储。 */
export type Loop = Point[];

/** 角部外观，对应 Clipper 的 JoinType。 */
export type JoinKind = 'miter' | 'round' | 'square';

/** 偏移参数。distance > 0 外扩，< 0 内缩，0 原样（仅清洗）。 */
export interface OffsetParams {
  /** 外扩（正）或内缩（负）距离，坐标单位。 */
  distance: number;
  /** 角部连接方式。 */
  join: JoinKind;
  /** 斜接限制（仅 miter）：斜接长度与距离之比上限，Clipper 默认 2。 */
  miterLimit: number;
  /** 圆弧容差（仅 round）：弦高上限，坐标单位；<=0 时按距离自动取值。 */
  arcTolerance: number;
  /**
   * 清洗容差，坐标单位。近重复点、共线抖动在此距离内被合并。
   * 取 0 时使用内部默认值（scale 对应 0.01 单位）。
   */
  cleanTolerance: number;
}

/** 单个环的角色。 */
export type LoopRole = 'outer' | 'hole';

export interface InputLoopInfo {
  /** 该环在输入 loops 数组中的下标。 */
  index: number;
  role: LoopRole;
  /** 输入时的有向面积符号，>0 为逆时针（屏幕坐标下）。 */
  signedArea: number;
  pointCount: number;
}

/** 自交/退化诊断条目。 */
export interface GeometryIssue {
  kind:
    | 'self-intersection'
    | 'duplicate-point'
    | 'degenerate-loop'
    | 'overlapping-edge'
    | 'containment-violation'
    | 'non-nested-loop';
  /** 人类可读说明。 */
  message: string;
  /** 可定位信息：涉及的环下标与点下标（从 0 起）。 */
  loopIndex: number;
  pointIndex?: number;
  loopIndex2?: number;
  pointIndex2?: number;
  /** 问题发生处的坐标（自交点等）。 */
  point?: Point;
}

/** 结果中的一条环。 */
export interface ResultLoop {
  id: string;
  role: LoopRole;
  /** 深度：0=最外层实体，1=其孔洞，2=孔洞内实体（孤岛），依此类推。 */
  depth: number;
  /** 所属实体组件 id（同一外轮廓及其孔洞共享）。 */
  componentId: string;
  points: Point[];
  /** 结果环的有向面积。 */
  signedArea: number;
  /** 该环由哪些输入环演化而来（输入环下标）。 */
  sourceLoops: number[];
}

/** 被删除的细片/通道：原始区域与结果区域的差异部分。 */
export interface RemovedSliver {
  id: string;
  points: Point[];
  /** 面积绝对值。 */
  area: number;
  /** 差异类型：收缩时为 removed（被吃掉的材料），外扩时为 added（新增材料）。 */
  kind: 'removed' | 'added';
}

/** 一次偏移的完整结果。 */
export interface OffsetResult {
  params: OffsetParams;
  /** 结果实体组件数量（含被拆分出来的多块）。 */
  components: ResultLoop[][];
  loops: ResultLoop[];
  removedSlivers: RemovedSliver[];
  /** 结果是否为空（内缩过度，整块材料消失）。 */
  empty: boolean;
  /** 统计摘要。 */
  stats: {
    outerCount: number;
    holeCount: number;
    sliverCount: number;
    removedArea: number;
    addedArea: number;
  };
}

/** 轮廓输入：一组闭合环，角色由包含关系自动判定，也可显式标注。 */
export interface ContourInput {
  name: string;
  loops: Loop[];
  /**
   * 可选：显式指定每个环的角色。缺省时按包含树自动判定
   * （最外层为 outer，向内奇偶交替）。
   */
  roles?: LoopRole[];
}
