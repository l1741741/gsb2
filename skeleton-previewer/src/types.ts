// 数据类型定义：角色骨骼、挂点、道具、动作片段、过渡与场景编排。
// 所有角度单位为度（degree），坐标系与 Canvas 一致：x 向右，y 向下。

export interface BoneDef {
  id: string;
  parent: string | null;
  /** 相对父骨骼的静止位置 */
  x: number;
  y: number;
  /** 相对父骨骼的静止旋转（度） */
  rotation: number;
  /** 骨骼长度（仅用于绘制与 IK，永不拉伸） */
  length: number;
}

export interface AttachmentDef {
  id: string;
  /** 挂在哪根骨骼上 */
  bone: string;
  /** 相对该骨骼的局部偏移 */
  x: number;
  y: number;
}

export interface PropDef {
  id: string;
  /** 道具跟随的挂点 */
  attachment: string;
  width: number;
  height: number;
  /** 相对挂点骨骼的额外旋转（度） */
  rotation: number;
  color?: string;
}

export interface ChainDef {
  id: string;
  /** 两节链条：[根骨, 末骨]，例如 [上臂, 前臂] */
  bones: [string, string];
  /** 链条末端挂点（IK 目标作用在它上面） */
  endAttachment: string;
  /** 关节弯曲方向：1 或 -1，决定肘/膝朝哪边弯 */
  bend: 1 | -1;
}

export interface CharacterDef {
  name: string;
  bones: BoneDef[];
  attachments: AttachmentDef[];
  props: PropDef[];
  chains: ChainDef[];
}

/** 位置关键帧 [时间, x, y] */
export type PosKey = [number, number, number];
/** 旋转关键帧 [时间, 角度] */
export type RotKey = [number, number];

export interface TrackDef {
  pos?: PosKey[];
  rot?: RotKey[];
}

export interface ClipDef {
  id: string;
  duration: number;
  tracks: Record<string, TrackDef>;
}

export type SegmentDef =
  | { type: 'clip'; clip: string; duration: number; startAt?: number }
  | {
      type: 'transition';
      from: string;
      to: string;
      duration: number;
      fromStartAt?: number;
      toStartAt?: number;
    };

export interface PinDef {
  /** 被固定的挂点 */
  attachment: string;
  /** 求解用的链条 */
  chain: string;
  /** 场景坐标中的固定目标 */
  x: number;
  y: number;
  /** 生效时间窗（场景时间，缺省为全程） */
  from?: number;
  to?: number;
}

export interface ScenarioDef {
  id: string;
  description: string;
  loop: boolean;
  program: SegmentDef[];
  pins: PinDef[];
  /** 需要导出数值的关键时间点 */
  exportTimes: number[];
}

// ---- 求值结果 ----

export interface Transform {
  x: number;
  y: number;
  /** 度 */
  rot: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface BoneWorld {
  id: string;
  world: Transform;
  tip: Vec2;
}

export interface PinResult {
  attachment: string;
  chain: string;
  target: Vec2;
  achieved: Vec2;
  /** 不可达偏差：目标与实际末端的距离；可达时为 0 */
  deviation: number;
  reachable: boolean;
}

export interface FrameResult {
  time: number;
  segmentIndex: number;
  segmentType: 'clip' | 'transition';
  /** 过渡段内的混合系数 0..1，非过渡段为 null */
  blend: number | null;
  bones: BoneWorld[];
  attachments: Record<string, Vec2>;
  props: Record<string, Transform>;
  pins: PinResult[];
}
