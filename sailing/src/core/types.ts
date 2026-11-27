// 领域模型。时间：秒；长度：米；速度：米/秒。
// 航向与风向使用罗盘角：0° 为北（屏幕上方），顺时针增大；风向表示“风从哪来”。
// 本文件只包含类型与常量，运行时除默认参数外会被擦除。

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface WindState {
  /** 风从哪个罗盘方向来，度。 */
  direction: number;
  /** 风速，米/秒。 */
  speed: number;
}

export interface WindZone {
  id: string;
  name: string;
  /** 多边形顶点。查询时数组靠后的风区覆盖靠前的风区。 */
  vertices: Vec2[];
  /** 该风区的常态风，可被 windChanges 覆盖。 */
  wind: WindState;
}

export interface WindChange {
  /** 关卡时间，秒。 */
  time: number;
  /** null = 全部水域；"open" = 风区之外的开阔水域；否则为风区 id。 */
  zoneId: string | null;
  direction: number;
  speed: number;
  note?: string;
}

export type Obstacle =
  | {
      kind: 'circle';
      id: string;
      name: string;
      center: Vec2;
      radius: number;
    }
  | {
      kind: 'rock';
      id: string;
      name: string;
      vertices: Vec2[];
    };

export interface BuoyGate {
  id: string;
  name: string;
  /** 标线端点。跨过线段 a-b 即视为通过，两个方向均可。 */
  a: Vec2;
  b: Vec2;
  /** 浮标绘制半径；判定以标线为准。 */
  radius?: number;
}

export interface Dock {
  id: string;
  name: string;
  /** 泊位入口中心。 */
  mouth: Vec2;
  /** 入口指向泊位内部，也是允许的进港航向，罗盘度。 */
  heading: number;
  /** 泊位长度（入口到底部）。 */
  length: number;
  /** 泊位宽度。 */
  width: number;
  /** 进港限速，米/秒。 */
  speedLimit: number;
}

export interface StartState {
  position: Vec2;
  heading: number;
  speed: number;
  sheet: number;
}

export interface Level {
  id: string;
  name: string;
  subtitle: string;
  /** 航行水域边界；触岸 / 出界即失败。 */
  bounds: Vec2[];
  start: StartState;
  windZones: WindZone[];
  /** 所有风区之外的风。 */
  openWind: WindState;
  windChanges: WindChange[];
  obstacles: Obstacle[];
  buoys: BuoyGate[];
  /** 必须依次通过的浮标 id。 */
  route: string[];
  dock: Dock;
  /** 关卡时间上限，秒。 */
  duration: number;
  briefing: string[];
  physics?: Partial<PhysicsParams>;
  palette?: Partial<LevelPalette>;
}

export interface PhysicsParams {
  /** 固定仿真步长，秒。所有刷新率共用，是确定性的来源。 */
  fixedStep: number;
  /** 全帆、正横风、参考风速下的船速，米/秒。 */
  hullSpeed: number;
  /** 达到 hullSpeed 的参考风速，米/秒。 */
  referenceWind: number;
  /** 最大转向速率，度/秒。 */
  maxTurnRate: number;
  /** 航速变化的时间常数，秒。 */
  speedResponse: number;
  /** 帆位变化的时间常数，秒。 */
  sheetResponse: number;
  /** 船体碰撞半径，米。 */
  hullRadius: number;
  /** 障碍判定额外余量，米。 */
  obstacleClearance: number;
  /** 顶风死区半角，度。 */
  noGoAngle: number;  /** 进港限速的判定余量，米/秒。 */
  dockSpeedMargin: number;
  /** 允许的进港航向偏差，度。 */
  dockAlignTolerance: number;
}

export interface LevelPalette {
  water: string;
  shallow: string;
  land: string;
  zone: string;
  zoneLabel: string;
  obstacle: string;
  buoy: string;
  buoyNext: string;
  buoyPassed: string;
  dock: string;
  routeLine: string;
  wake: string;
  predicted: string;
}

export const DEFAULT_PHYSICS: PhysicsParams = {
  fixedStep: 1 / 120,
  hullSpeed: 7,
  referenceWind: 9,
  maxTurnRate: 38,
  speedResponse: 1.15,
  sheetResponse: 0.4,
  hullRadius: 2.8,
  obstacleClearance: 0.5,
  noGoAngle: 34,
  dockSpeedMargin: 0.05,
  dockAlignTolerance: 42,
};

export const DEFAULT_PALETTE: LevelPalette = {
  water: '#0c2736',
  shallow: '#12384a',
  land: '#24433f',
  zone: 'rgba(126, 200, 220, 0.15)',
  zoneLabel: '#9fd3e2',
  obstacle: '#3f4d49',
  buoy: '#e7c06b',
  buoyNext: '#ffd27a',
  buoyPassed: '#7fd6a6',
  dock: '#b78255',
  routeLine: 'rgba(240, 195, 106, 0.42)',
  wake: 'rgba(190, 226, 235, 0.42)',
  predicted: 'rgba(140, 225, 245, 0.78)',
};

