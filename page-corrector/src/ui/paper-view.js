// 纸面视图：显示透视校正后的纸面预览，负责画保留区/遮挡区、
// 选择/拖动区域、联动标记与核对点。覆盖物全部使用纸面归一化坐标。

import { normalizeRectDrag } from '../core/regions.js';

const MIN_REGION = 0.012;

export class PaperView {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks;
    this.vm = null;
    this.frameCanvas = null;
    this.ui = {
      tool: 'pan', // 'pan' | 'keep' | 'mask'
      draft: null, // {type,rect}
      dragRegion: null, // {id, grabDX, grabDY, moved}
      linkedMarker: null,
      pinnedMarker: null,
      hoverRegionId: null,
    };
    this.#bindEvents();
  }

  #bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.#onDown(e));
    c.addEventListener('pointermove', (e) => this.#onMove(e));
    window.addEventListener('pointerup', (e) => this.#onUp(e));
    c.addEventListener('pointerleave', () => {
      if (!this.ui.dragRegion && !this.ui.draft) this.hooks.onHoverPaper?.(null);
    });
  }

  setTool(tool) {
    this.ui.tool = tool;
    this.canvas.style.cursor = tool === 'pan' ? 'default' : 'crosshair';
    if (tool === 'pan') this.ui.draft = null;
    this.render();
  }

  /** app 完成一次透视预览后传入离屏 canvas（尺寸即 backing）。 */
  setFrameCanvas(frame) {
    this.frameCanvas = frame;
    if (frame) {
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
    }
    this.render();
  }

  setLinkedMarker(p) {
    this.ui.linkedMarker = p;
  }

  setPinnedMarker(p) {
    this.ui.pinnedMarker = p;
  }

  toNorm(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  #hitRegion(p, regions) {
    for (let i = regions.length - 1; i >= 0; i -= 1) {
      const r = regions[i];
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r;
    }
    return null;
  }

  #onDown(e) {
    if (!this.vm) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.toNorm(e);

    if (this.ui.tool === 'keep' || this.ui.tool === 'mask') {
      this.ui.draft = { type: this.ui.tool, start: p, rect: { x: p.x, y: p.y, w: 0, h: 0 } };
      this.render();
      return;
    }

    const region = this.#hitRegion(p, this.vm.regions ?? []);
    if (region) {
      this.hooks.onSelectRegion?.(region.id);
      this.ui.dragRegion = {
        id: region.id,
        grabDX: p.x - region.x,
        grabDY: p.y - region.y,
        moved: false,
      };
    } else {
      this.ui.pinnedMarker = p;
      this.hooks.onPinPaper?.(p);
      this.hooks.onSelectRegion?.(null);
      this.render();
    }
  }

  #onMove(e) {
    if (!this.vm) return;
    const p = this.toNorm(e);

    if (this.ui.draft) {
      const s = this.ui.draft.start;
      this.ui.draft.rect = normalizeRectDrag(s.x, s.y, p.x, p.y);
      this.render();
      return;
    }

    if (this.ui.dragRegion) {
      const d = this.ui.dragRegion;
      const rect = this.vm.regions.find((r) => r.id === d.id);
      if (rect) {
        let nx = p.x - d.grabDX;
        let ny = p.y - d.grabDY;
        nx = Math.min(1 - rect.w, Math.max(0, nx));
        ny = Math.min(1 - rect.h, Math.max(0, ny));
        if (Math.abs(nx - rect.x) + Math.abs(ny - rect.y) > 0.001) d.moved = true;
        this.hooks.onMoveRegion?.(d.id, nx, ny);
        this.vm = this.hooks.getVM?.() ?? this.vm;
        this.render();
      }
      return;
    }

    const hit = this.#hitRegion(p, this.vm.regions ?? []);
    this.ui.hoverRegionId = hit?.id ?? null;
    this.canvas.style.cursor = hit ? 'move' : this.ui.tool === 'pan' ? 'default' : 'crosshair';
    this.hooks.onHoverPaper?.(p);
    this.render();
  }

  #onUp() {
    if (this.ui.draft) {
      const rect = this.ui.draft.rect;
      const type = this.ui.draft.type;
      this.ui.draft = null;
      if (rect.w >= MIN_REGION && rect.h >= MIN_REGION) {
        this.hooks.onRegionDrawn?.({ type, ...rect });
        this.ui.tool = 'pan';
        this.hooks.onToolCommitted?.('pan');
      }
      this.render();
    }
    if (this.ui.dragRegion) {
      const moved = this.ui.dragRegion.moved;
      this.ui.dragRegion = null;
      this.hooks.onRegionCommit?.(moved);
    }
  }

  update(vm) {
    this.vm = vm;
    this.render();
  }

  render() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.frameCanvas) {
      ctx.drawImage(this.frameCanvas, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#64748b';
      ctx.font = `${Math.round(w / 28)}px ui-sans-serif, system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText('添加图片或生成示例后，这里显示校正纸面', w / 2, h / 2);
      ctx.textAlign = 'left';
    }

    if (!this.vm) return;

    // 区域
    for (const r of this.vm.regions ?? []) {
      const selected = r.id === this.vm.selectedRegionId || r.id === this.ui.hoverRegionId;
      const isMask = r.type === 'mask';
      const x = r.x * w;
      const y = r.y * h;
      const rw = r.w * w;
      const rh = r.h * h;
      ctx.fillStyle = isMask ? 'rgba(239,68,68,0.28)' : 'rgba(34,197,94,0.20)';
      ctx.fillRect(x, y, rw, rh);
      ctx.lineWidth = selected ? 3 : 2;
      ctx.strokeStyle = isMask ? '#f87171' : '#4ade80';
      ctx.setLineDash(selected ? [] : [8, 5]);
      ctx.strokeRect(x + 1, y + 1, rw - 2, rh - 2);
      ctx.setLineDash([]);

      const label = `${isMask ? '遮挡' : '保留'} ${r.label || r.id.slice(-4)}`;
      ctx.font = `${Math.max(12, Math.round(w / 55))}px ui-sans-serif, system-ui`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x, Math.max(0, y - 24), tw + 12, 22);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 6, Math.max(11, y - 13));
      ctx.textBaseline = 'alphabetic';
    }

    // 正在拖的新框
    if (this.ui.draft) {
      const r = this.ui.draft.rect;
      const isMask = this.ui.draft.type === 'mask';
      ctx.fillStyle = isMask ? 'rgba(239,68,68,0.30)' : 'rgba(34,197,94,0.24)';
      ctx.fillRect(r.x * w, r.y * h, r.w * w, r.h * h);
      ctx.strokeStyle = isMask ? '#ef4444' : '#22c55e';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x * w, r.y * h, r.w * w, r.h * h);
      ctx.fillStyle = '#fff';
      ctx.font = '13px ui-monospace, Menlo, monospace';
      ctx.fillText(
        `(${r.x.toFixed(3)},${r.y.toFixed(3)}) ${r.w.toFixed(3)}×${r.h.toFixed(3)}`,
        r.x * w + 6,
        Math.max(14, r.y * h - 8),
      );
    }

    // 真值核对点（纸面已知坐标）与用户映射结果
    if (this.vm.showTruth) {
      for (const oc of this.vm.checkpointOverlays ?? []) {
        const cp = oc.cp;
        const x = cp.paper.x * w;
        const y = cp.paper.y * h;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#38bdf8';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#082f49';
        ctx.stroke();
        if (oc.userPaper) {
          const ux = oc.userPaper.x * w;
          const uy = oc.userPaper.y * h;
          ctx.strokeStyle = '#fb923c';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(ux, uy);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(ux - 6, uy - 6);
          ctx.lineTo(ux + 6, uy + 6);
          ctx.moveTo(ux + 6, uy - 6);
          ctx.lineTo(ux - 6, uy + 6);
          ctx.strokeStyle = '#fb923c';
          ctx.stroke();
        }
        ctx.fillStyle = '#e0f2fe';
        ctx.font = '12px ui-monospace, Menlo, monospace';
        ctx.fillText(`P${oc.index + 1}`, x + 10, y - 8);
      }
    }

    // 联动标记
    const marker = this.ui.pinnedMarker ?? this.ui.linkedMarker;
    if (marker) {
      const x = marker.x * w;
      const y = marker.y * h;
      ctx.strokeStyle = '#fde047';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 16, y);
      ctx.lineTo(x - 5, y);
      ctx.moveTo(x + 5, y);
      ctx.lineTo(x + 16, y);
      ctx.moveTo(x, y - 16);
      ctx.lineTo(x, y - 5);
      ctx.moveTo(x, y + 5);
      ctx.lineTo(x, y + 16);
      ctx.stroke();
    }
  }
}
