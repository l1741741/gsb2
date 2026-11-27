/**
 * 浏览器入口：与 index.ts 相同的几何与绘制能力，但不加载
 * 依赖 node:zlib 的 HeadlessCanvas（PNG 编码在浏览器端直接用 canvas.toBlob）。
 */
export * from './geometry/types.js';
export * from './geometry/primitives.js';
export * from './geometry/validate.js';
export * from './geometry/hierarchy.js';
export * from './geometry/offset.js';
export * from './geometry/export.js';
export * from './geometry/examples.js';
export * from './render/canvas-draw.js';
