// 排版：把某一楼层上的路线段展开成几何。
// 关键规则：
//  - 共用走廊（同一条无向边）按 (路线id, 方向) 排序分配侧向车道，顺序可复现；
//  - 反向通行共用一条边时各占一条车道，互不压盖；
//  - 汇入/分开处在节点前修剪并用二次贝塞尔过渡，不重叠；
//  - 所有装饰尺寸（车道宽、箭头、修剪量）以屏幕像素为基准，按 1/scale 换算成世界单位，
//    因此缩放时线宽与箭头在屏幕上保持恒定，导出 SVG 与屏幕一致。

export const STYLE = Object.freeze({
  lane: 7,        // 相邻车道中心距（屏幕 px）
  trim: 12,       // 节点处车道端头修剪量（屏幕 px）
  endTrim: 8,     // 段首/段末额外修剪（屏幕 px）
  arrow: 11,      // 箭头长度（屏幕 px）
  arrowW: 6.5,    // 箭头半宽（屏幕 px）
  routeWidth: 3,  // 路线线宽（屏幕 px，non-scaling-stroke）
  haloWidth: 5.5, // 路线白色衬底线宽（屏幕 px）
  corridorWidth: 1.5,
  nodeR: 3,
  doorSize: 11,
  font: 11,
  smallFont: 9,
  stairW: 52,
  stairH: 28,
});

