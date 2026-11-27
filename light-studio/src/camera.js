// 二维相机：世界坐标与屏幕像素坐标互转。
// 照明计算全部在世界坐标中完成，相机只改变绘制矩阵，
// 因此缩放和平移不会改变任何实际可照亮范围与照度值。

export class Camera {
  constructor({ scale = 1, x = 0, y = 0 } = {}) {
    this.scale = scale;
    this.x = x;
    this.y = y;
  }

  apply(context) {
    context.setTransform(this.scale, 0, 0, this.scale, this.x, this.y);
  }

  worldToScreen(point) {
    return { x: point.x * this.scale + this.x, y: point.y * this.scale + this.y };
  }

  screenToWorld(point) {
    return { x: (point.x - this.x) / this.scale, y: (point.y - this.y) / this.scale };
  }

  // 以屏幕上的锚点为不动点缩放，保证滚轮缩放手头下的世界位置不漂移。
  zoomAt(screenPoint, nextScale, minScale = 0.2, maxScale = 6) {
    const clamped = Math.min(maxScale, Math.max(minScale, nextScale));
    const world = this.screenToWorld(screenPoint);
    this.scale = clamped;
    this.x = screenPoint.x - world.x * clamped;
    this.y = screenPoint.y - world.y * clamped;
  }

  pan(dxScreen, dyScreen) {
    this.x += dxScreen;
    this.y += dyScreen;
  }

  // 让给定世界矩形完整居中显示在画布中。
  fitBounds(canvasWidth, canvasHeight, bounds, padding = 24) {
    this.scale = Math.min(
      (canvasWidth - padding * 2) / bounds.width,
      (canvasHeight - padding * 2) / bounds.height,
    );
    this.x = (canvasWidth - bounds.width * this.scale) / 2;
    this.y = (canvasHeight - bounds.height * this.scale) / 2;
  }
}
