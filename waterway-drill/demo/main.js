/**
 * 水道演练的浏览器控制器。
 *
 * 通过 `build/browser.js`（由 src/ 构建）使用演练核心，
 * 不引入任何第三方运行时依赖。
 */
import {
  DrillSession,
  compileLevel,
  sampleLevels,
  replayRecord,
  parseRecord,
  RecordRejectedError,
  LevelError,
  buildReplayView,
  renderScene,
  hitTest,
  screenToWorld,
  poolsWithinViewport,
  WORLD_WIDTH,
  WORLD_HEIGHT,
} from '../build/browser.js';

const canvas = document.querySelector('#scene');
const context = canvas.getContext('2d');
const replayCanvas = document.querySelector('#replay-scene');
const replayContext = replayCanvas.getContext('2d');
const dialog = document.querySelector('#replay-dialog');

const els = {
  levelSelect: document.querySelector('#level-select'),
  levelName: document.querySelector('#level-name'),
  levelSummary: document.querySelector('#level-summary'),
  turnReadout: document.querySelector('#turn-readout'),
  goalReadout: document.querySelector('#goal-readout'),
  outcome: document.querySelector('#outcome-banner'),
  failureDetail: document.querySelector('#failure-detail'),
  gateList: document.querySelector('#gate-list'),
  pendingCount: document.querySelector('#pending-count'),
  confirm: document.querySelector('#confirm'),
  undo: document.querySelector('#undo'),
  clearPending: document.querySelector('#clear-pending'),
  ledger: document.querySelector('#ledger'),
  edgeReport: document.querySelector('#edge-report'),
  history: document.querySelector('#history'),
  recordStatus: document.querySelector('#record-status'),
  exportRecord: document.querySelector('#export-record'),
  exportFile: document.querySelector('#export-file'),
  importRecord: document.querySelector('#import-record'),
  importFile: document.querySelector('#import-file'),
  replayMeta: document.querySelector('#replay-meta'),
  replayReadout: document.querySelector('#replay-readout'),
  replayPrev: document.querySelector('#replay-prev'),
  replayNext: document.querySelector('#replay-next'),
  replayCursor: document.querySelector('#replay-cursor'),
  replayClose: document.querySelector('#replay-close'),
};

/** 当前关卡状态。 */
let level = null;
let session = null;
let hovered = { gateId: null, poolId: null };
let replayState = null;
let toastTimer = null;

/** 关卡选择下拉框：从样例关卡填充。 */
function populateLevelSelect() {
  els.levelSelect.innerHTML = '';
  for (const spec of sampleLevels) {
    const option = document.createElement('option');
    option.value = spec.id;
    option.textContent = spec.name;
    els.levelSelect.append(option);
  }
}

function toast(message, kind = 'normal') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const node = document.createElement('div');
  node.className = `toast${kind === 'error' ? ' error' : ''}`;
  node.textContent = message;
  document.body.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }, 2600);
}

/** 载入一个关卡，若有未结算的布置则丢弃。 */
function loadLevel(levelId) {
  const spec = sampleLevels.find((candidate) => candidate.id === levelId) ?? sampleLevels[0];
  try {
    level = compileLevel(spec);
    session = new DrillSession(level);
    hovered = { gateId: null, poolId: null };
    setRecordStatus('');
    if (!poolsWithinViewport(session.view())) {
      toast('关卡布局超出画布范围', 'error');
    }
    renderEverything();
  } catch (error) {
    if (error instanceof LevelError) {
      toast(`关卡数据有误：${error.issues.join('；')}`, 'error');
      return;
    }
    throw error;
  }
}

/** 决定画布物理分辨率，保证高清屏清晰。 */
function syncCanvasResolution(canvasElement, ctx) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(WORLD_WIDTH * ratio);
  const height = Math.round(WORLD_HEIGHT * ratio);
  if (canvasElement.width !== width || canvasElement.height !== height) {
    canvasElement.width = width;
    canvasElement.height = height;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ratio;
}

function drawMainScene() {
  syncCanvasResolution(canvas, context);
  renderScene(context, session.view(), {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    highlightGate: hovered.gateId,
    highlightPool: hovered.poolId,
  });
}

