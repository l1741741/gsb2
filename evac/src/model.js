// 数据模型：读取并校验本地 JSON 疏散路线数据。
// 只负责"已审核数据 → 内部模型 + 错误列表"，不做任何路线规划。

export const SCHEMA = 'evac-plan/1';

export const NODE_KINDS = new Set(['exit', 'room', 'waypoint', 'stair']);

const DEFAULT_COLORS = ['#d62728', '#1f6fd6', '#2ca02c', '#e08a00', '#9467bd', '#008b8b'];

/**
 * @returns {{ plan: object, errors: Array<object> }}
 * 错误对象尽量携带 route / leg / floor / node 字段，便于定位到楼层与节点。
 */
export function loadPlan(data) {
  const errors = [];
  const err = (e) => errors.push(e);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('路线数据必须是一个 JSON 对象');
  }
  if (data.schema !== SCHEMA) {
    err({ message: `schema 应为 "${SCHEMA}"，实际为 ${JSON.stringify(data.schema ?? null)}` });
  }

  // ---- 楼层 ----
  const floors = Array.isArray(data.floors) ? data.floors : [];
  const floorsById = new Map();
  for (const f of floors) {
    if (!f || typeof f.id !== 'string' || f.id === '') {
      err({ message: '存在缺少 id 的楼层条目' });
      continue;
    }
    if (floorsById.has(f.id)) err({ floor: f.id, message: `重复的楼层 id "${f.id}"` });
    if (!Number.isFinite(f.level)) {
      err({ floor: f.id, message: `楼层 ${f.id} 缺少数值 level（用于判断楼梯上/下方向）` });
    }
    floorsById.set(f.id, { id: f.id, name: f.name ?? f.id, level: f.level });
  }

  // ---- 节点（门点 / 途经点 / 楼梯口） ----
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const nodesById = new Map();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || n.id === '') {
      err({ message: '存在缺少 id 的节点条目' });
      continue;
    }
    if (nodesById.has(n.id)) err({ floor: n.floor, node: n.id, message: `重复的节点 id "${n.id}"` });
    if (!floorsById.has(n.floor)) {
      err({ floor: n.floor, node: n.id, message: `节点 ${n.id} 引用了不存在的楼层 "${n.floor}"` });
    }
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      err({ floor: n.floor, node: n.id, message: `节点 ${n.id}（楼层 ${n.floor}）坐标不是有限数值` });
    }
    const kind = NODE_KINDS.has(n.kind) ? n.kind : 'waypoint';
    nodesById.set(n.id, {
      id: n.id, floor: n.floor, kind, x: n.x, y: n.y, label: n.label ?? null,
    });
  }

  // ---- 楼梯（换层连接，编号与方向对应原数据） ----
  const stairs = Array.isArray(data.stairs) ? data.stairs : [];
  const stairsById = new Map();
  const stairByNode = new Map(); // 楼梯口节点 id -> stair
  for (const s of stairs) {
    if (!s || typeof s.id !== 'string' || s.id === '') {
      err({ message: '存在缺少 id 的楼梯条目' });
      continue;
    }
    const stair = { id: s.id, flight: String(s.flight ?? s.id), landings: [] };
    stairsById.set(stair.id, stair);
    const landings = Array.isArray(s.landings) ? s.landings : [];
    if (landings.length < 2) {
      err({ message: `楼梯 ${stair.id} 至少需要两个楼层的落脚节点` });
    }
    for (const l of landings) {
      const node = nodesById.get(l?.node);
      if (!node) {
        err({ floor: l?.floor, node: l?.node, message: `楼梯 ${stair.id} 的落脚节点 "${l?.node}" 不存在` });
        continue;
      }
      if (node.floor !== l.floor) {
        err({
          floor: l.floor, node: l.node,
          message: `楼梯 ${stair.id} 的落脚节点 ${l.node} 实际属于楼层 ${node.floor}，与登记的楼层 ${l.floor} 不符`,
        });
      }
      if (stairByNode.has(l.node)) {
        err({ floor: l.floor, node: l.node, message: `节点 ${l.node} 同时被楼梯 ${stairByNode.get(l.node).id} 和 ${stair.id} 使用` });
      }
      stairByNode.set(l.node, stair);
      stair.landings.push({ floor: l.floor, node: l.node });
    }
  }

  // ---- 路线（已审核，仅排版不规划） ----
  const routes = Array.isArray(data.routes) ? data.routes : [];
  const checkedRoutes = [];
  routes.forEach((r, i) => {
    if (!r || typeof r.id !== 'string' || r.id === '') {
      err({ message: `第 ${i + 1} 条路线缺少 id` });
      return;
    }
    const route = {
      id: r.id,
      label: r.label ?? r.id,
      color: typeof r.color === 'string' ? r.color : DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      legs: [],
    };
    const legs = Array.isArray(r.legs) ? r.legs : [];
    if (legs.length === 0) err({ route: r.id, message: `路线 ${r.id} 没有任何分段（legs）` });
    legs.forEach((leg, li) => {
      const legInfo = { floor: leg?.floor, path: Array.isArray(leg?.path) ? leg.path : [], index: li };
      if (!floorsById.has(leg?.floor)) {
        err({ route: r.id, leg: li, floor: leg?.floor, message: `路线 ${r.id} 第 ${li + 1} 段引用了不存在的楼层 "${leg?.floor}"` });
      }
      if (legInfo.path.length < 2) {
        err({ route: r.id, leg: li, floor: leg?.floor, message: `路线 ${r.id} 第 ${li + 1} 段（楼层 ${leg?.floor}）不足两个节点，无法成线` });
      }
      for (const nodeId of legInfo.path) {
        const node = nodesById.get(nodeId);
        if (!node) {
          err({ route: r.id, leg: li, floor: leg?.floor, node: nodeId, message: `路线 ${r.id} 第 ${li + 1} 段：楼层 ${leg?.floor} 上不存在节点 "${nodeId}"` });
        } else if (node.floor !== leg?.floor) {
          err({ route: r.id, leg: li, floor: leg?.floor, node: nodeId, message: `路线 ${r.id} 第 ${li + 1} 段：节点 ${nodeId} 属于楼层 ${node.floor}，不属于本段楼层 ${leg?.floor}` });
        }
      }
      route.legs.push(legInfo);
    });
    // 相邻两段之间必须经同一部楼梯换层，否则是断开的链路
    for (let k = 0; k + 1 < route.legs.length; k++) {
      const a = route.legs[k];
      const b = route.legs[k + 1];
      const endNode = a.path[a.path.length - 1];
      const startNode = b.path[0];
      if (!nodesById.has(endNode) || !nodesById.has(startNode)) continue; // 端点本身已报错
      const sa = stairByNode.get(endNode);
      const sb = stairByNode.get(startNode);
      if (!sa || !sb || sa.id !== sb.id) {
        err({
          route: r.id, leg: k + 1, floor: a.floor, node: endNode,
          message: `路线 ${r.id} 链路断开：第 ${k + 1} 段终点 ${endNode}（楼层 ${a.floor}）与第 ${k + 2} 段起点 ${startNode}（楼层 ${b.floor}）之间没有同一部楼梯连接`,
        });
      }
    }
    checkedRoutes.push(route);
  });

  const plan = {
    floors: [...floorsById.values()].sort((a, b) => a.level - b.level),
    floorsById, nodesById, stairsById, stairByNode,
    routes: checkedRoutes,
  };
  return { plan, errors };
}

/** 楼梯在某楼层上的换层方向与目标楼层（对应回原数据的 level）。 */
export function stairTransition(plan, stair, fromFloorId) {
  const from = plan.floorsById.get(fromFloorId);
  const others = stair.landings
    .filter((l) => l.floor !== fromFloorId)
    .map((l) => plan.floorsById.get(l.floor))
    .filter(Boolean)
    .sort((a, b) => a.level - b.level);
  if (!from || others.length === 0) return null;
  const nearest = others.reduce((best, f) =>
    Math.abs(f.level - from.level) < Math.abs(best.level - from.level) ? f : best, others[0]);
  return { direction: nearest.level > from.level ? 'up' : 'down', to: nearest, others };
}
