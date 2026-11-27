/* Minimal DOM/Canvas stub to execute viewer/app.js under Node.
 * It is not a browser: it verifies runtime wiring (shard loading, tile
 * selection math, block focus/click, sidebar rendering) rather than pixels.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const reportDir = process.argv[2];
if (!reportDir) {
  console.error("usage: node viewer_smoke.js <report_dir>");
  process.exit(2);
}

// -------------------------------------------------------------------- stubs
const elements = {};
function makeEl(id) {
  const listeners = {};
  const el = {
    id,
    style: {},
    dataset: {},
    className: "",
    innerHTML: "",
    textContent: "",
    checked: true,
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    parentElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getContext: () => ctxStub,
    appendChild(child) {
      this.children = this.children || [];
      this.children.push(child);
      // Simulate synchronous shard script execution.
      if (child.tagName === "SCRIPT" && child.src) {
        const rel = child.src.replace("file://", "").replace(reportDir + "/", "");
        const code = fs.readFileSync(path.join(reportDir, rel), "utf-8");
        new Function(code)();
      }
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners[type] || []) fn(event);
    },
  };
  return el;
}

const ctxStub = {
  setTransform() {},
  clearRect() {},
  drawImage() {},
  fillRect() {},
  strokeRect() {},
  fillText() {},
  getImageData: (x, y, w, h) => ({
    data: new Uint8ClampedArray(w * h * 4).fill(10),
  }),
  putImageData() {},
  set lineWidth(v) {},
  set strokeStyle(v) {},
  set fillStyle(v) {},
  set font(v) {},
  set lineDash(v) {},
  set imageSmoothingEnabled(v) {},
  setLineDash() {},
};

const staticIds = [
  "map", "report-title", "report-meta", "layer-hint", "overlay-toggle",
  "kind-filter", "zoom-in", "zoom-out", "zoom-fit", "zoom-one",
  "thumb-ref", "thumb-cand", "summary-table", "block-list", "diff-count",
  "coverage-list", "coverage-count", "coord-readout", "zoom-readout", "legend",
];
for (const id of staticIds) elements[id] = makeEl(id);

const windowListeners = {};
global.window = {
  devicePixelRatio: 1,
  addEventListener(type, fn) {
    (windowListeners[type] = windowListeners[type] || []).push(fn);
  },
  dispatch(type, event) {
    for (const fn of windowListeners[type] || []) fn(event);
  },
  __PD__: null,
};
global.document = {
  body: makeEl("body"),
  head: makeEl("head"),
  getElementById: (id) => elements[id] || (elements[id] = makeEl(id)),
  querySelectorAll: () => [],
  createElement: (tag) => ({ tagName: tag, ...makeEl("created-" + tag) }),
};
global.requestAnimationFrame = (fn) => fn();

global.window.__PD_REPORT__ = JSON.parse(
  fs.readFileSync(path.join(reportDir, "report_data.js"), "utf-8")
    .replace("window.__PD_REPORT__ = ", "")
    .replace(/;\s*$/, "")
);

// --------------------------------------------------------------------- run
const appCode = fs.readFileSync(
  path.join(__dirname, "..", "poster_diff", "viewer", "app.js"), "utf-8"
);
new Function(appCode)();

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
};

setImmediate(async () => {
  // Give microtasks (shard/Image loads) a chance to run.
  await new Promise((r) => setTimeout(r, 50));

  const report = window.__PD_REPORT__;
  assert(elements["report-title"].textContent === report.title, "title rendered");
  assert(elements["summary-table"].innerHTML.includes("共享画布"), "summary rendered");
  assert(
    (elements["block-list"].children || []).length === report.diff_blocks.length,
    "one list item per diff block"
  );
  assert(
    (elements["coverage-list"].children || []).length ===
      report.coverage_blocks.length,
    "one list item per coverage block"
  );

  // Shard cache populated for the overview level used at fit scale.
  const cache = window.__PD__; // addShard exists; inspect via loaded script count
  assert(typeof cache.addShard === "function", "shard API registered");

  // Clicking a list item focuses the block (no throw = wiring OK).
  const firstItem = elements["block-list"].children[0];
  firstItem.dispatch("click", {});

  // Canvas drag + click hit-testing path (mousedown on canvas, mouseup on
  // window, no movement => treated as a click).
  const map = elements["map"];
  map.dispatch("mousedown", { clientX: 10, clientY: 10 });
  window.dispatch("mousemove", { clientX: 12, clientY: 11 });
  window.dispatch("mouseup", {
    clientX: 10,
    clientY: 10,
  });

  // Wheel zoom path.
  map.dispatch("wheel", { deltaY: -100, preventDefault() {}, offsetX: 5, offsetY: 6 });

  console.log("viewer smoke OK:",
    report.diff_blocks.length, "diff blocks,",
    report.coverage_blocks.length, "coverage blocks,",
    Object.keys(report.tiles.levels).length, "layers");
});
