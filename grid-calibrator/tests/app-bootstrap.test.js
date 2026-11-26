import test from 'node:test';
import assert from 'node:assert/strict';

// A small DOM/Canvas smoke harness. It does not verify pixels; it ensures the
// browser entry module wires every control and initial render without a typo.
function installMockDom() {
  const listeners = new Map();
  const elements = new Map();

  const ctx = new Proxy({}, {
    get(target, property) {
      if (property === 'measureText') return () => ({ width: 12 });
      if (property === 'getImageData') {
        return (_x, _y, width, height) => {
          const data = new Uint8ClampedArray(width * height * 4).fill(255);
          return { data, width, height };
        };
      }
      if (property in target) return target[property];
      return () => {};
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });

  function makeElement(id = 'element') {
    const elementListeners = {};
    return {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      hidden: false,
      width: 1200,
      height: 800,
      files: [],
      options: [],
      style: {},
      dataset: {},
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains() { return false; },
      },
      addEventListener(type, handler) {
        (elementListeners[type] ??= []).push(handler);
      },
      removeEventListener() {},
      dispatchEvent() { return true; },
      appendChild(child) {
        this.options.push(child);
        return child;
      },
      remove() {},
      click() {
        for (const handler of elementListeners.click ?? []) handler({ target: this });
      },
      setAttribute() {},
      getAttribute() { return null; },
      closest() { return null; },
      querySelector() { return makeElement(`${id}-child`); },
      querySelectorAll() { return []; },
      getContext() { return ctx; },
      getBoundingClientRect() {
        return { width: 1200, height: 800, left: 0, top: 0, right: 1200, bottom: 800 };
      },
      toDataURL() { return 'data:image/png;base64,mock'; },
      hasPointerCapture() { return false; },
      setPointerCapture() {},
      releasePointerCapture() {},
      _listeners: elementListeners,
    };
  }

  const documentMock = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return makeElement('query'); },
    createElement(tag) { return makeElement(`created-${tag}`); },
    body: makeElement('body'),
  };

  globalThis.window = globalThis;
  globalThis.document = documentMock;
  globalThis.devicePixelRatio = 1;
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = 960;
      this.naturalHeight = 720;
    }
    set src(value) {
      this._src = value;
      setTimeout(() => this.onload?.(), 0);
    }
    get src() { return this._src; }
  };
  globalThis.ImageData = class {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  globalThis.HTMLCanvasElement = class {};
  globalThis.URL.createObjectURL = () => 'blob:mock';
  globalThis.URL.revokeObjectURL = () => {};

  return { elements, listeners };
}

test('app bootstrap wires the page, generates the sample, and fits', async () => {
  const harness = installMockDom();
  await import('../src/app.js');
  await assert.doesNotReject(async () => {
    harness.elements.get('sampleCalibrationBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(harness.elements.get('fitStatus').className, /status-ok/);

  harness.elements.get('sampleCheckBtn').click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const warpStatsHtml = harness.elements.get('warpStats').innerHTML;
  assert.match(warpStatsHtml, /输出[\s\S]*\d+×\d+/);
  assert.match(warpStatsHtml, /有效矩形/);

  // Result views must support drag-pan as well as wheel zoom.
  const stage = harness.elements.get('stage');
  const pointerEvent = {
    pointerId: 7,
    clientX: 120,
    clientY: 140,
    preventDefault() {},
  };
  assert.doesNotThrow(() => {
    stage._listeners.pointerdown[0](pointerEvent);
    stage._listeners.pointermove[0]({ ...pointerEvent, clientX: 160, clientY: 170 });
    stage._listeners.pointerup[0]({ pointerId: 7 });
  });
});
