import test from 'node:test';
import assert from 'node:assert/strict';
import { circle, group, rectangle, sprite } from '../src/scene.js';
import { CanvasRenderer } from '../src/renderer.js';

class RecordingContext {
  constructor(width = 320, height = 180) {
    this.canvas = { width, height };
    this.commands = [];
    this._stack = [];
    this._globalAlpha = 1;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
  }

  get globalAlpha() { return this._globalAlpha; }
  set globalAlpha(value) {
    this._globalAlpha = value;
    this.commands.push(['globalAlpha', value]);
  }

  save() {
    this._stack.push({
      globalAlpha: this._globalAlpha,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
    });
    this.commands.push(['save']);
  }

  restore() {
    const state = this._stack.pop();
    if (!state) throw new Error('restore without save');
    Object.assign(this, {
      _globalAlpha: state.globalAlpha,
      fillStyle: state.fillStyle,
      strokeStyle: state.strokeStyle,
      lineWidth: state.lineWidth,
    });
    this.commands.push(['restore']);
  }

  translate(x, y) { this.commands.push(['translate', x, y]); }
  rotate(angle) { this.commands.push(['rotate', angle]); }
  scale(x, y) { this.commands.push(['scale', x, y]); }
  clearRect(x, y, width, height) { this.commands.push(['clearRect', x, y, width, height]); }
  fillRect(x, y, width, height) { this.commands.push(['fillRect', this.fillStyle, x, y, width, height, this.globalAlpha]); }
  strokeRect(x, y, width, height) { this.commands.push(['strokeRect', this.strokeStyle, x, y, width, height, this.lineWidth]); }
  beginPath() { this.commands.push(['beginPath']); }
  arc(x, y, radius, start, end) { this.commands.push(['arc', x, y, radius, start, end]); }
  fill() { this.commands.push(['fill', this.fillStyle, this.globalAlpha]); }
  stroke() { this.commands.push(['stroke', this.strokeStyle, this.lineWidth]); }
  drawImage(...args) { this.commands.push(['drawImage', ...args]); }
}

test('renders children in ascending z order and preserves insertion order for ties', () => {
  const context = new RecordingContext();
  const scene = group({ children: [
    rectangle({ width: 10, height: 10, fill: 'late', zIndex: 3 }),
    rectangle({ width: 10, height: 10, fill: 'first', zIndex: 1 }),
    rectangle({ width: 10, height: 10, fill: 'tie-a', zIndex: 2 }),
    rectangle({ width: 10, height: 10, fill: 'tie-b', zIndex: 2 }),
  ] });

  new CanvasRenderer(context).render(scene);

  assert.deepEqual(
    context.commands.filter(([name]) => name === 'fillRect').map(([, fill]) => fill),
    ['first', 'tie-a', 'tie-b', 'late'],
  );
});

test('applies nested position, rotation, scale, and opacity to descendants', () => {
  const context = new RecordingContext();
  const scene = group({ x: 12, y: 18, rotation: Math.PI / 4, scaleX: 2, scaleY: 3, opacity: 0.5,
    children: [rectangle({ width: 8, height: 6, fill: '#f00', x: 4, y: 5, opacity: 0.4 })],
  });

  new CanvasRenderer(context).render(scene, { clear: false });

  assert.ok(context.commands.some((command) => command[0] === 'translate' && command[1] === 12 && command[2] === 18));
  assert.ok(context.commands.some((command) => command[0] === 'rotate' && command[1] === Math.PI / 4));
  assert.ok(context.commands.some((command) => command[0] === 'scale' && command[1] === 2 && command[2] === 3));
  assert.ok(context.commands.some((command) => command[0] === 'fillRect' && command[1] === '#f00' && command.at(-1) === 0.2));
});

test('does not draw invisible nodes or their descendants', () => {
  const context = new RecordingContext();
  const scene = group({ children: [
    group({ visible: false, children: [rectangle({ width: 5, height: 5, fill: 'hidden' })] }),
    circle({ radius: 3, fill: 'visible' }),
  ] });

  new CanvasRenderer(context).render(scene, { clear: false });

  assert.deepEqual(context.commands.filter(([name]) => name === 'fillRect'), []);
  assert.ok(context.commands.some(([name]) => name === 'arc'));
  assert.ok(context.commands.some((command) => command[0] === 'fill' && command[1] === 'visible'));
});

test('draws circles and sprites using their declared local dimensions and source rectangle', () => {
  const context = new RecordingContext();
  const image = { width: 64, height: 32 };
  const scene = group({ children: [
    circle({ x: 10, y: 11, radius: 7, fill: '#0f0', stroke: '#030', lineWidth: 2 }),
    sprite({ image, source: { x: 16, y: 8, width: 12, height: 10 }, width: 24, height: 20, x: 30, y: 40 }),
  ] });

  new CanvasRenderer(context).render(scene, { clear: false });

  assert.ok(context.commands.some((command) => command[0] === 'arc' && command[1] === 0 && command[2] === 0 && command[3] === 7));
  assert.ok(context.commands.some((command) => command[0] === 'drawImage' && command[1] === image && command.slice(2).join(',') === '16,8,12,10,0,0,24,20'));
});

test('clears the requested viewport before drawing', () => {
  const context = new RecordingContext(640, 360);
  const scene = group();

  new CanvasRenderer(context).render(scene, { width: 400, height: 240 });

  assert.deepEqual(context.commands[0], ['clearRect', 0, 0, 400, 240]);
});

test('rejects invalid dimensions and non-finite transforms', () => {
  assert.throws(() => rectangle({ width: -1, height: 2 }), /width/);
  assert.throws(() => circle({ radius: -2 }), /radius/);
  assert.throws(() => group({ x: Number.NaN }), /x/);
});