/** 全局刷新。 */
function renderEverything() {
  const view = session.view();
  drawMainScene();
  renderStatus(view);
  renderGates(view);
  renderLedger(view);
  renderEdgeReport(view);
  renderHistory(view);
  els.undo.disabled = !view.canUndo;
  els.confirm.disabled = !view.canConfirm;
  els.clearPending.disabled = !view.canConfirm || view.pendingChanges === 0;
  els.exportRecord.disabled = view.history.length === 0;
  els.exportFile.disabled = view.history.length === 0;
  els.levelName.textContent = view.levelName;
  els.levelSummary.textContent = view.levelSummary;
}

function renderStatus(view) {
  els.turnReadout.textContent = `${view.turnsPlayed} / ${view.turnLimit}`;
  const goalPool = view.pools.find((pool) => pool.id === view.goal.pool);
  els.goalReadout.textContent = goalPool
    ? `${goalPool.label} ${goalPool.level}/${view.goal.atLeast}`
    : `≥ ${view.goal.atLeast}`;

  if (view.outcome === 'playing') {
    els.outcome.hidden = true;
    els.failureDetail.hidden = true;
  } else {
    els.outcome.hidden = false;
    els.outcome.className = `outcome-banner ${view.outcome}`;
    els.outcome.textContent = view.outcome === 'won' ? '已通关' : '演练失败';
    els.failureDetail.hidden = false;
    els.failureDetail.textContent = describeFailure(view);
  }
}

function describeFailure(view) {
  const failure = view.failure;
  if (!failure) return '';
  if (failure.code === 'maintenance-flooded') {
    const pool = view.pools.find((candidate) => candidate.id === failure.poolId);
    const label = pool ? pool.label : failure.poolId;
    return `低处检修格「${label}」水位 ${failure.level}，超过安全线 ${failure.safeLevel}。`;
  }
  const goalPool = view.pools.find((candidate) => candidate.id === failure.goalPoolId);
  return `回合用尽，「${goalPool ? goalPool.label : failure.goalPoolId}」只到 ${failure.achieved}，需要 ${failure.required}。`;
}

function renderGates(view) {
  els.pendingCount.textContent = String(view.pendingChanges);
  els.gateList.innerHTML = '';
  for (const gate of view.gates) {
    const row = document.createElement('div');
    row.className = `gate-row${gate.pending !== null ? ' pending' : ''}`;
    row.dataset.gateId = gate.id;

    const name = document.createElement('div');
    name.className = 'gate-name';
    const title = document.createElement('b');
    title.textContent = gate.label;
    const subtitle = document.createElement('small');
    subtitle.textContent = gate.controls.length > 0
      ? `控制 ${gate.controls.join('、')}`
      : '未连接支路';
    name.append(title, subtitle);

    const effective = gate.pending ?? gate.committed;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'gate-toggle';
    toggle.dataset.state = effective;
    toggle.textContent = effective === 'open' ? '开启' : '关闭';
    toggle.disabled = !view.canConfirm;
    toggle.setAttribute('aria-label', `${gate.label}：${effective === 'open' ? '开启' : '关闭'}（点击切换）`);
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      try {
        session.queueGate(gate.id, effective === 'open' ? 'closed' : 'open');
        renderEverything();
      } catch (error) {
        toast(String(error.message ?? error), 'error');
      }
    });

    row.addEventListener('mouseenter', () => {
      hovered = { gateId: gate.id, poolId: null };
      drawMainScene();
    });
    row.addEventListener('mouseleave', () => {
      hovered = { gateId: null, poolId: null };
      drawMainScene();
    });

    row.append(name, toggle);
    els.gateList.append(row);
  }
}

