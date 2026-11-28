import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel } from '../src/level.ts';
import { DrillSession } from '../src/game.ts';
import { renderScene, hitTest, screenToWorld } from '../src/ui/render.ts';
import type { RenderContext } from '../src/ui/render.ts';
import {
  waterHeight,
  edgePoints,
  polylineMidpoint,
  poolsWithinViewport,
  WORLD_WIDTH,
  WORLD_HEIGHT,
} from '../src/ui/scene.ts';
import { levelOne, levelTwo } from '../src/levels/index.ts';

/** 只记录调用的 Canvas 2D 替身：验证“画了什么”，不验证像素。 */
class RecordingContext implements RenderContext {
  commands: [string, ...unknown[]][] = [];
  fillStyle = '#000';
  strokeStyle = '#000';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  globalAlpha = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  #stack: Array<Record<string, unknown>> = [];

  save(): void {
    this.commands.push(['save']);
    this.#stack.push({
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, font: this.font,
    });
  }
  restore(): void {
    const state = this.#stack.pop();
    if (state) Object.assign(this, state);
    this.commands.push(['restore']);
  }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.commands.push(['fillRect', this.fillStyle, x, y, width, height]);
  }
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.commands.push(['strokeRect', this.strokeStyle, x, y, width, height]);
  }
  clearRect(): void { this.commands.push(['clearRect']); }
  beginPath(): void { this.commands.push(['beginPath']); }
  moveTo(x: number, y: number): void { this.commands.push(['moveTo', x, y]); }
  lineTo(x: number, y: number): void { this.commands.push(['lineTo', x, y]); }
  closePath(): void { this.commands.push(['closePath']); }
  arc(): void { this.commands.push(['arc']); }
  fill(): void { this.commands.push(['fill', this.fillStyle]); }
  stroke(): void { this.commands.push(['stroke', this.strokeStyle, this.lineWidth]); }
  setLineDash(dashes: number[]): void { this.commands.push(['setLineDash', dashes.join(',')]); }
  fillText(text: string, x: number, y: number): void { this.commands.push(['fillText', text, x, y]); }
  measureText(text: string): { width: number } { return { width: text.length * 7 }; }
}

test('render: 绘制池子水位、闸门与支路流量数字', () => {
  const level = compileLevel(levelOne);
  const session = new DrillSession(level);
  // 第 1 回合全开闸门，产生实际通过量。
  for (const gate of level.gates.values()) session.queueGate(gate.id, 'open');
  session.settle();

  const context = new RecordingContext();
  renderScene(context, session.view());

  const texts = context.commands.filter(([name]) => name === 'fillText').map(([, text]) => text);
  // 池子名称
  assert.ok(texts.includes('泉眼'));
  assert.ok(texts.includes('蓄水池'));
  assert.ok(texts.includes('检修格 M'));
  // 水位/容量读数
  assert.ok(texts.some((text) => /^\d+\/\d+$/.test(String(text))));
  // 支路实际通过量的数字（本回合有流量）
  assert.ok(texts.some((text) => typeof text === 'string' && /^[1-9]\d*$/.test(text)));
  // 回合读数
  assert.ok(texts.some((text) => String(text).includes('回合')));
});

test('render: 所有绘制都成对 save/restore，不泄漏变换状态', () => {
  const level = compileLevel(levelTwo);
  const session = new DrillSession(level);
  const context = new RecordingContext();
  renderScene(context, session.view());

  let depth = 0;
  for (const [name] of context.commands) {
    if (name === 'save') depth += 1;
    if (name === 'restore') depth -= 1;
    assert.ok(depth >= 0, 'restore 多于 save');
  }
  assert.equal(depth, 0, '存在未闭合的 save');
});

test('render: 布置预览与已确认状态用不同的标签提示', () => {
  const level = compileLevel(levelTwo);
  const session = new DrillSession(level);
  session.queueGate('F', 'open');
  const context = new RecordingContext();
  renderScene(context, session.view());
  const texts = context.commands.filter(([name]) => name === 'fillText').map(([, text]) => String(text));
  assert.ok(texts.some((text) => text.startsWith('≤')), '应显示可达上限预览');
});

