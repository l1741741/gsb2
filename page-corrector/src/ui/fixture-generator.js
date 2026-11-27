// 在浏览器里自生成三种「扫描问题页」：
// 先在平整纸面上画网格与核对标记，再按 fixtures.js 的真值四角做透视投影，
// 叠加桌面、翻页阴影、不均匀光照；边缘难辨页额外降低对比并柔化边缘。

import { getFixtureTruth } from '../core/fixtures.js';
import { findHomography, warpImage } from '../core/geometry.js';

export const PAPER_W = 900;
export const PAPER_H = Math.round((PAPER_W * 297) / 210); // 1273

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paperPoint(p) {
  return { x: p.x * PAPER_W, y: p.y * PAPER_H };
}

/** 在平整纸面坐标上绘制网格页内容（坐标全部来自归一化纸面坐标）。 */
export function drawPaperContent(ctx, truth) {
  const W = PAPER_W;
  const H = PAPER_H;
  const v = truth.visual;

  ctx.fillStyle = v.paper;
  ctx.fillRect(0, 0, W, H);

  // 轻微纸纹
  const rand = mulberry32(20261127);
  for (let i = 0; i < 2600; i += 1) {
    const x = rand() * W;
    const y = rand() * H;
    ctx.fillStyle = rand() > 0.5 ? 'rgba(0,0,0,0.025)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(x, y, 1.4, 1.4);
  }

  // 外裁切线框
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 28, W - 56, H - 56);

  // 页眉与方向标记（逻辑「上方」）
  ctx.fillStyle = '#1d2733';
  ctx.textAlign = 'center';
  ctx.font = '700 40px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('档案网格核对页 · GRID CHECK SHEET', W / 2, 78);
  ctx.font = '600 30px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = v.accent;
  // 向上箭头 + TOP，倒转样例中它会随整页转到画面下方
  ctx.fillText('▲  TOP · 上方  ▲', W / 2, 126);

  // 网格区域 0.1..0.9，8 等分
  const g0 = paperPoint({ x: 0.1, y: 0.1 });
  const g1 = paperPoint({ x: 0.9, y: 0.9 });
  ctx.save();
  ctx.strokeStyle = v.grid;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.4;
  for (let k = 0; k <= 8; k += 1) {
    const t = k / 8;
    const x = g0.x + (g1.x - g0.x) * t;
    const y = g0.y + (g1.y - g0.y) * t;
    ctx.beginPath();
    ctx.moveTo(x, g0.y);
    ctx.lineTo(x, g1.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(g0.x, y);
    ctx.lineTo(g1.x, y);
    ctx.stroke();
  }
  ctx.restore();

  // 网格坐标编号
  ctx.fillStyle = v.grid;
  ctx.font = '500 18px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  for (let k = 0; k <= 8; k += 1) {
    const t = k / 8;
    const x = g0.x + (g1.x - g0.x) * t;
    ctx.fillText(String(k), x, g1.y + 26);
  }
  ctx.textAlign = 'right';
  for (let k = 0; k <= 8; k += 1) {
    const t = k / 8;
    const y = g0.y + (g1.y - g0.y) * t + 6;
    ctx.fillText(String(k), g0.x - 12, y);
  }

  // 核对点：醒目的红圈十字 + 编号
  truth.checkpoints.forEach((cp, idx) => {
    const p = paperPoint(cp.paper);
    ctx.save();
    ctx.strokeStyle = v.accent;
    ctx.fillStyle = v.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - 24, p.y);
    ctx.lineTo(p.x - 9, p.y);
    ctx.moveTo(p.x + 9, p.y);
    ctx.lineTo(p.x + 24, p.y);
    ctx.moveTo(p.x, p.y - 24);
    ctx.lineTo(p.x, p.y - 9);
    ctx.moveTo(p.x, p.y + 9);
    ctx.lineTo(p.x, p.y + 24);
    ctx.stroke();
    ctx.font = '700 22px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`P${idx + 1}`, p.x + 20, p.y - 18);
    ctx.restore();
  });

  // 页脚坐标说明
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font = '500 19px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('纸面归一化坐标 (u,v)：左上 (0,0) · 右下 (1,1)；A4 时 1u=210mm, 1v=297mm', W / 2, H - 46);
}

function quadPath(ctx, corners) {
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 4; i += 1) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
}

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * 生成一张源图 Canvas（1280×960）。
 * options.onProgress 可选。
 */
