// 逐页导出的坐标转换信息（PNG 旁边的 .transform.json）。
// 明确给出四套坐标系与矩阵，后续识别可以在原图坐标和统一纸面坐标间互转。

import {
  paperNormToSourcePixels,
  sourcePixelsToPaperNorm,
  findHomography,
} from './geometry.js';
import { ratioValue } from './paper.js';

export const TRANSFORM_INFO_VERSION = 1;

function matrixToRows(m) {
  return [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ];
}

/**
 * @param meta.sourceFile 原文件名
 * @param meta.sourceWidth/Height 原图尺寸
 * @param meta.config 生效配置
 * @param meta.outputWidth/Height 导出 PNG 尺寸
 * @param meta.pageKey
 * @param meta.source 'template'|'override'
 * @param meta.checkpoints 可选核对点（示例页真值）
 */
export function buildTransformInfo(meta) {
  const {
    sourceFile,
    sourceWidth,
    sourceHeight,
    config,
    outputWidth,
    outputHeight,
    pageKey,
    source = 'template',
    checkpoints = null,
    adopted = undefined,
  } = meta;

  const cornersNormalized = config.cornersNormalized.map((p) => ({ x: p.x, y: p.y }));
  const cornersPixels = cornersNormalized.map((p) => ({
    x: p.x * sourceWidth,
    y: p.y * sourceHeight,
  }));

  // 归一化源图坐标 [0,1]²（相对原图宽高）↔ 纸面归一化坐标 [0,1]²
  const srcNormCorners = cornersNormalized;
  const paperNormCorners = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const HSourceNormToPaper = findHomography(srcNormCorners, paperNormCorners);
  const HPaperToSourceNorm = findHomography(paperNormCorners, srcNormCorners);

  // 源像素 ↔ 纸面归一化
  const HSourcePxToPaper = sourcePixelsToPaperNorm(cornersPixels);
  const HPaperToSourcePx = paperNormToSourcePixels(cornersPixels);

  // 导出 PNG 像素 ↔ 纸面归一化（纯缩放）
  const paperPixelCorners = [
    { x: 0, y: 0 },
    { x: outputWidth, y: 0 },
    { x: outputWidth, y: outputHeight },
    { x: 0, y: outputHeight },
  ];
  const HPaperPxToPaperNorm = findHomography(
    paperPixelCorners,
    paperNormCorners,
  );
  const HPaperNormToPaperPx = findHomography(
    paperNormCorners,
    paperPixelCorners,
  );

  const ratio = ratioValue(config.ratio);

  return {
    tool: 'page-corrector',
    transformInfoVersion: TRANSFORM_INFO_VERSION,
    pageKey,
    sourceFile,
    configSource: source,
    ...(adopted === undefined ? {} : { adopted }),
    sourceImage: { width: sourceWidth, height: sourceHeight },
    paper: {
      coordinateSystem: 'paper-normalized',
      origin: 'top-left',
      axes: 'x-right, y-down',
      unit: 'normalized [0,1]',
      ratio: { id: config.ratio.id, widthUnit: config.ratio.w, heightUnit: config.ratio.h, widthOverHeight: ratio },
      nominalSize: { widthUnit: config.ratio.w, heightUnit: config.ratio.h, note: '比例单位；A4 预设下可按毫米理解' },
      exportedPixels: { width: outputWidth, height: outputHeight },
    },
    cornerOrder: ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'],
    corners: {
      sourcePixels: cornersPixels,
      sourceNormalized: cornersNormalized,
    },
    matricesRowMajor: {
      // 齐次坐标 [x,y,1]，映射后除以第三分量
      sourceNormalizedToPaperNormalized: HSourceNormToPaper,
      paperNormalizedToSourceNormalized: HPaperToSourceNorm,
      sourcePixelsToPaperNormalized: HSourcePxToPaper,
      paperNormalizedToSourcePixels: HPaperToSourcePx,
      paperPixelsToPaperNormalized: HPaperPxToPaperNorm,
      paperNormalizedToPaperPixels: HPaperNormToPaperPx,
    },
    matricesRows3x3: {
      sourceNormalizedToPaperNormalized: matrixToRows(HSourceNormToPaper),
      paperNormalizedToSourceNormalized: matrixToRows(HPaperToSourceNorm),
    },
    formulas: {
      sourceNormalizedToPaper:
        "p' = normalize(H_srcNorm_to_paper * [x/W, y/H, 1])；见 matricesRowMajor.sourceNormalizedToPaperNormalized",
      paperToSourcePixels:
        "s = normalize(H_paper_to_sourcePx * [u, v, 1])；见 matricesRowMajor.paperNormalizedToSourcePixels",
      paperToExportPixel:
        'X = u * exportWidth; Y = v * exportHeight',
    },
    regions: (config.regions || []).map((r) => ({
      id: r.id,
      type: r.type,
      enabled: r.enabled !== false,
      shape: 'rect',
      paperNormalized: { x: r.x, y: r.y, w: r.w, h: r.h },
      paperMmApprox: {
        // A4 时 ratio.w/h 即 210/297 mm；其它比例只是比例单位
        x: r.x * config.ratio.w,
        y: r.y * config.ratio.h,
        w: r.w * config.ratio.w,
        h: r.h * config.ratio.h,
      },
    })),
    ...(checkpoints ? { checkpoints } : {}),
  };
}
