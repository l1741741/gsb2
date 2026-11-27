/* Offline poster-diff viewer. No external resources: every tile comes from
 * local JS shards injected as <script> tags (file:// safe, no fetch). */
"use strict";

(function () {
  const report = window.__PD_REPORT__;
  if (!report) {
    document.body.innerHTML = "<p style='padding:24px'>缺少 report_data.js，无法打开报告。</p>";
    return;
  }

  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  const bounds = report.geometry.canvas;
  const tileSize = report.tiles.tile_size;

  const state = {
    layer: "appearance",
    overlay: true,
    scale: 1,
    // pan offset in screen px: screen = canvas * scale + pan
    panX: 0,
    panY: 0,
    selected: null,
    kindFilter: "all",
  };

  // ------------------------------------------------------------- shard loading
  const shardLoader = {
    pending: new Map(), // key -> Promise
    cache: new Map(), // key -> dataURL
    base: "",

    key(layer, level, idx) {
      return `${layer}/${level}/${idx}`;
    },

    addShard(layer, level, entries) {
      for (const [idx, b64] of entries) {
        this.cache.set(this.key(layer, level, idx), "data:image/png;base64," + b64);
      }
      const waiters = this.pending.get(`${layer}/${level}`);
      if (waiters) {
        this.pending.delete(`${layer}/${level}`);
        for (const resolve of waiters) resolve();
      }
    },

    loadLevel(layer, level) {
      const levelInfo = report.tiles.levels[layer]?.[String(level)];
      if (!levelInfo || !levelInfo.shards.length) return Promise.resolve();
      const levelKey = `${layer}/${level}`;
      if (this.pending.has(levelKey)) {
        return new Promise((resolve) => this.pending.get(levelKey).push(resolve));
      }
      const waiters = [];
      this.pending.set(levelKey, waiters);
      for (const shard of levelInfo.shards) {
        const s = document.createElement("script");
        s.src = this.base + shard.file;
        document.head.appendChild(s);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },

    async getTile(layer, level, idx) {
      const key = this.key(layer, level, idx);
      if (this.cache.has(key)) return this.cache.get(key);
      await this.loadLevel(layer, level);
      return this.cache.get(key) || null;
    },
  };
  window.__PD__ = { addShard: (...args) => shardLoader.addShard(...args) };

  const imageCache = new Map(); // dataURL -> HTMLImageElement
  function loadImage(dataUrl) {
    if (!dataUrl) return Promise.resolve(null);
    if (imageCache.has(dataUrl)) return imageCache.get(dataUrl);
    const promise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
    imageCache.set(dataUrl, promise);
    return promise;
  }

  // ------------------------------------------------------------ viewport math
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", () => {
    resizeCanvas();
    scheduleDraw();
  });

  function viewSize() {
    return { w: canvas.clientWidth, h: canvas.clientHeight };
  }

  function fitScale() {
    const { w, h } = viewSize();
    return Math.min(w / bounds.width, h / bounds.height) * 0.96;
  }

  function fitView() {
    state.scale = fitScale();
    const { w, h } = viewSize();
    state.panX = (w - bounds.width * state.scale) / 2 - bounds.x * state.scale;
    state.panY = (h - bounds.height * state.scale) / 2 - bounds.y * state.scale;
  }

  function toScreen(x, y) {
    return [x * state.scale + state.panX, y * state.scale + state.panY];
  }

  function toCanvas(sx, sy) {
    return [(sx - state.panX) / state.scale, (sy - state.panY) / state.scale];
  }

  function levelForScale(scale) {
    // level 0 is full resolution; each level halves it.
    let level = 0;
    while (scale < 1 / (1 << (level + 1)) && level < maxLevel()) level++;
    return level;
  }

  function maxLevel() {
    const levels = report.tiles.levels[state.layer] || {};
    return Math.max(0, ...Object.keys(levels).map(Number));
  }

  // ---------------------------------------------------------------- rendering
  let drawQueued = false;
  function scheduleDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  const imageJobs = new Set();

  async function draw() {
    const { w, h } = viewSize();
    ctx.clearRect(0, 0, w, h);
    const level = Math.min(levelForScale(state.scale), maxLevel());
    const levelInfo = report.tiles.levels[state.layer]?.[String(level)];
    if (!levelInfo) return;

    const factor = 1 << level;
    const levelScale = state.scale * factor; // tile pixels -> screen px
    const cols = levelInfo.cols;
    const rows = levelInfo.rows;

    // Visible tile range.
    const [cx1, cy1] = toCanvas(0, 0);
    const [cx2, cy2] = toCanvas(w, h);
    const tx1 = Math.max(0, Math.floor((cx1 - bounds.x) / (tileSize * factor)));
    const ty1 = Math.max(0, Math.floor((cy1 - bounds.y) / (tileSize * factor)));
    const tx2 = Math.min(cols - 1, Math.ceil((cx2 - bounds.x) / (tileSize * factor)));
    const ty2 = Math.min(rows - 1, Math.ceil((cy2 - bounds.y) / (tileSize * factor)));

    for (let ty = ty1; ty <= ty2; ty++) {
      for (let tx = tx1; tx <= tx2; tx++) {
        const idx = ty * cols + tx;
        const dataUrl = await shardLoader.getTile(state.layer, level, idx);
        if (!dataUrl) continue;
        const img = await loadImage(dataUrl);
        if (!img) continue;
        const worldX = bounds.x + tx * tileSize * factor;
        const worldY = bounds.y + ty * tileSize * factor;
        const [sx, sy] = toScreen(worldX, worldY);
        const drawW = img.width * levelScale;
        const drawH = img.height * levelScale;
        if (state.layer === "appearance" || state.layer === "alpha") {
          drawMetricTile(img, sx, sy, drawW, drawH);
        } else {
          ctx.drawImage(img, sx, sy, drawW, drawH);
        }
      }
    }

    drawPlacementOutlines();
    if (state.overlay) drawBlockOverlays();
    updateHud();
  }

  function drawMetricTile(img, sx, sy, drawW, drawH) {
    // Re-color the encoded metric tile so values read as a heatmap.
    const tmp = getTempCanvas(img.width, img.height);
    const tctx = tmp.getContext("2d");
    tctx.clearRect(0, 0, img.width, img.height);
    tctx.drawImage(img, 0, 0);
    const frame = tctx.getImageData(0, 0, img.width, img.height);
    const px = frame.data;
    for (let i = 0; i < px.length; i += 4) {
      const value = px[i]; // red channel = raw 0..255 metric
      const over = px[i + 1] === 255; // green = exceeds threshold
      const coverage = px[i + 2]; // blue = coverage code
      if (coverage === 1) {
        px[i] = 46; px[i + 1] = 160; px[i + 2] = 67; px[i + 3] = 150;
      } else if (coverage === 2) {
        px[i] = 215; px[i + 1] = 58; px[i + 2] = 46; px[i + 3] = 150;
      } else if (value === 0) {
        px[i + 3] = 0;
      } else {
        // dark blue -> cyan -> yellow heat ramp
        const t = value / 255;
        px[i] = Math.round(40 + 215 * Math.min(1, t * 1.6));
        px[i + 1] = Math.round(60 + 195 * t);
        px[i + 2] = Math.round(120 * (1 - t));
        px[i + 3] = over ? 235 : 140;
      }
    }
    tctx.putImageData(frame, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, sx, sy, drawW, drawH);
  }

  const tempCanvases = new Map();
  function getTempCanvas(w, h) {
    const key = `${w}x${h}`;
    let c = tempCanvases.get(key);
    if (!c) {
      c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      tempCanvases.set(key, c);
    }
    return c;
  }

  function drawPlacementOutlines() {
    const places = [
      { r: report.geometry.reference_placement, color: "#2ea043", label: "A" },
      { r: report.geometry.candidate_placement, color: "#d73a2e", label: "B" },
    ];
    ctx.lineWidth = 2;
    ctx.font = "bold 12px sans-serif";
    for (const p of places) {
      const [sx, sy] = toScreen(p.r.x, p.r.y);
      const w = p.r.width * state.scale;
      const h = p.r.height * state.scale;
      ctx.strokeStyle = p.color;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(sx, sy, w, h);
      ctx.setLineDash([]);
      ctx.fillStyle = p.color;
      ctx.fillText(p.label, sx + 4, sy + 14);
    }
  }

  function drawBlockOverlays() {
    const drawOne = (block, color, selected) => {
      const r = block.rect;
      const [sx, sy] = toScreen(r.x, r.y);
      const w = r.width * state.scale;
      const h = r.height * state.scale;
      ctx.lineWidth = selected ? 2.5 : 1;
      ctx.strokeStyle = color;
      ctx.setLineDash(selected ? [] : [5, 4]);
      ctx.strokeRect(sx, sy, w, h);
      ctx.setLineDash([]);
      if (selected) {
        ctx.fillStyle = color + "33";
        ctx.fillRect(sx, sy, w, h);
      }
    };
    const colors = {
      appearance: "#e3b341",
      alpha: "#8b7cf6",
      both: "#ff7a45",
      reference_only: "#2ea043",
      candidate_only: "#d73a2e",
    };
    for (const b of report.diff_blocks) {
      if (state.kindFilter !== "all" && b.kind !== state.kindFilter) continue;
      drawOne(b, colors[b.kind], state.selected === b.id);
    }
    for (const b of report.coverage_blocks) {
      drawOne(b, colors[b.kind], state.selected === b.id);
    }
  }

  // ------------------------------------------------------------- interaction
  let dragging = null;
  canvas.addEventListener("mousedown", (e) => {
    dragging = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY, moved: false };
  });
  window.addEventListener("mousemove", (e) => {
    if (dragging) {
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
      state.panX = dragging.panX + dx;
      state.panY = dragging.panY + dy;
      scheduleDraw();
    }
    updateCoordReadout(e);
  });
  window.addEventListener("mouseup", (e) => {
    if (dragging && !dragging.moved) handleClick(e);
    dragging = null;
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      zoomAt(e.offsetX, e.offsetY, factor);
    },
    { passive: false }
  );

  function zoomAt(sx, sy, factor) {
    const [wx, wy] = toCanvas(sx, sy);
    state.scale = Math.min(64, Math.max(fitScale() / 8, state.scale * factor));
    state.panX = sx - wx * state.scale;
    state.panY = sy - wy * state.scale;
    scheduleDraw();
  }

  function handleClick(e) {
    const rect = canvas.getBoundingClientRect();
    const [wx, wy] = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
    const hits = [];
    for (const b of report.diff_blocks) {
      const r = b.rect;
      if (wx >= r.x && wx < r.x + r.width && wy >= r.y && wy < r.y + r.height) {
        hits.push({ id: b.id, area: b.area });
      }
    }
    for (const b of report.coverage_blocks) {
      const r = b.rect;
      if (wx >= r.x && wx < r.x + r.width && wy >= r.y && wy < r.y + r.height) {
        hits.push({ id: b.id, area: b.area });
      }
    }
    if (!hits.length) {
      state.selected = null;
    } else {
      hits.sort((a, b) => a.area - b.area);
      state.selected = hits[0].id;
    }
    renderLists();
    scheduleDraw();
  }

  function focusBlock(block) {
    state.selected = block.id;
    const r = block.rect;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const { w, h } = viewSize();
    const needed = Math.min(w / Math.max(r.width, 40), h / Math.max(r.height, 40));
    state.scale = Math.max(fitScale(), Math.min(8, needed * 0.6));
    state.panX = w / 2 - cx * state.scale;
    state.panY = h / 2 - cy * state.scale;
    renderLists();
    scheduleDraw();
  }

  function updateCoordReadout(e) {
    const rect = canvas.getBoundingClientRect();
    if (
      e.clientX < rect.left || e.clientX > rect.right ||
      e.clientY < rect.top || e.clientY > rect.bottom
    ) {
      return;
    }
    const [wx, wy] = toCanvas(e.clientX - rect.left, e.clientY - rect.top);
    const el = document.getElementById("coord-readout");
    el.textContent = `参考图坐标: ${Math.floor(wx)}, ${Math.floor(wy)}`;
  }

  function updateHud() {
    document.getElementById("zoom-readout").textContent =
      `缩放: ${(state.scale * 100).toFixed(0)}% · 层级 L${levelForScale(state.scale)}`;
  }

  // ------------------------------------------------------------------ sidebar
  const LAYER_HINTS = {
    appearance: "红通道编码外观差值（在配置底色上合成后比较）；绿色描边为超阈值像素。完全透明像素的隐藏颜色不计入。",
    alpha: "仅比较 alpha 通道差值；绿色描边为超过 alpha 阈值的像素。",
    coverage: "绿色=仅参考图 A 覆盖，红色=仅候选图 B 覆盖（含错位产生的单边条带）。",
    ref: "参考图 A 按偏移放置到共享画布，棋盘格表示透明区域。",
    cand: "候选图 B 按偏移放置到共享画布，棋盘格表示透明区域。",
  };

  function initSidebar() {
    document.getElementById("report-title").textContent = report.title;
    document.getElementById("report-meta").textContent =
      `${report.inputs.reference.width}×${report.inputs.reference.height} vs ` +
      `${report.inputs.candidate.width}×${report.inputs.candidate.height} · ` +
      `偏移 (${report.config.offset_x}, ${report.config.offset_y}) · ${report.generated_at}`;

    document.getElementById("layer-hint").textContent = LAYER_HINTS[state.layer];
    for (const btn of document.querySelectorAll("#layer-buttons button")) {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#layer-buttons button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.layer = btn.dataset.layer;
        document.getElementById("layer-hint").textContent = LAYER_HINTS[state.layer];
        updateLegend();
        scheduleDraw();
      });
    }
    document.getElementById("overlay-toggle").addEventListener("change", (e) => {
      state.overlay = e.target.checked;
      scheduleDraw();
    });
    document.getElementById("kind-filter").addEventListener("change", (e) => {
      state.kindFilter = e.target.value;
      renderLists();
      scheduleDraw();
    });

    document.getElementById("zoom-in").addEventListener("click", () => {
      const { w, h } = viewSize();
      zoomAt(w / 2, h / 2, 1.3);
    });
    document.getElementById("zoom-out").addEventListener("click", () => {
      const { w, h } = viewSize();
      zoomAt(w / 2, h / 2, 1 / 1.3);
    });
    document.getElementById("zoom-fit").addEventListener("click", () => {
      fitView();
      scheduleDraw();
    });
    document.getElementById("zoom-one").addEventListener("click", () => {
      const { w, h } = viewSize();
      const [cx, cy] = toCanvas(w / 2, h / 2);
      state.scale = 1;
      state.panX = w / 2 - cx;
      state.panY = h / 2 - cy;
      scheduleDraw();
    });

    document.getElementById("thumb-ref").src = "assets/ref_overview.png";
    document.getElementById("thumb-cand").src = "assets/cand_overview.png";

    renderSummary();
    renderLists();
    updateLegend();
  }

  function renderSummary() {
    const c = report.counts;
    const cfg = report.config;
    const rows = [
      ["共享画布", `${c.canvas_width} × ${c.canvas_height}`],
      ["共有区域像素", c.common_area.toLocaleString()],
      ["仅 A 覆盖像素", c.reference_only_area.toLocaleString()],
      ["仅 B 覆盖像素", c.candidate_only_area.toLocaleString()],
      ["外观超阈值像素", c.changed_appearance_pixels.toLocaleString()],
      ["透明度超阈值像素", c.changed_alpha_pixels.toLocaleString()],
      ["平均外观差异", c.mean_appearance_diff],
      ["平均 alpha 差异", c.mean_alpha_diff],
      ["外观 / alpha 阈值", `${cfg.appearance_threshold} / ${cfg.alpha_threshold}`],
      ["归并间距 / 连通", `${cfg.merge_gap}px / ${cfg.connectivity}-连通`],
      ["合成底色", "#" + cfg.background.map((v) => v.toString(16).padStart(2, "0")).join("")],
    ];
    document.getElementById("summary-table").innerHTML = rows
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
      .join("");
  }

  const KIND_LABEL = {
    appearance: "外观",
    alpha: "透明度",
    both: "外观+透明度",
    reference_only: "仅 A 覆盖",
    candidate_only: "仅 B 覆盖",
  };

  function blockItem(block, isCoverage) {
    const r = block.rect;
    const selected = state.selected === block.id ? " selected" : "";
    const peak = isCoverage
      ? ""
      : `<div class="bi-meta">峰值 外观 ${block.peak_appearance} · alpha ${block.peak_alpha}</div>`;
    const div = document.createElement("div");
    div.className = `block-item kind-${block.kind}${selected}`;
    div.innerHTML =
      `<div class="bi-title"><span>${block.id} · ${KIND_LABEL[block.kind]}</span>` +
      `<span>${block.area.toLocaleString()}px</span></div>` +
      `<div class="bi-meta">矩形 (${r.x}, ${r.y}) ${r.width}×${r.height}</div>` +
      peak;
    div.addEventListener("click", () => focusBlock(block));
    return div;
  }

  function renderLists() {
    const diffList = document.getElementById("block-list");
    diffList.innerHTML = "";
    let shown = 0;
    for (const b of report.diff_blocks) {
      if (state.kindFilter !== "all" && b.kind !== state.kindFilter) continue;
      diffList.appendChild(blockItem(b, false));
      shown++;
    }
    document.getElementById("diff-count").textContent = shown;

    const covList = document.getElementById("coverage-list");
    covList.innerHTML = "";
    for (const b of report.coverage_blocks) {
      covList.appendChild(blockItem(b, true));
    }
    document.getElementById("coverage-count").textContent = report.coverage_blocks.length;
  }

  function updateLegend() {
    const legends = {
      appearance: [
        ["#2c5aa0", "低外观差异"],
        ["#e3b341", "高外观差异"],
        ["#2ea043", "仅 A 覆盖"],
        ["#d73a2e", "仅 B 覆盖"],
      ],
      alpha: [
        ["#4a3f8f", "低 alpha 差异"],
        ["#8b7cf6", "高 alpha 差异"],
        ["#2ea043", "仅 A 覆盖"],
        ["#d73a2e", "仅 B 覆盖"],
      ],
      coverage: [
        ["#2ea043", "仅参考图 A 覆盖"],
        ["#d73a2e", "仅候选图 B 覆盖"],
      ],
      ref: [["#2ea043", "参考图 A 边界（虚线）"]],
      cand: [["#d73a2e", "候选图 B 边界（虚线）"]],
    };
    document.getElementById("legend").innerHTML = (legends[state.layer] || [])
      .map(
        ([color, label]) =>
          `<div class="legend-row"><span class="legend-swatch" style="background:${color}"></span>${label}</div>`
      )
      .join("");
  }

  // -------------------------------------------------------------------- boot
  resizeCanvas();
  initSidebar();
  fitView();
  scheduleDraw();
})();
