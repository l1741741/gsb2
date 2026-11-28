// 项目导出 / 导入：把墙面参数、画面布置、定位点及其展开坐标序列化为 JSON，
// 导入时完整校验（非法角、越界画面、相互冲突的定位点都会逐条指出）。

import {
  makeWall,
  arcLengthMm,
  validateArtwork,
  validateAnchors,
} from './geometry.js';

export const PROJECT_FORMAT = 'gsb2-wall-preview/1';

/**
 * 生成导出对象。unwrapped 一节给出展开坐标（mm，原点在起始边底角）：
 * 满圈时 artworkRectMm.x1 可能大于 arcLengthMm，表示画面跨过起止缝回绕。
 */
export function buildExport({ wall, artwork, anchors, imageDataUrl = null }) {
  const length = arcLengthMm(wall);
  return {
    format: PROJECT_FORMAT,
    wall: { ...wall },
    artwork: artwork
      ? {
          imageName: artwork.imageName ?? null,
          imageWidthPx: artwork.imageWidthPx ?? null,
          imageHeightPx: artwork.imageHeightPx ?? null,
          offsetMm: artwork.offsetMm,
          widthMm: artwork.widthMm,
          bottomMm: artwork.bottomMm,
          heightMm: artwork.heightMm,
          imageDataUrl: imageDataUrl ?? artwork.imageDataUrl ?? null,
        }
      : null,
    anchors: anchors.map((anchor) => ({
      id: anchor.id,
      name: anchor.name ?? anchor.id,
      arcMm: anchor.arcMm,
      heightMm: anchor.heightMm,
    })),
    unwrapped: {
      origin: '起始边底角，x 沿弧长向右，y 向上，单位 mm',
      arcLengthMm: length,
      heightMm: wall.heightMm,
      artworkRectMm: artwork
        ? {
            x0: artwork.offsetMm,
            y0: artwork.bottomMm,
            x1: artwork.offsetMm + artwork.widthMm,
            y1: artwork.bottomMm + artwork.heightMm,
          }
        : null,
      anchors: anchors.map((anchor) => ({
        id: anchor.id,
        xMm: anchor.arcMm,
        yMm: anchor.heightMm,
      })),
    },
  };
}

export function serializeProject(project) {
  return JSON.stringify(buildExport(project), null, 2);
}

/**
 * 解析并校验项目 JSON。
 * 返回 { ok: true, project: { wall, artwork, anchors } } 或 { ok: false, errors: [...] }。
 */
export function parseProject(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, errors: [`JSON 解析失败：${error.message}`] };
  }
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { ok: false, errors: ['项目文件内容不是 JSON 对象'] };
  }
  if (data.format !== PROJECT_FORMAT) {
    errors.push(`文件格式不符（期望 ${PROJECT_FORMAT}，实际 ${data.format ?? '缺失'}）`);
  }

  let wall = null;
  if (!data.wall || typeof data.wall !== 'object') {
    errors.push('缺少 wall 参数');
  } else {
    try {
      wall = makeWall(data.wall);
    } catch (error) {
      errors.push(...(error.validationErrors ?? [error.message]));
    }
  }

  let artwork = null;
  if (data.artwork !== null && data.artwork !== undefined) {
    if (typeof data.artwork !== 'object') {
      errors.push('artwork 字段不是对象');
    } else {
      artwork = {
        imageName: data.artwork.imageName ?? null,
        imageWidthPx: data.artwork.imageWidthPx ?? null,
        imageHeightPx: data.artwork.imageHeightPx ?? null,
        imageDataUrl: data.artwork.imageDataUrl ?? null,
        offsetMm: data.artwork.offsetMm,
        widthMm: data.artwork.widthMm,
        bottomMm: data.artwork.bottomMm,
        heightMm: data.artwork.heightMm,
      };
      if (wall) {
        errors.push(...validateArtwork(wall, artwork));
      }
    }
  }

  let anchors = [];
  if (data.anchors !== undefined && !Array.isArray(data.anchors)) {
    errors.push('anchors 字段不是数组');
  } else {
    anchors = (data.anchors ?? []).map((anchor, index) => ({
      id: anchor?.id ?? `P${index + 1}`,
      name: anchor?.name ?? anchor?.id ?? `P${index + 1}`,
      arcMm: anchor?.arcMm,
      heightMm: anchor?.heightMm,
    }));
    if (wall) {
      errors.push(...validateAnchors(wall, anchors));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, project: { wall, artwork, anchors } };
}
