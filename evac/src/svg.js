// SVG 输出：屏幕显示与文件导出共用这一个生成器，保证两者几何一致。
// 线宽用 vector-effect="non-scaling-stroke"（屏幕恒定像素），
// 箭头/文字/楼梯符号等装饰尺寸按 1/scale 换算成世界单位，缩放时屏幕大小不变。

import { STYLE, buildFloorLayout, fmt } from './layout.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pathD(segs, joins) {
  let d = `M ${fmt(segs[0].p0.x)} ${fmt(segs[0].p0.y)}`;
  for (let i = 0; i < segs.length; i++) {
    d += ` L ${fmt(segs[i].p1.x)} ${fmt(segs[i].p1.y)}`;
    if (i < joins.length) {
      const j = joins[i];
      const n = segs[i + 1].p0;
      d += ` Q ${fmt(j.x)} ${fmt(j.y)} ${fmt(n.x)} ${fmt(n.y)}`;
    }
  }
  return d;
}

function arrowPolygon(x, y, angle, len, halfW) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const bx = x - len * c;
  const by = y - len * s;
  const px = -s * halfW;
  const py = c * halfW;
  return `${fmt(x)},${fmt(y)} ${fmt(bx + px)},${fmt(by + py)} ${fmt(bx - px)},${fmt(by - py)}`;
}

/**
 * 渲染某一楼层为完整 SVG 字符串。
 * @param {object} plan  loadPlan 的 plan
 * @param {string} floorId
 * @param {object} view  { scale, panX, panY, width, height }（屏幕 px）
 */