function renderLedger(view) {
  const record = view.lastTurn;
  if (!record) {
    els.ledger.innerHTML = '<p class="empty-note">还没有结算回合。</p>';
    return;
  }
  const rows = [];
  const head = document.createElement('div');
  head.className = 'ledger-row head';
  head.innerHTML = '<span class="pool">池子</span>'
    + '<span class="num">起始</span><span class="num">来水</span><span class="num">溢入</span>'
    + '<span class="num">进水口</span><span class="num">出水口</span><span class="num opt">外排</span>'
    + '<span class="end">溢流→留池</span>';
  rows.push(head);

  for (const entry of record.ledger) {
    const pool = view.pools.find((candidate) => candidate.id === entry.poolId);
    const row = document.createElement('div');
    row.className = 'ledger-row';
    row.innerHTML =
      `<span class="pool">${escapeHtml(pool ? pool.label : entry.poolId)}</span>`
      + `<span class="num">${entry.start}</span>`
      + `<span class="num positive">${entry.inflow ? `+${entry.inflow}` : '·'}</span>`
      + `<span class="num positive">${entry.spillIn ? `+${entry.spillIn}` : '·'}</span>`
      + `<span class="num positive">${entry.inEdges ? `+${entry.inEdges}` : '·'}</span>`
      + `<span class="num negative">${entry.outEdges ? `−${entry.outEdges}` : '·'}</span>`
      + `<span class="num opt negative">${entry.drain ? `−${entry.drain}` : '·'}</span>`
      + `<span class="end">${entry.spill ? `溢${entry.spill} → ` : ''}${entry.end}</span>`;
    rows.push(row);
  }
  els.ledger.replaceChildren(...rows);
}

function renderEdgeReport(view) {
  els.edgeReport.innerHTML = '';
  const record = view.lastTurn;
  const reported = view.edges.filter((edge) => (record ? (record.edges[edge.id] ?? 0) > 0 : edge.previewOpen));
  if (reported.length === 0) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = record ? '上一回合没有任何支路通水。' : '当前没有打开的支路。';
    els.edgeReport.append(note);
    return;
  }
  for (const edge of reported) {
    const amount = record ? (record.edges[edge.id] ?? 0) : null;
    const line = document.createElement('div');
    line.className = `edge-line${edge.open ? '' : ' closed'}`;
    const ratio = record && edge.capacity > 0 ? Math.min(1, amount / edge.capacity) : 1;
    line.innerHTML =
      `<span class="route">${escapeHtml(poolLabel(view, edge.from))} → ${escapeHtml(poolLabel(view, edge.to))}</span>`
      + `<span class="bar"><i style="width:${Math.round(ratio * 100)}%"></i></span>`
      + `<span class="amount${amount === 0 ? ' zero' : ''}">${amount === null ? '预演' : amount}</span>`
      + `<span class="cap">/ ${edge.capacity}</span>`;
    els.edgeReport.append(line);
  }
}

function renderHistory(view) {
  els.history.innerHTML = '';
  if (view.history.length === 0) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = '尚无已确认的回合。';
    els.history.append(note);
    return;
  }
  for (const turn of view.history) {
    const card = document.createElement('article');
    card.className = `history-card${turn.outcome === 'won' ? ' won-h' : turn.outcome === 'lost' ? ' lost-h' : ''}`;

    const title = document.createElement('h4');
    title.innerHTML = `回合 ${turn.turn}<span>${outcomeLabel(turn.outcome)}</span>`;
    card.append(title);

    const list = document.createElement('ul');
    for (const pool of view.pools) {
      const item = document.createElement('li');
      item.innerHTML = `<span class="k">${escapeHtml(pool.label)}</span><span>${turn.pools[pool.id] ?? 0}</span>`;
      list.append(item);
    }
    card.append(list);

    const badges = document.createElement('div');
    badges.className = 'badges';
    for (const [gateId, state] of Object.entries(turn.gates)) {
      const badge = document.createElement('span');
      badge.className = `badge ${state}`;
      badge.textContent = `${gateId}${state === 'open' ? '开' : '关'}`;
      badges.append(badge);
    }
    const spillTotal = Object.values(turn.spill).reduce((sum, value) => sum + value, 0);
    if (spillTotal > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge spill';
      badge.textContent = `溢流 ${spillTotal}`;
      badges.append(badge);
    }
    card.append(badges);
    els.history.append(card);
  }
}

function outcomeLabel(outcome) {
  if (outcome === 'won') return '通关';
  if (outcome === 'lost') return '失败';
  return '继续';
}

