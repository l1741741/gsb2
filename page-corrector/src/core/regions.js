// 保留区 / 遮挡区。区域以纸面归一化坐标存储，
// 因此重新修改四角后，区域在纸面上的位置不变，只会重新投影回源图。

import { mapPoint } from './geometry.js';

let regionSeq = 0;
export function createRegionId() {
  regionSeq += 1;
  return `r${Date.now().toString(36)}-${regionSeq}`;
}

/** 把任意方向拖出的框归一化为 {x,y,w,h}（纸面 0..1 坐标）。 */
export function normalizeRectDrag(x0, y0, x1, y1) {
  const round = (v) => Math.round(v * 1e12) / 1e12;
  const x = round(Math.max(0, Math.min(1, Math.min(x0, x1))));
  const y = round(Math.max(0, Math.min(1, Math.min(y0, y1))));
  const right = round(Math.max(0, Math.min(1, Math.max(x0, x1))));
  const bottom = round(Math.max(0, Math.min(1, Math.max(y0, y1))));
  return { x, y, w: round(right - x), h: round(bottom - y) };
}

export function rectPaperCorners(region) {
  return [
    { x: region.x, y: region.y },
    { x: region.x + region.w, y: region.y },
    { x: region.x + region.w, y: region.y + region.h },
    { x: region.x, y: region.y + region.h },
  ];
}

/** 纸面矩形四角投影到源图像素，得到源图上的四边形。 */
export function mapRectToSourceQuad(region, HPaperToSource) {
  return rectPaperCorners(region).map((p) => mapPoint(HPaperToSource, p.x, p.y));
}

/**
 * 校验区域坐标链路：纸面角点 -> 源图 -> 再映射回纸面，
 * 检查往返误差。四角修改后用它确认遮挡仍位于预期纸面坐标。
 *
 * 返回 { maxPaperError, meanPaperError, points:[{paper, roundTrip, error}] }
 * paperError 单位是「纸面归一化坐标」。
 */
export function checkRegionRoundTrip(region, HSourceToPaper, HPaperToSource) {
  const corners = rectPaperCorners(region);
  const points = corners.map((paper) => {
    const source = mapPoint(HPaperToSource, paper.x, paper.y);
    const back = mapPoint(HSourceToPaper, source.x, source.y);
    const error = Math.hypot(back.x - paper.x, back.y - paper.y);
    return { paper, source, roundTrip: back, error };
  });
  const errors = points.map((p) => p.error);
  const maxPaperError = Math.max(...errors);
  const meanPaperError = errors.reduce((a, b) => a + b, 0) / errors.length;
  return { maxPaperError, meanPaperError, points };
}

/** 分量版：给定 dx/dy 归一化误差与比例，返回毫米距离。 */
export function paperDeltaToMm(dx, dy, ratio) {
  const unitW = Number(ratio?.w) || 210;
  const unitH = Number(ratio?.h) || 297;
  // 比例单位本身就是毫米级名义尺寸（210:297、85:110 等），直接按该尺度解释。
  return Math.hypot(dx * unitW, dy * unitH);
}
