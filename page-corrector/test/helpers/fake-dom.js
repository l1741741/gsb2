// 极简 Fake DOM/Canvas 环境，仅用于在 Node 中引导真实的 app.js。
// Canvas 2D 上下文用 Proxy 吞掉所有绘制调用，getImageData 返回全 0 缓冲，
// 这样透视/批处理等真实数学与状态流仍在 Node 中执行。

export function installFakeDOM() {
  const storageMap = new Map();
  const localStorage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => void storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear(),
    _map: storageMap,
  };

  function makeContext(canvas) {
    const target = { canvas };
    return new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in t) return t[prop];
        if (prop === 'measureText') return () => ({ width: 42 });
        if (prop === 'getImageData') {
          return (_x, _y, w, h) => {
            const width = Math.max(1, Number(w) || 1);
            const height = Math.max(1, Number(h) || 1);
            return { width, height, data: new Uint8ClampedArray(width * height * 4) };
          };
        }
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
          return () => ({ addColorStop() {} });
        }
        return () => {};
      },
      set(t, prop, value) {
        t[prop] = value;
        return true;
      },
    });
  }

  class FakeElement {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.id = '';
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this._classes = new Set();
      this.className = '';
      this.textContent = '';
      this._innerHTML = '';
      this.width = 300;
      this.height = 150;
      this.value = '';
      this.disabled = false;
      this.checked = false;
      this.hidden = false;
      this.title = '';
      this.files = null;
      this.parentNode = null;
      this.classList = {
        add: (...cs) => cs.forEach((c) => this._classes.add(c)),
        remove: (...cs) => cs.forEach((c) => this._classes.delete(c)),
        toggle: (c, force) => {
          const has = this._classes.has(c);
          const next = force === undefined ? !has : !!force;
          if (next) this._classes.add(c);
          else this._classes.delete(c);
        },
        contains: (c) => this._classes.has(c),
      };
    }

    addEventListener(type, cb) {
      (this.listeners[type] ??= []).push(cb);
    }

    removeEventListener() {}

    dispatch(type, event = {}) {
      for (const cb of this.listeners[type] ?? []) cb(event);
    }

    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    }

    remove() {
      if (this.parentNode?.children) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      }
    }

    set innerHTML(v) {
      this._innerHTML = String(v);
      if (v === '') this.children = [];
      // 近似真实 DOM：写入 HTML 后 textContent 为去标签文本
      this.textContent = String(v)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    get innerHTML() {
      return this._innerHTML;
    }

    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
    }

    getAttribute(k) {
      return this.attributes[k] ?? null;
    }

    querySelectorAll() {
      return [];
    }

    querySelector() {
      return null;
    }

    focus() {}
    blur() {}

    getBoundingClientRect() {
      const width = this.clientWidth || (this.id === 'sourceCanvas' ? 1280 : 430) || this.width;
      const height = this.clientHeight || (this.id === 'sourceCanvas' ? 960 : 610) || this.height;
      return { left: 0, top: 0, x: 0, y: 0, right: width, bottom: height, width, height };
    }

    setPointerCapture() {}
    releasePointerCapture() {}

    getContext() {
      this._ctx ??= makeContext(this);
      return this._ctx;
    }

    toBlob(cb) {
      // 256 字节的假 PNG 容器；管线只关心 Blob 存在与 info 正确
      cb(new Blob([new Uint8Array(256)], { type: 'image/png' }));
    }
  }

  const byId = new Map();
  const body = new FakeElement('body');
  const documentFake = {
    readyState: 'complete',
    activeElement: null,
    body,
    documentElement: new FakeElement('html'),
    getElementById(id) {
      if (!byId.has(id)) {
        const el = new FakeElement('el');
        el.id = id;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => new FakeElement(tag),
    addEventListener() {},
    removeEventListener() {},
  };

  const windowListeners = {};
  const windowFake = {
    localStorage,
    addEventListener(type, cb) {
      (windowListeners[type] ??= []).push(cb);
    },
    removeEventListener() {},
    dispatch(type, event = {}) {
      for (const cb of windowListeners[type] ?? []) cb(event);
    },
    showDirectoryPicker: undefined,
    __pageCorrector: undefined,
    innerWidth: 1440,
  };

  class FakeImage {
    constructor() {
      this.naturalWidth = 1280;
      this.naturalHeight = 960;
      this.width = 1280;
      this.height = 960;
    }

    set src(value) {
      this._src = value;
      setTimeout(() => this.onload?.({ type: 'load' }), 2);
    }

    get src() {
      return this._src;
    }

    addEventListener(type, cb) {
      if (type === 'load') this.onload = cb;
    }
  }

  const RealURL = globalThis.URL;
  globalThis.window = windowFake;
  globalThis.document = documentFake;
  globalThis.localStorage = localStorage;
  globalThis.Image = FakeImage;
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  globalThis.ImageData = class ImageDataFake {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  globalThis.URL = class URLFake extends RealURL {
    static createObjectURL() {
      return `blob:fake/${Math.random().toString(36).slice(2)}`;
    }

    static revokeObjectURL() {}
  };

  return { window: windowFake, document: documentFake, localStorage, elementsById: byId };
}