export async function generateFixtureCanvas(kind, options = {}) {
  const truth = getFixtureTruth(kind);
  const SW = truth.sourceWidth;
  const SH = truth.sourceHeight;
  const corners = truth.cornersPixels;

  // 1) 平整纸面
  const paperCanvas = document.createElement('canvas');
  paperCanvas.width = PAPER_W;
  paperCanvas.height = PAPER_H;
  const pctx = paperCanvas.getContext('2d');
  drawPaperContent(pctx, truth);
  const paperImage = pctx.getImageData(0, 0, PAPER_W, PAPER_H);

  // 2) 透视投影到整幅源图画布（框外透明）
  const paperCornersPx = [
    { x: 0, y: 0 },
    { x: PAPER_W, y: 0 },
    { x: PAPER_W, y: PAPER_H },
    { x: 0, y: PAPER_H },
  ];
  // 目标=源图帧坐标，源=纸面像素：paper = H(frame)
  const HFrameToPaper = findHomography(corners, paperCornersPx);
  const warped = await warpImage(paperImage, HFrameToPaper, SW, SH, {
    edge: 'transparent',
    yieldRows: 48,
  });
  options.onProgress?.(0.6);

  const warpedCanvas = document.createElement('canvas');
  warpedCanvas.width = SW;
  warpedCanvas.height = SH;
  warpedCanvas.getContext('2d').putImageData(
    new ImageData(warped.data, SW, SH),
    0,
    0,
  );

  // 3) 合成桌面背景 + 阴影 + 光照
  const canvas = document.createElement('canvas');
  canvas.width = SW;
  canvas.height = SH;
  const ctx = canvas.getContext('2d');
  const v = truth.visual;

  const deskGrad = ctx.createRadialGradient(SW * 0.42, SH * 0.35, 80, SW / 2, SH / 2, SW * 0.85);
  deskGrad.addColorStop(0, v.desk);
  deskGrad.addColorStop(1, v.deskDark);
  ctx.fillStyle = deskGrad;
  ctx.fillRect(0, 0, SW, SH);

  // 桌面噪点
  const rand = mulberry32(7 + kind.length * 131);
  for (let i = 0; i < 5000; i += 1) {
    ctx.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(rand() * SW, rand() * SH, 2, 2);
  }

  // 投影（在纸面下层）
  ctx.save();
  quadPath(ctx, corners);
  ctx.shadowColor = `rgba(0,0,0,${v.shadowAlpha})`;
  ctx.shadowBlur = 42;
  ctx.shadowOffsetX = 22;
  ctx.shadowOffsetY = 30;
  ctx.fillStyle = `rgba(0,0,0,${Math.min(0.5, v.shadowAlpha * 0.7)})`;
  ctx.fill();
  ctx.restore();

  // 透视纸面（边缘难辨页做柔化）
  ctx.save();
  if (v.blurPx > 0 && 'filter' in ctx) ctx.filter = `blur(${v.blurPx}px)`;
  ctx.drawImage(warpedCanvas, 0, 0);
  ctx.restore();

  // 翻页阴影：沿左边一条向内衰减的暗带（裁剪在四边形内）
  ctx.save();
  quadPath(ctx, corners);
  ctx.clip();
  const leftMid = lerp(corners[3], corners[0], 0.5);
  const rightMid = lerp(corners[2], corners[1], 0.5);
  const curlEnd = lerp(leftMid, rightMid, 0.16);
  const curlGrad = ctx.createLinearGradient(leftMid.x, leftMid.y, curlEnd.x, curlEnd.y);
  curlGrad.addColorStop(0, 'rgba(0,0,0,0.34)');
  curlGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = curlGrad;
  ctx.fillRect(0, 0, SW, SH);

  if (v.unevenLight) {
    const light = ctx.createRadialGradient(
      corners[0].x + 120, corners[0].y + 80, 40,
      SW * 0.5, SH * 0.5, SW * 0.75,
    );
    light.addColorStop(0, 'rgba(255,248,225,0.20)');
    light.addColorStop(0.55, 'rgba(255,255,255,0)');
    light.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, SW, SH);
  }
  ctx.restore();

  // 纸边描线（难辨页极淡）
  ctx.save();
  quadPath(ctx, corners);
  ctx.strokeStyle = v.lowContrastEdge
    ? `rgba(70,60,40,${v.edgeAlpha})`
    : 'rgba(40,32,20,0.55)';
  ctx.lineWidth = v.lowContrastEdge ? 2.5 : 2;
  ctx.stroke();
  ctx.restore();

  options.onProgress?.(1);
  return canvas;
}
