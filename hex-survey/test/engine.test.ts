import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction,
  createSave,
  initialState,
  parseSave,
  replay,
  serializeSave,
  stateAtPrefix,
  type GameState,
} from '../src/engine.js';
import type { Action, MapDef } from '../src/types.js';

function engineMap(over: Partial<MapDef> = {}): MapDef {
  return {
    format: 'hex-survey-map@1',
    id: 'engine',
    name: '引擎测试图',
    brief: '',
    shape: { kind: 'hex', radius: 4 },
    start: { q: 0, r: 0 },
    budget: 10,
    costs: { move: 1, observe: 2 },
    eyeHeight: 2,
    wallHeight: 3,
    visionRange: 6,
    beacons: [
      { id: 'b1', q: 2, r: 0, name: '一' },
      { id: 'b2', q: -2, r: 0, name: '二' },
    ],
    ...over,
  };
}

function commit(map: MapDef, actions: Action[]): GameState {
  return replay(map, actions);
}

test('合法移动扣除预算并更新位置/计数', () => {
  const map = engineMap();
  const s = applyAction(initialState(map), { type: 'move', to: { q: 1, r: 0 } }, map);
  assert.deepEqual(s.player, { q: 1, r: 0 });
  assert.equal(s.budgetLeft, 9);
  assert.equal(s.moves, 1);
  assert.equal(s.step, 1);
});

test('非相邻格、障碍格、预算不足的移动都被拒绝', () => {
  const map = engineMap({
    obstacles: [{ q: 1, r: 0, kind: 'wall' }],
  });
  assert.throws(
    () => applyAction(initialState(map), { type: 'move', to: { q: 3, r: -3 } }, map),
    /相邻/,
  );
  assert.throws(
    () => applyAction(initialState(map), { type: 'move', to: { q: 1, r: 0 } }, map),
    /石墙|障碍/,
  );

  const poor = engineMap({ budget: 1, costs: { move: 1, observe: 2 } });
  let s = applyAction(initialState(poor), { type: 'move', to: { q: 1, r: 0 } }, poor);
  assert.equal(s.budgetLeft, 0);
  assert.throws(
    () => applyAction(s, { type: 'move', to: { q: 2, r: 0 } }, poor),
    /预算/,
  );
});

test('观测只标定可视信标、写入记录并扣费；全部找到即获胜', () => {
  const map = engineMap();
  // (0,0) 视点 2，平坦图：(2,0) 与 (-2,0) 都应可见。
  const s = applyAction(
    initialState(map),
    { type: 'observe', stanceId: 'standard' },
    map,
  );
  assert.equal(s.budgetLeft, 8);
  assert.equal(s.observes, 1);
  assert.deepEqual(s.foundIds, ['b1', 'b2']);
  assert.ok(s.records['2,0']);
  assert.equal(s.records['2,0'].beaconId, 'b1');
  assert.equal(s.status, 'won');
  // 获胜后状态机不再接受新行动（UI 只给撤回/重开/回放）。
  assert.throws(
    () => applyAction(s, { type: 'move', to: { q: 0, r: 1 } }, map),
    /已完成/,
  );
});

/** 三信标图：b3 被石墙藏住，保证前两次观测后仍是 playing。 */
function ongoingMap(): MapDef {
  return engineMap({
    beacons: [
      { id: 'b1', q: 2, r: 0 },
      { id: 'b2', q: -2, r: 0 },
      { id: 'b3', q: 0, r: -3 },
    ],
    obstacles: [{ q: 0, r: -1, kind: 'wall' }],
  });
}

test('移动到新地点后，已发现信标与记录仍在（由行动日志重放得到，不依赖重绘）', () => {
  const map = ongoingMap();
  const s1 = applyAction(
    initialState(map),
    { type: 'observe', stanceId: 'standard' },
    map,
  );
  assert.equal(s1.status, 'playing');
  assert.deepEqual(s1.foundIds, ['b1', 'b2']);

  const s2 = applyAction(s1, { type: 'move', to: { q: 0, r: 1 } }, map);
  assert.deepEqual(s2.foundIds, ['b1', 'b2']);
  assert.ok(s2.records['2,0']);
  assert.ok(s2.records['-2,0']);
});

test('撤回（删掉末尾行动并重放）同时还原预算、记录与已发现状态', () => {
  const map = engineMap();
  const actions: Action[] = [
    { type: 'move', to: { q: 1, r: 0 } },
    { type: 'observe', stanceId: 'standard' },
  ];
  const before = commit(map, actions.slice(0, 1));
  const full = commit(map, actions);
  assert.equal(full.observes, 1);
  assert.equal(full.foundIds.length, 2);
  assert.equal(full.budgetLeft, 7); // 10 - move1 - observe2

  // 撤回观测：还原到第一步之后。
  const undone = stateAtPrefix(map, actions, actions.length - 1);
  assert.deepEqual(undone, before);
  assert.equal(undone.budgetLeft, 9);
  assert.equal(undone.foundIds.length, 0);
  assert.equal(Object.keys(undone.records).length, 0);

  // 再撤回移动：回到初始。
  const undone2 = stateAtPrefix(map, actions, 0);
  assert.equal(undone2.budgetLeft, 10);
  assert.deepEqual(undone2.foundIds, []);
  assert.deepEqual(undone2.player, map.start);
});

test('记录保留“上次”结果：再次观测会覆盖同格记录的 step', () => {
  const map = ongoingMap();
  const actions: Action[] = [
    { type: 'observe', stanceId: 'standard' },
    { type: 'move', to: { q: 0, r: 1 } },
    { type: 'observe', stanceId: 'standard' },
  ];
  const s = replay(map, actions);
  assert.notEqual(s.status, 'won');
  // (1,0) 在两次观测中都可见；其记录应来自第 3 步（step=3）。
  assert.equal(s.records['1,0'].step, 3);
});

test('存档序列化/解析后重放结果与原局面完全一致（确定性）', () => {
  const map = ongoingMap();
  const actions: Action[] = [
    { type: 'move', to: { q: 1, r: 0 } },
    { type: 'observe', stanceId: 'standard' },
    { type: 'move', to: { q: 1, r: 1 } },
  ];
  const original = replay(map, actions);

  const text = serializeSave(createSave(map, actions));
  const parsed = parseSave(text);
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  const restored = replay(parsed.save!.map, parsed.save!.actions);

  // 地图 id 相同；逐字段深比较（log 文本也确定）。
  assert.deepEqual(restored, original);

  // 固定地图 + 固定行动重复 replay 必须得到同一结果。
  assert.deepEqual(replay(map, actions), replay(map, [...actions]));
});

test('非法存档（坏 JSON / 不能重放的行动序列）被拒绝', () => {
  assert.equal(parseSave('{not json').ok, false);
  assert.equal(parseSave(JSON.stringify({ app: 'nope', format: 1 })).ok, false);

  const map = engineMap();
  const bad = {
    app: 'hex-survey',
    format: 1,
    savedAt: 'x',
    map,
    // 起点 (0,0) 直接“移动”到不相邻格，重放应失败。
    actions: [{ type: 'move', to: { q: 4, r: -4 } }],
  };
  const res = parseSave(JSON.stringify(bad));
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /重放/);
});
