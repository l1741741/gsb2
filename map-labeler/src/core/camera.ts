/**
 * 相机：地图坐标 <-> 屏幕坐标，支持缩放与旋转查看。
 * screen = R(rotation) · (map - center) · scale + viewport/2
 */
import type { Point, Rect } from './geometry.js';
import { rectFromCorners } from './geometry.js';
import type { CameraSnapshot } from './model.js';

export class Camera {
  centerX: number;
  centerY: number;
  scale: number;
  rotation: number;
  viewportWidth: number;
  viewportHeight: number;

  constructor(viewportWidth: number, viewportHeight: number, snapshot?: CameraSnapshot) {
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.centerX = snapshot?.centerX ?? 0;
    this.centerY = snapshot?.centerY ?? 0;
    this.scale = snapshot?.scale ?? 1;
    this.rotation = snapshot?.rotation ?? 0;
  }

  resize(viewportWidth: number, viewportHeight: number): void {
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
  }

  toScreen(p: Point): Point {
    const dx = (p.x - this.centerX) * this.scale;
    const dy = (p.y - this.centerY) * this.scale;
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    return {
      x: cos * dx - sin * dy + this.viewportWidth / 2,
      y: sin * dx + cos * dy + this.viewportHeight / 2,
    };
  }

  toMap(p: Point): Point {
    const sx = p.x - this.viewportWidth / 2;
    const sy = p.y - this.viewportHeight / 2;
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    const dx = cos * sx - sin * sy;
    const dy = sin * sx + cos * sy;
    return {
      x: dx / this.scale + this.centerX,
      y: dy / this.scale + this.centerY,
    };
  }

  /** 当前视口四个角在地图坐标系中的轴对齐包围盒（旋转后是保守范围）。 */
  viewBoundsInMap(): Rect {
    const corners: Point[] = [
      { x: 0, y: 0 },
      { x: this.viewportWidth, y: 0 },
      { x: this.viewportWidth, y: this.viewportHeight },
      { x: 0, y: this.viewportHeight },
    ].map((p) => this.toMap(p));
    const minX = Math.min(...corners.map((p) => p.x));
    const maxX = Math.max(...corners.map((p) => p.x));
    const minY = Math.min(...corners.map((p) => p.y));
    const maxY = Math.max(...corners.map((p) => p.y));
    return rectFromCorners(minX, minY, maxX, maxY);
  }

  /** 让给定地图范围完整适配视口（含边距），用于切换画布规格后的重算。 */
  fitToMapBounds(bounds: Rect, padding = 24): void {
    const sx = (this.viewportWidth - padding * 2) / bounds.width;
    const sy = (this.viewportHeight - padding * 2) / bounds.height;
    this.scale = Math.min(sx, sy);
    this.centerX = bounds.x + bounds.width / 2;
    this.centerY = bounds.y + bounds.height / 2;
    this.rotation = 0;
  }

  snapshot(): CameraSnapshot {
    return {
      centerX: this.centerX,
      centerY: this.centerY,
      scale: this.scale,
      rotation: this.rotation,
    };
  }

  restore(snapshot: CameraSnapshot): void {
    this.centerX = snapshot.centerX;
    this.centerY = snapshot.centerY;
    this.scale = snapshot.scale;
    this.rotation = snapshot.rotation;
  }
}