export function renderFloorSvg(plan, floorId, view) {
  const { scale, panX, panY, width, height } = view;
  const layout = buildFloorLayout(plan, floorId, scale);
  const u = layout.u;
  const floor = plan.floorsById.get(floorId);
  const out = [];

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}" width="${fmt(width)}" height="${fmt(height)}" data-floor="${esc(floorId)}" font-family="system-ui, sans-serif">`);
  out.push(`<rect width="${fmt(width)}" height="${fmt(height)}" fill="#fafaf7"/>`);
  out.push(`<g transform="translate(${fmt(panX)} ${fmt(panY)}) scale(${fmt(scale)})">`);

  // 走廊底图（被引用的无向边）
  for (const edge of layout.edges.values()) {
    const a = plan.nodesById.get(edge.aId);
    const b = plan.nodesById.get(edge.bId);
    out.push(`<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" stroke="#ddd8cf" stroke-width="${STYLE.corridorWidth}" vector-effect="non-scaling-stroke"/>`);
  }

  // 节点：出口 / 房间 / 途经点
  const doorHalf = (STYLE.doorSize / 2) * u;
  for (const n of layout.nodes) {
    if (n.kind === 'exit') {
      out.push(`<rect x="${fmt(n.x - doorHalf)}" y="${fmt(n.y - doorHalf)}" width="${fmt(doorHalf * 2)}" height="${fmt(doorHalf * 2)}" fill="#1a9e4b" stroke="#0d6b31" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
      out.push(`<text x="${fmt(n.x)}" y="${fmt(n.y - doorHalf - 4 * u)}" font-size="${fmt(STYLE.font * u)}" text-anchor="middle" fill="#0d6b31">${esc(n.label ?? n.id)}</text>`);
    } else if (n.kind === 'room') {
      out.push(`<rect x="${fmt(n.x - doorHalf)}" y="${fmt(n.y - doorHalf)}" width="${fmt(doorHalf * 2)}" height="${fmt(doorHalf * 2)}" fill="#fff" stroke="#555" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
      out.push(`<text x="${fmt(n.x)}" y="${fmt(n.y - doorHalf - 4 * u)}" font-size="${fmt(STYLE.font * u)}" text-anchor="middle" fill="#333">${esc(n.label ?? n.id)}</text>`);
    } else if (n.kind === 'waypoint') {
      out.push(`<circle cx="${fmt(n.x)}" cy="${fmt(n.y)}" r="${fmt(STYLE.nodeR * u)}" fill="#b8b2a6"/>`);
    }
  }

  // 路线：白色衬底 + 彩色车道线
  for (const rp of layout.routePaths) {
    const d = pathD(rp.segs, rp.joins);
    out.push(`<path d="${d}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="${STYLE.haloWidth}" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  for (const rp of layout.routePaths) {
    const d = pathD(rp.segs, rp.joins);
    out.push(`<path d="${d}" fill="none" stroke="${esc(rp.color)}" stroke-width="${STYLE.routeWidth}" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" data-route="${esc(rp.routeId)}" data-leg="${rp.legIndex}"/>`);
  }

  // 箭头（世界单位尺寸 = 屏幕常量 / scale，缩放时屏幕大小不变）
  const arrowLen = STYLE.arrow * u;
  const arrowHalfW = STYLE.arrowW * u;
  for (const rp of layout.routePaths) {
    for (const a of rp.arrows) {
      out.push(`<polygon class="arrow" data-route="${esc(rp.routeId)}" points="${arrowPolygon(a.x, a.y, a.angle, arrowLen, arrowHalfW)}" fill="${esc(rp.color)}"/>`);
    }
    out.push(`<circle cx="${fmt(rp.start.x)}" cy="${fmt(rp.start.y)}" r="${fmt(3.5 * u)}" fill="${esc(rp.color)}" stroke="#fff" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
  }

  // 楼梯符号：编号 + 上/下方向（来自原数据 level），不画跨层平面连线
  const sw = STYLE.stairW * u;
  const sh = STYLE.stairH * u;
  for (const { node, stair, transition } of layout.stairs) {
    const x0 = node.x - sw / 2;
    const y0 = node.y - sh / 2;
    out.push(`<g data-stair="${esc(stair.id)}">`);
    out.push(`<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(sw)}" height="${fmt(sh)}" rx="${fmt(3 * u)}" fill="#eef2f7" stroke="#33475b" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`);
    for (let i = 1; i <= 3; i++) {
      const yy = y0 + (sh / 4) * i;
      out.push(`<line x1="${fmt(x0 + 3 * u)}" y1="${fmt(yy)}" x2="${fmt(x0 + sw - 3 * u)}" y2="${fmt(yy)}" stroke="#33475b" stroke-width="0.8" vector-effect="non-scaling-stroke"/>`);
    }
    const arrow = transition ? (transition.direction === 'up' ? '↑' : '↓') : '';
    const target = transition ? transition.to.name : '';
    out.push(`<text x="${fmt(node.x)}" y="${fmt(y0 - 5 * u)}" font-size="${fmt(STYLE.font * u)}" text-anchor="middle" font-weight="bold" fill="#33475b">${esc(stair.flight)}楼梯 ${arrow}${esc(target)}</text>`);
    out.push(`</g>`);
  }

  // 跨层延续标记（同一楼梯口的多条路线纵向堆叠，互不压盖）
  const badgeRows = new Map();
  for (const c of layout.continuations) {
    const key = `${c.x}|${c.y}`;
    const row = badgeRows.get(key) ?? 0;
    badgeRows.set(key, row + 1);
    const by = c.y - sh / 2 - (STYLE.font + 10) * u - row * (STYLE.font + 6) * u;
    out.push(`<text x="${fmt(c.x)}" y="${fmt(by)}" font-size="${fmt(STYLE.smallFont * u)}" text-anchor="middle" fill="${esc(c.color)}" data-continuation="${esc(c.routeId)}">${esc(c.text)}</text>`);
  }

  out.push('</g>');

  // 图例（屏幕坐标，不随缩放变化）
  const legendRoutes = plan.routes.filter((r) => r.legs.some((l) => l.floor === floorId));
  let ly = 18;
  out.push(`<g class="legend">`);
  out.push(`<text x="12" y="${ly}" font-size="13" font-weight="bold" fill="#222">${esc(floor?.name ?? floorId)}</text>`);
  for (const r of legendRoutes) {
    ly += 18;
    out.push(`<line x1="12" y1="${ly - 4}" x2="30" y2="${ly - 4}" stroke="${esc(r.color)}" stroke-width="${STYLE.routeWidth}"/>`);
    out.push(`<text x="36" y="${ly}" font-size="11" fill="#333">${esc(r.label)}（${esc(r.id)}）</text>`);
  }
  out.push('</g>');

  out.push('</svg>');
  return out.join('\n');
}