/** 玩家在暂停区编排的单条走艇指令，时间为关卡时间。 */
export interface CourseCommand {
  time: number;
  /** 指令生效后的目标航向，罗盘度。 */
  heading: number;
  /** 目标帆位：0 = 完全收帆，1 = 全帆。 */
  sheet: number;
}

export interface CoursePlan {
  version: 1;
  levelId: string;
  commands: CourseCommand[];
}

/** 一次跨过标线的记录；逆序 / 重复通过的 order 为 0。 */
export interface GateCrossing {
  gateId: string;
  /** 精确跨线时间（步内线性插值），秒。 */
  time: number;
  position: Vec2;
  speed: number;
  /** 航线中的有效次序（1 起）；0 表示非有效次序。 */
  order: number;
  /** true 表示回穿已经按次序通过过的浮标（不做判罚，只记录）。 */
  repeat?: boolean;
}

export type IssueKind =
  | 'wrong-order'
  | 'obstacle-contact'
  | 'over-speed-dock'
  | 'dock-missed'
  | 'outside-bounds'
  | 'timeout';

export interface Issue {
  kind: IssueKind;
  time: number;
  position: Vec2;
  message: string;
  subjectId?: string;
}

export type RunOutcome = 'docked' | 'failed' | 'timed-out';

export interface RunSummary {
  outcome: RunOutcome;
  finishTime: number;
  /** 全部跨线事件（含逆序与重复），按时间排序。 */
  crossings: GateCrossing[];
  /** 按航线次序成功通过的浮标数。 */
  routeProgress: number;
  issues: Issue[];
  finalPosition: Vec2;
  dockSpeed: number | null;
}

/** 固定步长快照；回放与预计航迹都基于它。 */
export interface RunFrame {
  time: number;
  position: Vec2;
  heading: number;
  /** 实际航迹方向，罗盘度。 */
  track: number;
  speed: number;
  sheet: number;
  windSpeed: number;
  windDirection: number;
  zoneId: string | null;
  zoneName: string;
}

export interface RunRecord {
  levelId: string;
  levelName: string;
  /** 关卡内容哈希（不含配色与提示）。 */
  levelHash: string;
  /** 指令内容哈希（不含 levelId），用于区分玩家修改。 */
  commandHash: string;
  /** 完整航线哈希（含 levelId）。 */
  planHash: string;
  plan: CoursePlan;
  physics: PhysicsParams;
  /** 帧采样间隔（秒），默认等于 physics.fixedStep。 */
  sampleStep: number;
  frames: RunFrame[];
  summary: RunSummary;
  steps: number;
}

/** 回放航段：从一次关键事件到下一次关键事件。 */
export interface RunLeg {
  index: number;
  label: string;
  kind: 'start' | 'gate' | 'dock' | 'issue';
  startTime: number;
  endTime: number;
  startPosition: Vec2;
  endPosition: Vec2;
  /** 该航段结束时的有效浮标次序（0 表示未经过有效浮标）。 */
  order: number;
}

/** UI 中可编辑的控制点；key 仅用于稳定 DOM。 */
export interface EditableCommand extends CourseCommand {
  key: string;
}

export interface CommandChange {
  kind: 'added' | 'removed' | 'changed';
  time: number;
  field?: 'time' | 'heading' | 'sheet';
  before?: number;
  after?: number;
}

/** 两次记录的对比结果：区分关卡变化与玩家修改。 */
export interface RunComparison {
  sameLevel: boolean;
  sameCommands: boolean;
  /** 关卡内容发生变化的顶层字段。 */
  levelFields: string[];
  commandChanges: CommandChange[];
  resultChanges: string[];
  firstDivergence: string | null;
  cause: 'none' | 'level' | 'plan' | 'both';
}

/** 回放时间轴上的一个定位点。 */
export interface TimelineEvent {
  id: string;
  time: number;
  kind: 'start' | 'gate' | 'issue' | 'dock' | 'wind';
  label: string;
  position: Vec2;
  /** 在 frames 中的最近帧索引。 */
  frameIndex: number;
}

/** 船的运动学状态；仿真内部使用。 */
export interface BoatKinematics {
  position: Vec2;
  /** 船首向，罗盘度。 */
  heading: number;
  /** 当前帆位 0..1。 */
  sheet: number;
  speed: number;
}

/** 某一步采样到的风。 */
export interface WindSample {
  direction: number;
  speed: number;
  zoneId: string | null;
  zoneName: string;
}

/** 某时刻生效的走艇指令。 */
export interface BoatCommandLike {
  heading: number;
  sheet: number;
}