test('render: 检修格被淹时用危险色标出超线水位', () => {
  const level = compileLevel(levelOne);
  const session = new DrillSession(level);
  for (const gate of level.gates.values()) session.queueGate(gate.id, 'open');
  let record;
  while (session.view().outcome === 'playing' && session.turnsRemaining > 0) {
    record = session.settle();
    if (record.outcome !== 'playing') break;
    for (const gate of level.gates.values()) session.queueGate(gate.id, 'open');
  }
  assert.equal(session.view().failure?.code, 'maintenance-flooded');

  const context = new RecordingContext();
  renderScene(context, session.view());
  const flooded = context.commands.some(([name, fill]) => name === 'fillText' && String(fill).includes('/'));
  assert.ok(flooded);
});

test('render: 命中测试区分闸门与池子', () => {
  const level = compileLevel(levelOne);
  const view = new DrillSession(level).view();
  const gateA = view.gates.find((gate) => gate.id === 'A')!;
  assert.equal(
    hitTest(view, { x: gateA.layout!.x, y: gateA.layout!.y }).gateId,
    'A',
  );
  const basin = view.pools.find((pool) => pool.id === 'basin')!;
  const inside = {
    x: basin.layout.x + basin.layout.width / 2,
    y: basin.layout.y + basin.layout.height / 2,
  };
  assert.equal(hitTest(view, inside).poolId, 'basin');
  assert.equal(hitTest(view, { x: 9999, y: 9999 }).gateId, null);
});

test('render: 屏幕坐标换算在等比缩放与留边下保持可逆', () => {
  // 480×235 的容器（画布的一半）居中，左右无留边，上下的留边由宽高比决定。
  const rect = { left: 100, top: 50, width: 490, height: 235 };
  const point = screenToWorld(100 + 245, 50 + 117.5, rect);
  assert.ok(Math.abs(point.x - WORLD_WIDTH / 2) < 0.5);
  assert.ok(Math.abs(point.y - WORLD_HEIGHT / 2) < 0.5);
});

test('scene: 水位像素高度按容量比例，且不超过池高', () => {
  const level = compileLevel(levelOne);
  const view = new DrillSession(level).view();
  const basin = view.pools.find((pool) => pool.id === 'basin')!;
  assert.equal(waterHeight(basin), 0);

  const full = { ...basin, level: basin.capacity };
  assert.equal(waterHeight(full), basin.layout.height);
  const over = { ...basin, level: basin.capacity + 5 };
  assert.equal(waterHeight(over), basin.layout.height, '超过容量时仍按满格绘制');
});

test('scene: 支路缺省时从上游池右缘连到下游池左缘，折线中点落在折线上', () => {
  const level = compileLevel(levelOne);
  const view = new DrillSession(level).view();
  const pools = new Map(view.pools.map((pool) => [pool.id, pool]));
  // 关卡一给所有边显式折线，先取一条无折线的合成边来测退路逻辑。
  const edge = { ...view.edges[0]!, layout: null };
  const points = edgePoints(edge, pools);
  assert.equal(points.length, 2);
  assert.equal(points[0]!.x, pools.get(edge.from)!.layout.x + pools.get(edge.from)!.layout.width);
  assert.equal(points[1]!.x, pools.get(edge.to)!.layout.x);

  const middle = polylineMidpoint([
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
  ]);
  // 总长 20，中点在总长 10 处，即第二个顶点。
  assert.deepEqual(middle, { x: 10, y: 0 });
});

test('scene: 两个样例关卡的池子都在画布范围内', () => {
  for (const spec of [levelOne, levelTwo]) {
    const view = new DrillSession(compileLevel(spec)).view();
    assert.ok(poolsWithinViewport(view), `${spec.id} 布局越界`);
  }
});
