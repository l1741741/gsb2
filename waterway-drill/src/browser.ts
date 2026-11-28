/**
 * 浏览器入口：把演练所需的模块聚合为稳定导出。
 * 构建后由 demo/ 以 ES module 方式加载，不引入任何第三方运行时代码。
 */
export { compileLevel, LevelError, fingerprintOf } from './level.ts';
export type { CompiledLevel } from './level.ts';
export { DrillSession } from './game.ts';
export { settleTurn, allocateFairShare, auditLedgers } from './settle.ts';
export { replayRecord, parseRecord, RecordRejectedError } from './replay.ts';
export { buildView, buildReplayView } from './view.ts';
export { solveLevel } from './solver.ts';
export { sampleLevels, levelOne, levelTwo } from './levels/index.ts';
export { renderScene, hitTest, screenToWorld } from './ui/render.ts';
export {
  palette,
  waterHeight,
  poolRect,
  edgePoints,
  polylineMidpoint,
  poolsWithinViewport,
  WORLD_WIDTH,
  WORLD_HEIGHT,
} from './ui/scene.ts';
export type {
  DrillRecord,
  Failure,
  GateState,
  GameView,
  LevelSpec,
  PoolView,
  EdgeView,
  GateView,
  TurnOutcome,
  TurnRecord,
  PoolLedger,
} from './types.ts';
