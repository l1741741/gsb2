// 纸张比例预设与输出尺寸。

export const RATIO_PRESETS = [
  { id: 'a4', label: 'A4 纵向 (210:297)', w: 210, h: 297 },
  { id: 'a4-landscape', label: 'A4 横向 (297:210)', w: 297, h: 210 },
  { id: 'letter', label: 'Letter 纵向 (8.5:11)', w: 85, h: 110 },
  { id: 'square', label: '正方形 (1:1)', w: 1, h: 1 },
  { id: 'custom', label: '自定义比例…', w: 210, h: 297, custom: true },
];

export function ratioValue(ratio) {
  const w = Number(ratio?.w);
  const h = Number(ratio?.h);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h;
  return 210 / 297;
}

/**
 * 依据源图四角边长估算纸面比例（透视下只是近似，作为「按四角自适应」）。
 * 横向边长取上下边均值，纵向边长取左右边均值。
 */
export function autoRatioFromCorners(cornersPx) {
  const top = Math.hypot(cornersPx[1].x - cornersPx[0].x, cornersPx[1].y - cornersPx[0].y);
  const bottom = Math.hypot(cornersPx[2].x - cornersPx[3].x, cornersPx[2].y - cornersPx[3].y);
  const left = Math.hypot(cornersPx[3].x - cornersPx[0].x, cornersPx[3].y - cornersPx[0].y);
  const right = Math.hypot(cornersPx[2].x - cornersPx[1].x, cornersPx[2].y - cornersPx[1].y);
  const horizontal = (top + bottom) / 2;
  const vertical = (left + right) / 2;
  if (vertical <= 1e-6) return 210 / 297;
  return horizontal / vertical;
}

export const OUTPUT_WIDTH_PRESETS = [
  { value: 1240, label: '1240 px（约 150 dpi A4）' },
  { value: 1654, label: '1654 px（约 200 dpi A4）' },
  { value: 2480, label: '2480 px（约 300 dpi A4）' },
  { value: 3508, label: '3508 px（约 420 dpi A4，大图）' },
];
