export class CanvasRenderer {
  constructor(context) {
    if (!context || typeof context.save !== 'function' || typeof context.restore !== 'function') {
      throw new TypeError('a Canvas 2D rendering context is required');
    }
    this.context = context;
  }

  render(root, { clear = true, width, height } = {}) {
    if (!root || typeof root !== 'object') {
      throw new TypeError('root must be a scene node');
    }
    const viewportWidth = width ?? this.context.canvas?.width;
    const viewportHeight = height ?? this.context.canvas?.height;
    if (clear) {
      if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)) {
        throw new TypeError('viewport width and height are required when clearing');
      }
      this.context.clearRect(0, 0, viewportWidth, viewportHeight);
    }
    this.#drawNode(root);
  }

  #drawNode(node) {
    if (node.visible === false || node.opacity === 0) return;
    const context = this.context;
    context.save();
    try {
      if (node.x !== 0 || node.y !== 0) context.translate(node.x, node.y);
      if (node.rotation !== 0) context.rotate(node.rotation);
      if (node.scaleX !== 1 || node.scaleY !== 1) context.scale(node.scaleX, node.scaleY);
      if (node.opacity !== 1) context.globalAlpha *= node.opacity;

      switch (node.type) {
        case 'group':
          this.#drawChildren(node.children);
          break;
        case 'rectangle':
          this.#drawRectangle(node);
          break;
        case 'circle':
          this.#drawCircle(node);
          break;
        case 'sprite':
          this.#drawSprite(node);
          break;
        default:
          throw new TypeError(`unsupported scene node type: ${node.type}`);
      }
    } finally {
      context.restore();
    }
  }

  #drawChildren(children) {
    const ordered = children
      .map((node, index) => ({ node, index }))
      .sort((a, b) => a.node.zIndex - b.node.zIndex || a.index - b.index);
    for (const { node } of ordered) this.#drawNode(node);
  }

  #drawRectangle(node) {
    const context = this.context;
    if (node.fill !== null) {
      context.fillStyle = node.fill;
      context.fillRect(0, 0, node.width, node.height);
    }
    if (node.stroke !== null && node.lineWidth > 0) {
      context.strokeStyle = node.stroke;
      context.lineWidth = node.lineWidth;
      context.strokeRect(0, 0, node.width, node.height);
    }
  }

  #drawCircle(node) {
    const context = this.context;
    if (node.fill === null && (node.stroke === null || node.lineWidth === 0)) return;
    context.beginPath();
    context.arc(0, 0, node.radius, 0, Math.PI * 2);
    if (node.fill !== null) {
      context.fillStyle = node.fill;
      context.fill();
    }
    if (node.stroke !== null && node.lineWidth > 0) {
      context.strokeStyle = node.stroke;
      context.lineWidth = node.lineWidth;
      context.stroke();
    }
  }

  #drawSprite(node) {
    const { image, source, width, height } = node;
    if (source) {
      this.context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, width, height);
    } else {
      this.context.drawImage(image, 0, 0, width, height);
    }
  }
}