function poolLabel(view, poolId) {
  const pool = view.pools.find((candidate) => candidate.id === poolId);
  return pool ? pool.label : poolId;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function setRecordStatus(message, kind = '') {
  els.recordStatus.textContent = message;
  els.recordStatus.className = `record-status${kind ? ` ${kind}` : ''}`;
}

/** ---- 画布交互：点击闸门切换布置；悬停高亮 ---- */
canvas.addEventListener('pointermove', (event) => {
  if (!session) return;
  const rect = canvas.getBoundingClientRect();
  const point = screenToWorld(event.clientX, event.clientY, rect);
  const hit = hitTest(session.view(), point);
  if (hit.gateId !== hovered.gateId || hit.poolId !== hovered.poolId) {
    hovered = hit;
    canvas.style.cursor = hit.gateId ? 'pointer' : 'default';
    drawMainScene();
  }
});

canvas.addEventListener('pointerleave', () => {
  hovered = { gateId: null, poolId: null };
  canvas.style.cursor = 'default';
  if (session) drawMainScene();
});

canvas.addEventListener('click', (event) => {
  if (!session) return;
  const rect = canvas.getBoundingClientRect();
  const point = screenToWorld(event.clientX, event.clientY, rect);
  const hit = hitTest(session.view(), point);
  if (!hit.gateId) return;
  const gate = session.view().gates.find((candidate) => candidate.id === hit.gateId);
  if (!gate) return;
  try {
    const effective = gate.pending ?? gate.committed;
    session.queueGate(gate.id, effective === 'open' ? 'closed' : 'open');
    renderEverything();
  } catch (error) {
    toast(String(error.message ?? error), 'error');
  }
});

/** ---- 按钮 ---- */
els.confirm.addEventListener('click', () => {
  if (!session) return;
  try {
    const record = session.settle();
    renderEverything();
    if (record.outcome === 'won') toast('通关！可以在记录里导出本次走法。');
    else if (record.outcome === 'lost') toast('演练失败，可点击「撤回一步」改走另一种安排。', 'error');
    else if (record.spill && Object.values(record.spill).some((value) => value > 0)) {
      toast('有池子溢流了，注意水位与检修格。');
    }
  } catch (error) {
    toast(String(error.message ?? error), 'error');
  }
});

els.undo.addEventListener('click', () => {
  if (!session) return;
  if (session.undo()) {
    renderEverything();
    toast('已撤回上一步，可改走另一种安排。');
  }
});

els.clearPending.addEventListener('click', () => {
  if (!session) return;
  session.clearAllPending();
  renderEverything();
});

/** ---- 记录导出 / 导入 ---- */
els.exportRecord.addEventListener('click', () => {
  if (!session) return;
  const record = session.toRecord();
  const text = JSON.stringify(record, null, 2);
  window.__lastRecordText = text;
  setRecordStatus(`已导出到内存与下载框（${record.turns.length} 回合，${record.result.outcome}）。`, 'ok');
  toast('记录已生成，可复制或下载。');
});

els.exportFile.addEventListener('click', () => {
  if (!session) return;
  const record = session.toRecord();
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `waterway-${record.levelId}-${record.result.outcome}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setRecordStatus(`已下载 waterway-${record.levelId}-${record.result.outcome}.json。`, 'ok');
});

els.importRecord.addEventListener('click', () => {
  els.importFile.click();
});

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files?.[0];
  if (!file) return;
  const text = await file.text();
  els.importFile.value = '';
  importRecordText(text);
});

async function importRecordText(text) {
  if (!level) return;
  try {
    const record = parseRecord(text);
    const replay = replayRecord(level, record);
    openReplay(replay);
    setRecordStatus(`记录通过复核：${record.turns.length} 回合，结果 ${replay.outcome}。`, 'ok');
  } catch (error) {
    if (error instanceof RecordRejectedError) {
      setRecordStatus(`拒绝加载：${error.message}`, 'error');
      toast(`拒绝加载：${error.message}`, 'error');
    } else {
      setRecordStatus(`记录解析失败：${String(error.message ?? error)}`, 'error');
      toast(`记录解析失败：${String(error.message ?? error)}`, 'error');
    }
  }
}

/** ---- 回放 ---- */
function openReplay(replay) {
  const turns = replay.turns;
  replayState = { replay, cursor: turns.length };
  els.replayMeta.textContent =
    `关卡 ${replay.record.levelId} · ${turns.length} 回合 · 复核结果 ${replay.outcome}`;
  updateReplay();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function updateReplay() {
  if (!replayState) return;
  const { replay, cursor } = replayState;
  const turns = replay.turns;
  const view = buildReplayView(level, turns, cursor);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (replayCanvas.width !== Math.round(WORLD_WIDTH * ratio)) {
    replayCanvas.width = Math.round(WORLD_WIDTH * ratio);
    replayCanvas.height = Math.round(WORLD_HEIGHT * ratio);
  }
  replayContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  renderScene(replayContext, view);

  els.replayCursor.textContent = `${cursor} / ${turns.length}`;
  els.replayPrev.disabled = cursor <= 0;
  els.replayNext.disabled = cursor >= turns.length;

  const current = cursor > 0 ? turns[cursor - 1] : null;
  const lines = [];
  if (view.failure) {
    lines.push({ key: '结果', value: view.failure.code === 'maintenance-flooded'
      ? `检修格被淹（${view.failure.poolId} ${view.failure.level} > ${view.failure.safeLevel}）`
      : `回合用尽（${view.failure.achieved}/${view.failure.required}）` });
  } else {
    lines.push({ key: '结果', value: cursor === 0 ? '开始前' : outcomeLabel(current.outcome) });
  }
  for (const pool of view.pools) {
    lines.push({ key: pool.label, value: `${pool.level}/${pool.capacity}` });
  }
  const spillTotal = current ? Object.values(current.spill).reduce((sum, value) => sum + value, 0) : 0;
  if (spillTotal > 0) lines.push({ key: '溢流合计', value: String(spillTotal) });

  els.replayReadout.innerHTML = '';
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="k">${escapeHtml(line.key)}</span><span>${escapeHtml(line.value)}</span>`;
    els.replayReadout.append(row);
  }
}

els.replayPrev.addEventListener('click', () => {
  if (!replayState) return;
  replayState.cursor = Math.max(0, replayState.cursor - 1);
  updateReplay();
});
els.replayNext.addEventListener('click', () => {
  if (!replayState) return;
  replayState.cursor = Math.min(replayState.replay.turns.length, replayState.cursor + 1);
  updateReplay();
});
els.replayClose.addEventListener('click', () => {
  replayState = null;
});

/** ---- 关卡切换 ---- */
els.levelSelect.addEventListener('change', () => {
  loadLevel(els.levelSelect.value);
});

window.addEventListener('resize', () => {
  if (session) drawMainScene();
  if (replayState) updateReplay();
});

/** 测试钩子：不暴露内部对象，只提供可靠的读取与驱动入口。 */
window.__waterway = {
  getView() {
    return session ? session.view() : null;
  },
  getLedger() {
    const view = session?.view();
    return view?.lastTurn?.ledger ?? null;
  },
  selectLevel(levelId) {
    els.levelSelect.value = levelId;
    loadLevel(levelId);
  },
  queueGate(gateId, state) {
    session?.queueGate(gateId, state);
    renderEverything();
  },
  confirm() {
    els.confirm.click();
  },
  undo() {
    els.undo.click();
  },
  exportRecord() {
    return session ? JSON.stringify(session.toRecord(), null, 2) : null;
  },
  importRecord(text) {
    return importRecordText(text);
  },
  getRecordStatus() {
    return els.recordStatus.textContent;
  },
  isReplayOpen() {
    return dialog.hasAttribute('open');
  },
  replayCursor() {
    return els.replayCursor.textContent;
  },
  replayReadout() {
    return els.replayReadout.textContent;
  },
  setReplayCursor(cursor) {
    if (replayState) {
      replayState.cursor = cursor;
      updateReplay();
    }
  },
  clearRecordStatus() {
    setRecordStatus('');
  },
  getReplayTurns() {
    return replayState?.replay.turns ?? null;
  },
};

/** 启动 */
populateLevelSelect();
loadLevel(sampleLevels[0].id);
