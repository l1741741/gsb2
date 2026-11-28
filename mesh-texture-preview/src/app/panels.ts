/**
 * DOM binding for the inspector panels.
 *
 * Pure functions that turn an App snapshot into HTML strings. Keeping them
 * separate from the event wiring makes them testable in Node (no DOM needed)
 * and keeps `main.ts` focused on input.
 */

import { documentFingerprint } from '../core/diagnostics.ts';
import type { Snapshot } from './app.ts';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function fmt(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '∞';
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export interface SummaryItem {
  label: string;
  value: string;
  cls: string;
  title: string;
}

/** Summary tiles; `cls` drives warning/danger colouring in CSS. */
export function summaryItems(snapshot: Snapshot): SummaryItem[] {
  const diagnostics = snapshot.diagnostics;
  return [
    { label: '三角形', value: String(snapshot.document.triangles.length), cls: '', title: '三角网格总数' },
    { label: '边界边', value: String(diagnostics.boundaryEdges), cls: '', title: '只有一侧相邻三角形的边' },
    {
      label: '翻面',
      value: String(diagnostics.flippedTriangles),
      cls: diagnostics.flippedTriangles > 0 ? 'danger' : '',
      title: '纹理空间绕向与布面绕向相反',
    },
    {
      label: '塌陷',
      value: String(diagnostics.collapsedTriangles),
      cls: diagnostics.collapsedTriangles > 0 ? 'danger' : '',
      title: '雅可比最小奇异值低于阈值',
    },
    {
      label: '明显拉伸',
      value: String(diagnostics.overStretchedTriangles),
      cls: diagnostics.overStretchedTriangles > 0 ? 'warn' : '',
      title: '形变为网格中位值的阈值倍数以上',
    },
    {
      label: '断拼缝',
      value: String(diagnostics.splitSeams),
      cls: diagnostics.splitSeams > 0 ? 'split' : '',
      title: '已声明两侧取不同纹理坐标的拼缝数量',
    },
    {
      label: '连续拼缝',
      value: String(diagnostics.continuousSeams),
      cls: '',
      title: '两侧使用同一纹理坐标线的拼缝数量',
    },
    {
      label: '意外断开',
      value: String(diagnostics.accidentalSplits),
      cls: diagnostics.accidentalSplits > 0 ? 'warn' : '',
      title: '声明为连续、但两侧 UV 实际不一致',
    },
  ];
}

export function summaryHtml(snapshot: Snapshot): string {
  return summaryItems(snapshot)
    .map(
      (item) =>
        `<div class="summary-item ${item.cls}" title="${escapeHtml(item.title)}"><span class="label">${escapeHtml(item.label)}</span><span class="value">${escapeHtml(item.value)}</span></div>`,
    )
    .join('');
}

const SEAM_STATUS_LABEL: Record<string, string> = {
  'continuous-ok': '连续',
  'accidental-split': '意外断开',
  'split-ok': '断开',
  'split-equal': '断开但两侧相同',
  invalid: '非法',
};

const SEAM_STATUS_CLASS: Record<string, string> = {
  'continuous-ok': 'ok',
  'accidental-split': 'warn',
  'split-ok': 'split',
  'split-equal': 'warn',
  invalid: 'danger',
};

/** Seam list rows with per-seam actions. */
export function seamListHtml(snapshot: Snapshot, resolvedSeams: ReturnType<import('./app.ts').App['resolvedSeams']>): string {
  if (resolvedSeams.length === 0) return '<p class="hint">没有共享边，因而没有拼缝。</p>';
  const diagnostics = snapshot.diagnostics;
  const selection = snapshot.selection;
  return resolvedSeams
    .map((seam) => {
      const metrics = diagnostics.seamById.get(seam.id);
      const status = metrics?.status ?? 'invalid';
      const active = selection.kind === 'seam' && selection.seam === seam.id;
      const kindLabel = seam.kind === 'split' ? '断开' : '连续';
      const kindClass = seam.kind === 'split' ? 'seam-kind-split' : 'seam-kind-continuous';
      const split = metrics && Number.isFinite(metrics.maxSplit) ? metrics.maxSplit.toFixed(4) : '—';
      const declared = seam.declared ? '' : '（自动）';
      return `<div class="seam-row ${active ? 'active' : ''}" data-seam="${escapeHtml(seam.id)}">
        <span class="seam-name"><span class="${kindClass}">${kindLabel}</span> · ${escapeHtml(seam.id)}${declared} · △${seam.triangleIdA}/${seam.triangleIdB}</span>
        <span class="seam-actions">
          <span class="flag ${SEAM_STATUS_CLASS[status] ?? 'muted'}">${SEAM_STATUS_LABEL[status] ?? status} ${split}</span>
          <button type="button" data-action="delete-seam" data-seam="${escapeHtml(seam.id)}" title="删除声明">删除</button>
        </span>
      </div>`;
    })
    .join('');
}

/** Details for the current selection (vertex / triangle / seam / none). */
export function localDetailHtml(snapshot: Snapshot): { label: string; html: string } {
  const selection = snapshot.selection;
  const diagnostics = snapshot.diagnostics;
  const document = snapshot.document;

  if (selection.kind === 'none') {
    return {
      label: '未选中',
      html: '<p class="hint">在布面或纹理坐标画布中点选顶点、三角形或拼缝；拖动控制点即可观察局部拉伸。</p>',
    };
  }

  if (selection.kind === 'vertex' && selection.vertex !== undefined) {
    const vertex = document.vertices[selection.vertex];
    if (!vertex) return { label: `顶点 ${selection.vertex}`, html: '<p class="hint">顶点不存在。</p>' };
    const usedBy = document.triangles.filter((t) => t.vertices.includes(selection.vertex!)).length;
    const flags = vertex.pinned ? '<span class="flag muted">已固定</span>' : '';
    return {
      label: `顶点 ${selection.vertex}`,
      html: `
        <dl class="kv">
          <dt>布面位置</dt><dd>(${fmt(vertex.x)}, ${fmt(vertex.y)})</dd>
          <dt>相邻三角</dt><dd>${usedBy}</dd>
        </dl>
        <div class="action-row">
          <button type="button" data-action="toggle-pin">${vertex.pinned ? '取消固定' : '固定顶点'}</button>
          <button type="button" data-action="frame-vertex">缩放到此</button>
        </div>
        <div class="row-flags">${flags}</div>`,
    };
  }

  if (selection.kind === 'triangle' && selection.triangle !== undefined) {
    const metric = diagnostics.triangleById.get(selection.triangle);
    const tri = document.triangles.find((t) => t.id === selection.triangle);
    if (!metric || !tri) {
      return { label: `三角形 ${selection.triangle}`, html: '<p class="hint">三角形不存在。</p>' };
    }
    const flags: string[] = [];
    if (metric.flipped) flags.push('<span class="flag danger">翻面</span>');
    if (metric.collapsed) flags.push('<span class="flag danger">塌陷</span>');
    if (metric.overStretched) flags.push('<span class="flag warn">明显拉伸</span>');
    if (metric.compressed) flags.push('<span class="flag warn">压缩</span>');
    if (!metric.bad) flags.push('<span class="flag ok">正常</span>');
    const uvs = metric.uvs.map((uv) => `(${fmt(uv.x, 3)}, ${fmt(uv.y, 3)})`).join(' ');
    const points = metric.points.map((p) => `(${fmt(p.x, 1)}, ${fmt(p.y, 1)})`).join(' ');
    return {
      label: `三角形 ${selection.triangle}`,
      html: `
        <dl class="kv">
          <dt>纹理面积</dt><dd>${fmt(metric.areaTex, 5)} uv²</dd>
          <dt>布面面积</dt><dd>${fmt(metric.areaFabric, 3)}</dd>
          <dt>雅可比 det</dt><dd>${fmt(metric.determinant, 3)}</dd>
          <dt>拉伸比</dt><dd>相对中位 ${fmt(metric.stretchRatio, 3)}× · 各向异性 ${fmt(metric.anisotropy, 3)}×</dd>
          <dt>奇异值</dt><dd>${fmt(metric.minStretch, 3)} … ${fmt(metric.stretch, 3)}</dd>
          <dt>顶点</dt><dd>${tri.vertices.join(', ')}</dd>
          <dt>布面坐标</dt><dd>${points}</dd>
          <dt>角点 UV</dt><dd>${uvs}</dd>
        </dl>
        <div class="row-flags">${flags.join('')}</div>
        <p class="hint">在纹理坐标画布拖动该三角形的角点，可直接编辑两侧取样。</p>`,
    };
  }

  if (selection.kind === 'seam' && selection.seam) {
    const metrics = diagnostics.seamById.get(selection.seam);
    const resolved = snapshot.document.seams.find((s) => s.id === selection.seam);
    if (!metrics) return { label: `拼缝 ${selection.seam}`, html: '<p class="hint">拼缝数据缺失。</p>' };
    const rows = metrics.samples
      .map(
        (sample) =>
          `<tr><td>${fmt(sample.t, 2)}</td><td>${fmt(sample.uvA.x, 3)}, ${fmt(sample.uvA.y, 3)}</td><td>${fmt(sample.uvB.x, 3)}, ${fmt(sample.uvB.y, 3)}</td><td>${fmt(sample.splitDistanceLength, 4)}</td></tr>`,
      )
      .join('');
    const statusFlag = `<span class="flag ${SEAM_STATUS_CLASS[metrics.status] ?? 'muted'}">${SEAM_STATUS_LABEL[metrics.status] ?? metrics.status}</span>`;
    const sideA = diagnostics.seamById.get(selection.seam)?.triangleIdA ?? 0;
    const sideB = diagnostics.seamById.get(selection.seam)?.triangleIdB ?? 0;
    return {
      label: `拼缝 ${selection.seam}`,
      html: `
        <dl class="kv">
          <dt>声明类型</dt><dd>${resolved?.kind === 'split' ? '断开' : '连续'}（${resolved ? '已声明' : '自动检测'}）</dd>
          <dt>两侧三角</dt><dd>${sideA} ↔ ${sideB}</dd>
          <dt>最大 UV 偏差</dt><dd>${Number.isFinite(metrics.maxSplit) ? `${fmt(metrics.maxSplit, 4)} uv` : '—'}</dd>
          <dt>原始偏差</dt><dd>${Number.isFinite(metrics.maxSplitRaw) ? `${fmt(metrics.maxSplitRaw, 4)} uv` : '—'}</dd>
          <dt>边长不匹配</dt><dd>${fmt(metrics.lengthMismatch, 4)} uv</dd>
          <dt>布面长度</dt><dd>${fmt(metrics.fabricLength, 2)}</dd>
        </dl>
        <div class="row-flags">${statusFlag}${metrics.repeatMismatch ? '<span class="flag warn">整重复位错开</span>' : ''}</div>
        <table class="sample-table">
          <thead><tr><th>t</th><th>UV(A)</th><th>UV(B)</th><th>偏差</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`,
    };
  }

  return { label: '未选中', html: '' };
}

/** Export status text after an export action. */
export function exportStatusText(doc: { triangles: unknown[]; seams: unknown[] }, fingerprint: string): string {
  return `mesh.json · ${doc.triangles.length} 三角形 · ${doc.seams.length} 声明拼缝\n指纹 ${fingerprint}`;
}

export { documentFingerprint };