function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function fmt(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 构建某一楼层的排版。
 * @param {object} plan  loadPlan 的 plan
 * @param {string} floorId
 * @param {number} scale 当前缩放（屏幕 px / 世界单位）
 */
export function buildFloorLayout(plan, floorId, scale = 1) {
  const u = 1 / scale; // 1 屏幕 px 对应的世界单位
  const laneW = STYLE.lane * u;
  const trim = STYLE.trim * u;
  const endTrim = STYLE.endTrim * u;

  // ---- 收集本楼层的通行记录：无向边 -> 车道列表 ----
  const edges = new Map(); // key -> { aId, bId, lanes: Map laneKey -> {routeId, dir} }
  const floorLegs = [];    // { route, leg }
  for (const route of plan.routes) {
    for (const leg of route.legs) {
      if (leg.floor !== floorId) continue;
      if (leg.path.some((id) => !plan.nodesById.has(id))) continue; // 断开的段不画，错误已在 loadPlan 报告
      if (leg.path.length < 2) continue;
      floorLegs.push({ route, leg });
      for (let i = 0; i + 1 < leg.path.length; i++) {
        const aId = leg.path[i];
        const bId = leg.path[i + 1];
        const key = edgeKey(aId, bId);
        const dir = aId < bId ? 1 : -1; // 相对规范方向（id 小 -> id 大）的行进方向
        if (!edges.has(key)) edges.set(key, { aId, bId, lanes: new Map() });
        const edge = edges.get(key);
        const laneKey = `${route.id}|${dir}`;
        if (!edge.lanes.has(laneKey)) edge.lanes.set(laneKey, { routeId: route.id, dir });
      }
    }
  }

  // ---- 车道排序与侧向偏移：按 (路线id, 方向) 排序，可复现 ----
  const laneOffset = new Map(); // laneKey -> 世界单位偏移（沿规范法向，带符号）
  for (const edge of edges.values()) {
    const lanes = [...edge.lanes.entries()]
      .sort((x, y) => (x[1].routeId < y[1].routeId ? -1 : x[1].routeId > y[1].routeId ? 1 : x[1].dir - y[1].dir));
    lanes.forEach(([laneKey], i) => {
      laneOffset.set(laneKey, (i - (lanes.length - 1) / 2) * laneW);
    });
    edge.sortedLanes = lanes.map(([k, v]) => ({ laneKey: k, ...v, offset: laneOffset.get(k) }));
  }

  // 节点 node 在第 edgeIndex 条边一侧的车道偏移向量（世界单位）
  const offsetAtNode = (route, leg, edgeIndex) => {
    const aId = leg.path[edgeIndex];
    const bId = leg.path[edgeIndex + 1];
    const a = plan.nodesById.get(aId);
    const b = plan.nodesById.get(bId);
    const dir = aId < bId ? 1 : -1;
    const offset = laneOffset.get(`${route.id}|${dir}`) ?? 0;
    const [c0, c1] = aId < bId ? [a, b] : [b, a];
    const dx = c1.x - c0.x;
    const dy = c1.y - c0.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: (-dy / len) * offset, y: (dx / len) * offset };
  };

  // ---- 每条路线段的几何 ----
  const routePaths = [];
  for (const { route, leg } of floorLegs) {
    const pts = leg.path.map((id) => plan.nodesById.get(id));
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dir = a.id < b.id ? 1 : -1;
      const offset = laneOffset.get(`${route.id}|${dir}`) ?? 0;
      // 规范方向（id 小 -> id 大）的法向，偏移只跟车道有关，与行进方向无关
      const [c0, c1] = a.id < b.id ? [a, b] : [b, a];
      const dx = c1.x - c0.x;
      const dy = c1.y - c0.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const nx = (-dy / len) * offset;
      const ny = (dx / len) * offset;
      // 行进方向单位向量
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      let t0 = i === 0 ? endTrim * 0.5 : trim;
      let t1 = i + 1 === pts.length - 1 ? endTrim : trim;
      if (t0 + t1 > len * 0.6) { t0 = len * 0.3; t1 = len * 0.3; }
      const p0 = { x: a.x + nx + ux * t0, y: a.y + ny + uy * t0 };
      const p1 = { x: b.x + nx - ux * t1, y: b.y + ny - uy * t1 };
      segs.push({ p0, p1, ux, uy, len: len - t0 - t1, nodeA: a.id, nodeB: b.id });
    }
    if (segs.length === 0) continue;

    // 节点处过渡的控制点：相邻两车道偏移向量的平均，保证汇入/分开处不压盖
    const joins = [];
    for (let i = 0; i + 1 < segs.length; i++) {
      const node = pts[i + 1];
      const prevOff = offsetAtNode(route, leg, i);
      const nextOff = offsetAtNode(route, leg, i + 1);
      joins.push({ x: node.x + (prevOff.x + nextOff.x) / 2, y: node.y + (prevOff.y + nextOff.y) / 2 });
    }

    // 方向箭头：每条边的车道中点一个（可追踪各自去向），末端一个终止箭头
    const arrows = [];
    const arrowLen = STYLE.arrow * u;
    for (const s of segs) {
      if (s.len > arrowLen * 1.6) {
        const mx = (s.p0.x + s.p1.x) / 2;
        const my = (s.p0.y + s.p1.y) / 2;
        arrows.push({
          x: mx + s.ux * arrowLen * 0.5, y: my + s.uy * arrowLen * 0.5,
          angle: Math.atan2(s.uy, s.ux), edge: `${s.nodeA}|${s.nodeB}`,
        });
      }
    }
    const last = segs[segs.length - 1];
    arrows.push({ x: last.p1.x, y: last.p1.y, angle: Math.atan2(last.uy, last.ux), terminal: true });

    routePaths.push({
      routeId: route.id, label: route.label, color: route.color,
      legIndex: leg.index, segs, joins, arrows,
      start: segs[0].p0, end: last.p1,
      startNode: leg.path[0], endNode: leg.path[leg.path.length - 1],
    });
  }

  // ---- 楼梯符号（编号与方向对应原数据） ----
  const stairs = [];
  for (const stair of plan.stairsById.values()) {
    const landing = stair.landings.find((l) => l.floor === floorId);
    if (!landing) continue;
    const node = plan.nodesById.get(landing.node);
    if (!node) continue;
    stairs.push({ node, stair, transition: transitionOf(plan, stair, floorId) });
  }

  // ---- 跨层延续标记（续 → / ← 接） ----
  const continuations = [];
  for (const route of plan.routes) {
    for (let k = 0; k < route.legs.length; k++) {
      const leg = route.legs[k];
      if (leg.floor !== floorId) continue;
      const startNode = plan.nodesById.get(leg.path[0]);
      const endNode = plan.nodesById.get(leg.path[leg.path.length - 1]);
      if (k > 0 && startNode && plan.stairByNode.has(startNode.id)) {
        const prevFloor = plan.floorsById.get(route.legs[k - 1].floor);
        continuations.push({
          x: startNode.x, y: startNode.y, routeId: route.id, color: route.color,
          kind: 'from', text: `${route.label} ← 接 ${prevFloor?.name ?? route.legs[k - 1].floor}`,
        });
      }
      if (k + 1 < route.legs.length && endNode && plan.stairByNode.has(endNode.id)) {
        const nextFloor = plan.floorsById.get(route.legs[k + 1].floor);
        continuations.push({
          x: endNode.x, y: endNode.y, routeId: route.id, color: route.color,
          kind: 'to', text: `${route.label} 续 → ${nextFloor?.name ?? route.legs[k + 1].floor}`,
        });
      }
    }
  }

  // ---- 本层节点与范围 ----
  const nodes = [...plan.nodesById.values()].filter((n) => n.floor === floorId);
  const bounds = nodes.reduce(
    (b, n) => ({ minX: Math.min(b.minX, n.x), minY: Math.min(b.minY, n.y), maxX: Math.max(b.maxX, n.x), maxY: Math.max(b.maxY, n.y) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );

  return { floorId, u, edges, routePaths, stairs, continuations, nodes, bounds };
}

function transitionOf(plan, stair, floorId) {
  const from = plan.floorsById.get(floorId);
  const others = stair.landings
    .filter((l) => l.floor !== floorId)
    .map((l) => plan.floorsById.get(l.floor))
    .filter(Boolean)
    .sort((a, b) => a.level - b.level);
  if (!from || others.length === 0) return null;
  const nearest = others.reduce((best, f) =>
    Math.abs(f.level - from.level) < Math.abs(best.level - from.level) ? f : best, others[0]);
  return { direction: nearest.level > from.level ? 'up' : 'down', to: nearest };
}

export { fmt };
