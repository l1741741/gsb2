// 单页完整导出管线（浏览器侧）：按原图全分辨率取像素并合成，再编码 PNG 与转换信息。

import { composePage } from '../core/compose.js';
import { buildTransformInfo } from '../core/export-meta.js';
import { canvasToPngBlob } from './files.js';

export async function imageToImageData(image, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * 处理一页。
 * @returns {Promise<{blob:Blob, info:object, width:number, height:number}>}
 */
export async function processPageFull(page, config, meta = {}, options = {}) {
  const sourceImage = await imageToImageData(page.image, page.width, page.height);
  const composed = await composePage(sourceImage, config, {
    signal: options.signal,
    onRow: (row, total) => options.onProgress?.(total ? row / total : 0),
    yieldRows: 24,
  });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = composed.width;
  outCanvas.height = composed.height;
  const outCtx = outCanvas.getContext('2d');
  outCtx.putImageData(new ImageData(composed.image.data, composed.width, composed.height), 0, 0);

  const blob = await canvasToPngBlob(outCanvas);
  const info = buildTransformInfo({
    sourceFile: page.name,
    sourceWidth: page.width,
    sourceHeight: page.height,
    config,
    outputWidth: composed.width,
    outputHeight: composed.height,
    pageKey: page.key,
    source: meta.configSource ?? 'template',
    checkpoints: meta.checkpoints ?? page.truth?.checkpoints ?? null,
    adopted: meta.adopted,
  });

  return { blob, info, width: composed.width, height: composed.height };
}
