// 页面合成：透视校正 + 遮挡区填色，全部在 RGBA buffer 上完成，
// 这样导出逻辑可在 Node 中测试；浏览器只需把 buffer 放进 Canvas。

import {
  normalizedCornersToPixels,
  outputPixelsToSourceHomography,
  paperPixelSize,
  warpImage,
} from './geometry.js';
import { ratioValue } from './paper.js';

export function hexToRgb(hex) {
  let text = String(hex || '#ffffff').trim().replace(/^#/, '');
  if (text.length === 3) text = text.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return { r: 255, g: 255, b: 255 };
  const value = parseInt(text, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** 在 RGBA buffer 上填一个矩形（坐标为输出纸面像素，半像素边界取整）。 */
export function fillRectRGBA(image, x, y, w, h, color) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(image.width, Math.ceil(x + w));
  const y1 = Math.min(image.height, Math.ceil(y + h));
  const { r, g, b } = hexToRgb(color);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const i = (py * image.width + px) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  return image;
}

/**
 * 合成一页：
 * 1) 用四角把源图透视重采样到统一纸面像素；
 * 2) 把启用的遮挡区按纸面坐标填实色。
 *
 * sourceImage: {width,height,data} RGBA
 * config: 已 normalize 的页面配置
 * options.signal / onRow 透传给 warp
 */
export async function composePage(sourceImage, config, options = {}) {
  const width = sourceImage.width;
  const height = sourceImage.height;
  const cornersPx = normalizedCornersToPixels(config.cornersNormalized, width, height);
  const ratio = ratioValue(config.ratio);
  const { width: outW, height: outH } = paperPixelSize(ratio, config.outputWidth);
  const H = outputPixelsToSourceHomography(cornersPx, outW, outH);

  const output = await warpImage(sourceImage, H, outW, outH, {
    edge: 'clamp',
    signal: options.signal,
    onRow: options.onRow,
    yieldRows: options.yieldRows,
  });

  const masks = [];
  for (const region of config.regions || []) {
    if (region.type !== 'mask' || region.enabled === false) continue;
    const rx = region.x * outW;
    const ry = region.y * outH;
    const rw = region.w * outW;
    const rh = region.h * outH;
    fillRectRGBA(output, rx, ry, rw, rh, config.maskColor);
    masks.push({ region, pixels: { x: rx, y: ry, w: rw, h: rh } });
  }

  return { image: output, width: outW, height: outH, cornersPx, masks };
}
