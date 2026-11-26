// Pure pan/zoom coordinate math. Keeping this out of the DOM layer makes the
// screen->image conversion testable and prevents zoom-dependent pointer offset.

export function createView() {
  return { scale: 1, x: 0, y: 0 };
}

export function fitView(imageWidth, imageHeight, cssWidth, cssHeight, padding = 28) {
  if (!imageWidth || !imageHeight || !cssWidth || !cssHeight) return createView();
  const availableWidth = Math.max(1, cssWidth - padding * 2);
  const availableHeight = Math.max(1, cssHeight - padding * 2);
  const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight);
  return {
    scale: Math.max(0.01, scale),
    x: (cssWidth - imageWidth * scale) / 2,
    y: (cssHeight - imageHeight * scale) / 2,
  };
}

export function screenToImage(clientX, clientY, rect, view) {
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  return {
    cssX,
    cssY,
    x: (cssX - view.x) / view.scale,
    y: (cssY - view.y) / view.scale,
  };
}

export function imageToScreen(point, view) {
  return {
    x: point.x * view.scale + view.x,
    y: point.y * view.scale + view.y,
  };
}

export function zoomAt(view, cssX, cssY, factor, limits = { min: 0.05, max: 40 }) {
  const imageX = (cssX - view.x) / view.scale;
  const imageY = (cssY - view.y) / view.scale;
  const scale = Math.min(limits.max, Math.max(limits.min, view.scale * factor));
  return {
    scale,
    x: cssX - imageX * scale,
    y: cssY - imageY * scale,
  };
}

export function hitTestPoint(points, imagePoint, view, rect, maxScreenDistance = 11) {
  let best = null;
  let bestDistance = maxScreenDistance;
  for (const point of points) {
    const screenX = point.x * view.scale + view.x;
    const screenY = point.y * view.scale + view.y;
    const distance = Math.hypot(screenX - imagePoint.cssX, screenY - imagePoint.cssY);
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}
