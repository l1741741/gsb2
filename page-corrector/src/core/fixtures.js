// 自生成核对样例的纯数据规格。
// 三种页：斜拍网格页、倒转页、边缘难辨页。
// 生成器按这里的「真值四角」把纸面内容透视投到源图上，
// 因此每个核对点的源图像素坐标都是数学上已知的，可用于精度核对与自动化测试。

import { paperNormToSourcePixels, mapPoint } from './geometry.js';

export const FIXTURE_SOURCE_WIDTH = 1280;
export const FIXTURE_SOURCE_HEIGHT = 960;

// 统一使用 A4 纵向比例，纸面归一化坐标乘 (210,297) 即近似毫米。
export const FIXTURE_RATIO = { id: 'a4', w: 210, h: 297 };

/**
 * 网格从纸面 (0.1,0.1) 到 (0.9,0.9)，8 等分，
 * 网格线索引 k 对应归一化坐标 0.1 + k*0.1。
 * 下列核对点选取若干整数网格交点 + 中心。
 */
export const FIXTURE_CHECKPOINT_PAPER = [
  { id: 'cp-1-1', grid: [1, 1], paper: { x: 0.2, y: 0.2 }, label: '网格交点 (1,1)' },
  { id: 'cp-4-1', grid: [4, 1], paper: { x: 0.5, y: 0.2 }, label: '网格交点 (4,1)' },
  { id: 'cp-7-2', grid: [7, 2], paper: { x: 0.8, y: 0.3 }, label: '网格交点 (7,2)' },
  { id: 'cp-center', grid: [4, 4], paper: { x: 0.5, y: 0.5 }, label: '网格中心 (4,4)' },
  { id: 'cp-2-5', grid: [2, 5], paper: { x: 0.3, y: 0.6 }, label: '网格交点 (2,5)' },
  { id: 'cp-6-7', grid: [6, 7], paper: { x: 0.7, y: 0.8 }, label: '网格交点 (6,7)' },
];

export const FIXTURE_SPECS = {
  'grid-oblique': {
    kind: 'grid-oblique',
    name: '斜拍网格页',
    description: '明显透视倾斜、带翻页阴影的斜拍 A4 网格页',
    sourceWidth: FIXTURE_SOURCE_WIDTH,
    sourceHeight: FIXTURE_SOURCE_HEIGHT,
    ratio: FIXTURE_RATIO,
    // 逻辑阅读顺序 左上->右上->右下->左下 在斜拍源图中的真实像素位置
    cornersPixels: [
      { x: 252, y: 148 },
      { x: 1038, y: 82 },
      { x: 1128, y: 852 },
      { x: 168, y: 898 },
    ],
    visual: {
      desk: '#5b554c',
      deskDark: '#3c3832',
      paper: '#f4f1e8',
      grid: '#2f6fb0',
      accent: '#c0392b',
      edgeAlpha: 1,
      blurPx: 0,
      shadowAlpha: 0.5,
      unevenLight: true,
      inverted: false,
      lowContrastEdge: false,
    },
  },
  inverted: {
    kind: 'inverted',
    name: '倒转页',
    description: '整页在照片中旋转 180°；按内容阅读方向框选四角后导出应为正立',
    sourceWidth: FIXTURE_SOURCE_WIDTH,
    sourceHeight: FIXTURE_SOURCE_HEIGHT,
    ratio: FIXTURE_RATIO,
    // 逻辑「左上」（标题/箭头一侧）出现在画面右下方
    cornersPixels: [
      { x: 1032, y: 828 },
      { x: 262, y: 892 },
      { x: 192, y: 152 },
      { x: 1108, y: 92 },
    ],
    visual: {
      desk: '#4f5a52',
      deskDark: '#343c37',
      paper: '#f2efe6',
      grid: '#3a7d5d',
      accent: '#b8860b',
      edgeAlpha: 1,
      blurPx: 0,
      shadowAlpha: 0.45,
      unevenLight: true,
      inverted: true,
      lowContrastEdge: false,
    },
  },
  'hard-edge': {
    kind: 'hard-edge',
    name: '边缘难辨页',
    description: '纸面与桌面明度接近、边缘柔化并有不均匀光照，四角不易肉眼分辨',
    sourceWidth: FIXTURE_SOURCE_WIDTH,
    sourceHeight: FIXTURE_SOURCE_HEIGHT,
    ratio: FIXTURE_RATIO,
    cornersPixels: [
      { x: 214, y: 132 },
      { x: 1066, y: 150 },
      { x: 1048, y: 876 },
      { x: 232, y: 858 },
    ],
    visual: {
      // 低对比：桌面与纸面颜色非常接近
      desk: '#cfc7b6',
      deskDark: '#b3aa97',
      paper: '#ddd6c6',
      grid: '#8d8574',
      accent: '#9c6b3f',
      edgeAlpha: 0.35,
      blurPx: 1.4,
      shadowAlpha: 0.18,
      unevenLight: true,
      inverted: false,
      lowContrastEdge: true,
    },
  },
};

export const FIXTURE_KINDS = Object.keys(FIXTURE_SPECS);

/**
 * 返回带完整真值的 fixture：
 * cornersNormalized + checkpoints[].source（由真值四角经单应投影算出）。
 */
export function getFixtureTruth(kind) {
  const spec = FIXTURE_SPECS[kind];
  if (!spec) throw new Error(`未知示例类型: ${kind}`);
  const { sourceWidth: w, sourceHeight: h, cornersPixels } = spec;
  const cornersNormalized = cornersPixels.map((p) => ({ x: p.x / w, y: p.y / h }));
  const HPaperToSource = paperNormToSourcePixels(cornersPixels);
  const checkpoints = FIXTURE_CHECKPOINT_PAPER.map((cp) => ({
    ...cp,
    source: mapPoint(HPaperToSource, cp.paper.x, cp.paper.y),
    paperMm: { x: cp.paper.x * 210, y: cp.paper.y * 297 },
  }));
  return { ...spec, cornersNormalized, checkpoints };
}

/** 全部示例的核对坐标表（README/界面共用同一份数据）。 */
export function allFixtureCheckpointTables() {
  return FIXTURE_KINDS.map((kind) => {
    const truth = getFixtureTruth(kind);
    return {
      kind,
      name: truth.name,
      description: truth.description,
      sourceSize: { width: truth.sourceWidth, height: truth.sourceHeight },
      cornersPixels: truth.cornersPixels,
      checkpoints: truth.checkpoints,
    };
  });
}
