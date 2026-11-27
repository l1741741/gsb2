// 源图视图：绘制原图、四角控制柄、四边形、区域投影、真值核对点与联动标记。
// 坐标一律使用「源图像素」作为世界坐标，按 backing 缩放绘制，CSS 尺寸负责响应式。

import { CORNER_LABELS } from '../core/geometry.js';

const HANDLE_CSS = 15;

export class SourceView {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks;
    this.page = null;
    this.vm = null;
    this.ui = {
      hoverCorner: -1,
      dragIndex: -1,
      rejectGhost: null, // {index,x,y,badCorners}
      linkedMarker: null,
      pinnedMarker: null,
      pointer: null,
      moved: false,
      downPoint: null,
    };
    this.#bindEvents();
  }

  #bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.#onDown(e));
    c.addEventListener('pointermove', (e) => this.#onMove(e));
    window.addEventListener('pointerup', (e) => this.#onUp(e));
    c.addEventListener('pointerleave', () => {
      this.ui.pointer = null;
      if (this.ui.dragIndex === -1) {
        this.hooks.onHoverSource?.(null);
        this.render();
      }
    });
  }

  /** 切换页面时重置瞬时状态并调整 backing 尺寸。 */
  setPage(page) {
    this.page = page;
    this.ui = {
      hoverCorner: -1,
      dragIndex: -1,
      rejectGhost: null,
      linkedMarker: null,
      pinnedMarker: null,
      pointer: null,
      moved: false,
      downPoint: null,
    };
    if (page) {
      const maxBacking = 1600;
      const k = Math.min(1, maxBacking / Math.max(page.width, page.height));
      c_width(this.canvas, Math.max(1, Math.round(page.width * k)), Math.max(1, Math.round(page.height * k)));
    }
  }

  setLinkedMarker(p) {
    this.ui.linkedMarker = p;
  }

  setPinnedMarker(p) {
    this.ui.pinnedMarker = p;
  }

  toNatural(event) {
    const rect = this.canvas.getBoundingClientRect();
    const w = this.page?.width ?? this.canvas.width;
    const h = this.page?.height ?? this.canvas.height;
    return {
      x: ((event.clientX - rect.left) / rect.width) * w,
      y: ((event.clientY - rect.top) / rect.height) * h,
    };
  }

  #metrics() {
    const nw = this.page?.width ?? this.canvas.width;
    const rectW = this.canvas.getBoundingClientRect().width || this.canvas.width;
    const screenPerNatural = rectW / nw;
    const unit = 1 / screenPerNatural; // 1 CSS px 对应的自然坐标长度
    return {
      nw,
      nh: this.page?.height ?? this.canvas.height,
      unit,
      handleR: HANDLE_CSS * unit,
      hitR: 20 * unit,
      lineW: 2 * unit,
      font: `${13 * unit}px ui-sans-serif, system-ui, sans-serif`,
    };
  }

  #hitCorner(p, cornersPx) {
    const m = this.#metrics();
    for (let i = 0; i < 4; i += 1) {
      if (Math.hypot(cornersPx[i].x - p.x, cornersPx[i].y - p.y) <= m.hitR) return i;
    }
    return -1;
  }

  #onDown(e) {
    if (!this.page || !this.vm) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.toNatural(e);
    const corner = this.#hitCorner(p, this.vm.cornersPx);
    this.ui.downPoint = p;
    this.ui.moved = false;
    if (corner !== -1) {
      this.ui.dragIndex = corner;
      this.ui.rejectGhost = null;
      this.canvas.style.cursor = 'grabbing';
    }
    this.render();
  }

  #onMove(e) {
    if (!this.page || !this.vm) return;
    const p = this.toNatural(e);
    this.ui.pointer = p;
    if (this.ui.downPoint && Math.hypot(p.x - this.ui.downPoint.x, p.y - this.ui.downPoint.y) > 3) {
      this.ui.moved = true;
    }

    if (this.ui.dragIndex !== -1) {
      const index = this.ui.dragIndex;
      const result = this.hooks.tryCorner?.(index, p);
      if (result?.accepted) {
        this.ui.rejectGhost = null;
        this.vm = this.hooks.getVM?.() ?? this.vm;
      } else {
        this.ui.rejectGhost = {
          index,
          x: p.x,
          y: p.y,
          badCorners: result?.badCorners ?? [index],
        };
        if (result?.message) this.hooks.onReject?.(result);
      }
      this.render();
      return;
    }

    const hover = this.#hitCorner(p, this.vm.cornersPx);
    if (hover !== this.ui.hoverCorner) {
      this.ui.hoverCorner = hover;
      this.canvas.style.cursor = hover === -1 ? 'crosshair' : 'grab';
      this.render();
    }
    this.hooks.onHoverSource?.(p);
  }

  #onUp(e) {
    if (this.ui.dragIndex !== -1) {
      this.ui.dragIndex = -1;
      this.canvas.style.cursor = 'crosshair';
      this.hooks.onCornerCommit?.();
      this.render();
      return;
    }
    if (this.ui.downPoint && !this.ui.moved && this.page) {
      const p = this.toNatural(e);
      this.ui.pinnedMarker = p;
      this.hooks.onPinSource?.(p);
      this.render();
    }
    this.ui.downPoint = null;
  }

  update(vm) {
    this.vm = vm;
    this.render();
  }

  render() {
    const { ctx, canvas } = this;
    const vm = this.vm;
    if (!vm || !this.page) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const nw = this.page.width;
    const nh = this.page.height;
    const backingScale = canvas.width / nw;
    const m = this.#metrics();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(backingScale, 0, 0, backingScale, 0, 0);

    // 原图
    ctx.drawImage(this.page.image, 0, 0, nw, nh);

    const corners = vm.cornersPx;

    // 四边形外压暗
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, nw, nh);
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i += 1) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(8, 12, 18, 0.52)';
    ctx.fill('evenodd');
    ctx.restore();

    // 区域投影
    for (const item of vm.regionQuads ?? []) {
      const r = item.region;
      const q = item.quad;
      const isMask = r.type === 'mask';
      ctx.beginPath();
      ctx.moveTo(q[0].x, q[0].y);
      q.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = isMask ? 'rgba(239, 68, 68, 0.22)' : 'rgba(34, 197, 94, 0.18)';
      ctx.fill();
      ctx.lineWidth = m.lineW * 1.6;
      ctx.setLineDash([8 * m.unit, 5 * m.unit]);
      ctx.strokeStyle = isMask ? '#ef4444' : '#22c55e';
      ctx.stroke();
      ctx.setLineDash([]);
      const labelPos = q[0];
      ctx.font = m.font;
      const text = isMask ? `遮挡 ${r.label || r.id}` : `保留 ${r.label || r.id}`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.66)';
      ctx.fillRect(labelPos.x, labelPos.y - 22 * m.unit, tw + 12 * m.unit, 20 * m.unit);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, labelPos.x + 6 * m.unit, labelPos.y - 12 * m.unit);
      ctx.textBaseline = 'alphabetic';
    }

    // 真值四角与核对点
    if (vm.showTruth && vm.truth) {
      const t = vm.truth;
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = m.lineW;
      ctx.setLineDash([10 * m.unit, 6 * m.unit]);
      ctx.beginPath();
      t.cornersPixels.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      for (const cp of t.checkpoints) {
        drawDiamond(ctx, cp.source.x, cp.source.y, 8 * m.unit, '#38bdf8');
      }
      // 用户四角投影出的核对点（橙色），与真值连线显示偏差
      for (const oc of vm.userCheckpoints ?? []) {
        if (oc.userSource) {
          ctx.strokeStyle = 'rgba(251, 146, 60, 0.9)';
          ctx.lineWidth = m.lineW;
          ctx.beginPath();
          ctx.moveTo(oc.cp.source.x, oc.cp.source.y);
          ctx.lineTo(oc.userSource.x, oc.userSource.y);
          ctx.stroke();
          drawCross(ctx, oc.userSource.x, oc.userSource.y, 7 * m.unit, '#fb923c', m.lineW * 1.6);
        }
      }
      ctx.restore();
    }

    // 四角连线
    const bad = new Set(vm.badCorners ?? []);
    ctx.beginPath();
    corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = vm.invalid ? 'rgba(239,68,68,0.9)' : 'rgba(96,165,250,0.95)';
    ctx.lineWidth = m.lineW * 2;
    ctx.stroke();

    // 拒绝时的幽灵点与连线
    const ghost = this.ui.rejectGhost;
    if (ghost) {
      const from = corners[ghost.index];
      ctx.save();
      ctx.strokeStyle = 'rgba(239,68,68,0.7)';
      ctx.lineWidth = m.lineW * 1.5;
      ctx.setLineDash([6 * m.unit, 5 * m.unit]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(ghost.x, ghost.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(ghost.x, ghost.y, m.handleR * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239,68,68,0.25)';
      ctx.fill();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = m.lineW * 2;
      ctx.stroke();
      ctx.restore();
    }

    // 控制柄
    for (let i = 0; i < 4; i += 1) {
      const p = corners[i];
      const isBad = bad.has(i) || ghost?.badCorners?.includes(i);
      const active = this.ui.dragIndex === i || this.ui.hoverCorner === i;
      const r = m.handleR * (active ? 1.25 : 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isBad ? '#ef4444' : this.ui.dragIndex === i ? '#93c5fd' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = m.lineW * 2.2;
      ctx.strokeStyle = isBad ? '#7f1d1d' : '#1d4ed8';
      ctx.stroke();

      ctx.font = m.font;
      const label = `${i + 1} ${CORNER_LABELS[i]}`;
      const lx = p.x + r + 6 * m.unit;
      const ly = p.y - r - 8 * m.unit;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(8,12,18,0.78)';
      roundRect(ctx, lx - 6 * m.unit, ly - 15 * m.unit, tw + 12 * m.unit, 22 * m.unit, 5 * m.unit);
      ctx.fill();
      ctx.fillStyle = isBad ? '#fecaca' : '#dbeafe';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx, ly - 4 * m.unit);
      ctx.textBaseline = 'alphabetic';
    }

    // 联动/固定标记
    const marker = this.ui.pinnedMarker ?? this.ui.linkedMarker;
    if (marker) {
      ctx.save();
      ctx.strokeStyle = '#fde047';
      ctx.lineWidth = m.lineW * 1.8;
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 12 * m.unit, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(marker.x - 18 * m.unit, marker.y);
      ctx.lineTo(marker.x - 6 * m.unit, marker.y);
      ctx.moveTo(marker.x + 6 * m.unit, marker.y);
      ctx.lineTo(marker.x + 18 * m.unit, marker.y);
      ctx.moveTo(marker.x, marker.y - 18 * m.unit);
      ctx.lineTo(marker.x, marker.y - 6 * m.unit);
      ctx.moveTo(marker.x, marker.y + 6 * m.unit);
      ctx.lineTo(marker.x, marker.y + 18 * m.unit);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function c_width(canvas, w, h) {
  canvas.width = w;
  canvas.height = h;
}

function drawDiamond(ctx, x, y, r, color) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#082f49';
  ctx.stroke();
  ctx.restore();
}

function drawCross(ctx, x, y, r, color, lineW) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
