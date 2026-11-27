/** map-labeler 库统一入口：核心排版逻辑与 DOM 无关，可在 Node 与浏览器中复用。 */
export * from './core/geometry.js';
export * from './core/model.js';
export * from './core/text-measurer.js';
export * from './core/camera.js';
export * from './core/conflicts.js';
export * from './core/layout.js';
export * from './core/design.js';
export { MapCanvasRenderer, DEFAULT_PALETTE, hitTestLabel } from './render/canvas-renderer.js';
export type { RenderInput, RenderPalette } from './render/canvas-renderer.js';
export {
  buildExportManifest,
  buildDesignDocument,
  renderToPng,
} from './render/export.js';
export type { ExportManifest } from './render/export.js';
