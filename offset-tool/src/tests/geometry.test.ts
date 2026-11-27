/**
 * 几何引擎行为测试。全部通过纯计算断言，不依赖浏览器或像素比对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXAMPLES,
  DEFAULT_PARAMS,
  offsetContours,
  validateContour,
  describeInputs,
  stableStringify,
  buildBatchExport,
  selfIntersectingBowtie,
  slitPlate,
  edgeHolePlate,
  dumbbellPlate,
  concaveLPlate,
} from '../index.js';
import type { OffsetParams } from '../geometry/types.js';

function params(over: Partial<OffsetParams>): OffsetParams {
  return { ...DEFAULT_PARAMS, ...over };
}

test('自交蝴蝶结被校验拦截并给出可定位交点', () => {
  const report = validateContour(selfIntersectingBowtie());
  assert.equal(report.valid, false);
  const si = report.issues.find((i) => i.kind === 'self-intersection');
  assert.ok(si, '应至少报一个 self-intersection');
  assert.ok(si!.point);
  // 蝴蝶结两条对角线交于 (30,20)
  assert.ok(Math.abs(si!.point!.x - 30) < 1e-6, `x=${si!.point!.x}`);
  assert.ok(Math.abs(si!.point!.y - 20) < 1e-6, `y=${si!.point!.y}`);
  assert.equal(typeof si!.loopIndex, 'number');
  assert.equal(typeof si!.pointIndex, 'number');
});

test('全部内置示例（除反例）通过校验', () => {
  for (const ex of EXAMPLES) {
    const report = validateContour(ex.input);
    if (ex.input.name === 'self-intersecting-bowtie') {
      assert.equal(report.valid, false);
    } else {
      assert.equal(report.valid, true, `${ex.input.name}: ${report.issues.map((i) => i.message).join('; ')}`);
    }
  }
});

test('狭缝板细颈被吃掉后两个孔合并，删除材料以 removed 细片核出', () => {
  const input = slitPlate();
  const before = offsetContours(input.loops, params({ distance: 0 }));
  assert.equal(before.stats.holeCount, 2, '初始为两个独立孔');
  // d=-2 细颈（宽 6）尚在，仍是两孔
  const open = offsetContours(input.loops, params({ distance: -2 }));
  assert.equal(open.stats.holeCount, 2);
  // d=-3 细颈两侧各吃掉 3，颈消失 → 两孔合并为一个连通孔
  const merged = offsetContours(input.loops, params({ distance: -3 }));
  assert.equal(merged.stats.holeCount, 1);
  assert.equal(merged.components.length, 1, '实体本身仍为一块');
  assert.ok(merged.stats.removedArea > 0);
  assert.ok(merged.removedSlivers.some((s) => s.kind === 'removed'));
});

test('贴边孔先融合、居中孔保留：孔数随内缩距离下降', () => {
  const input = edgeHolePlate();
  const d0 = offsetContours(input.loops, params({ distance: 0 }));
  assert.equal(d0.stats.holeCount, 2);
  // 贴边孔边距 4，内缩 2 即融合；居中孔边距充足仍保留
  const d2 = offsetContours(input.loops, params({ distance: -2 }));
  assert.equal(d2.stats.holeCount, 1);
  const d4 = offsetContours(input.loops, params({ distance: -4 }));
  assert.equal(d4.stats.holeCount, 1);
});

test('哑铃板内缩到 -6 时拆成两个独立组件', () => {
  const input = dumbbellPlate();
  const d5 = offsetContours(input.loops, params({ distance: -5 }));
  assert.equal(d5.components.length, 1, '-5 颈部尚未断（半宽 6）');
  const d7 = offsetContours(input.loops, params({ distance: -7 }));
  assert.equal(d7.components.length, 2, '-7 应拆为两块');
  assert.equal(d7.stats.outerCount, 2);
  // 两块都是外环、深度 0，各自独立
  assert.deepEqual(d7.components.map((c) => c[0].role), ['outer', 'outer']);
});

test('凹角 L 板大距离外扩结果仍为简单环，无自交', () => {
  const input = concaveLPlate();
  const grown = offsetContours(input.loops, params({ distance: 14 }));
  assert.equal(grown.empty, false);
  assert.equal(grown.loops.length, 1);
  const loop = grown.loops[0].points;
  // 用校验器对输出环做自交复检：输出环自身必须是简单多边形
  const recheck = validateContour({ name: 'grown', loops: [loop] });
  assert.equal(recheck.valid, true, recheck.issues.map((i) => i.message).join('; '));
  // 外扩面积必须增大
  const area0 = Math.abs(offsetContours(input.loops, params({ distance: 0 })).loops[0].signedArea);
  assert.ok(Math.abs(grown.loops[0].signedArea) > area0);
});

test('外扩产生 added 细片，内缩产生 removed 细片，面积为正', () => {
  const input = concaveLPlate();
  const grown = offsetContours(input.loops, params({ distance: 8 }));
  assert.ok(grown.removedSlivers.every((s) => s.kind === 'added'));
  assert.ok(grown.stats.addedArea > 0);
  const shrunk = offsetContours(input.loops, params({ distance: -4 }));
  assert.ok(shrunk.removedSlivers.every((s) => s.kind === 'removed'));
  assert.ok(shrunk.stats.removedArea > 0);
});

test('同参数重复运行结果完全一致（确定性）', () => {
  const input = dumbbellPlate();
  const p = params({ distance: -7, join: 'round', arcTolerance: 0.05 });
  const a = offsetContours(input.loops, p);
  const b = offsetContours(input.loops, p);
  assert.deepEqual(b.loops.map((l) => l.points), a.loops.map((l) => l.points));
  assert.deepEqual(b.components.map((c) => c.map((l) => l.id)), a.components.map((c) => c.map((l) => l.id)));
});

test('导出 JSON 字节稳定且可重新解析核对坐标', () => {
  const input = slitPlate();
  const validation = validateContour(input);
  const info = describeInputs(input.loops);
  const runs = [-2, -4].map((distance) => ({
    params: params({ distance }),
    result: offsetContours(input.loops, params({ distance })),
  }));
  const e1 = buildBatchExport(input, info, validation, runs, '2026-01-01T00:00:00.000Z');
  const e2 = buildBatchExport(input, info, validation, runs, '2026-01-01T00:00:00.000Z');
  const s1 = stableStringify(e1);
  const s2 = stableStringify(e2);
  assert.equal(s2, s1);
  const reparsed = JSON.parse(s1);
  assert.equal(reparsed.format, 'offset-tool/results');
  assert.equal(reparsed.runs.length, 2);
  // 坐标可核对：首环首点数值与输入一致（6 位小数）
  assert.ok(Math.abs(reparsed.input.loops[0].points[0].x - input.loops[0][0].x) < 1e-6);
});

test('角型切换改变顶点数：round 比 miter 产生更多点', () => {
  const input = concaveLPlate();
  const miter = offsetContours(input.loops, params({ distance: 10, join: 'miter' }));
  const round = offsetContours(input.loops, params({ distance: 10, join: 'round', arcTolerance: 0.1 }));
  assert.ok(round.loops[0].points.length > miter.loops[0].points.length);
});

test('过度内缩返回 empty 而非抛异常', () => {
  const input = slitPlate();
  const gone = offsetContours(input.loops, params({ distance: -60 }));
  assert.equal(gone.empty, true);
  assert.equal(gone.loops.length, 0);
  assert.equal(gone.components.length, 0);
});
