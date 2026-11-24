const DEFAULT_TRANSFORM = Object.freeze({
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1,
  visible: true,
  zIndex: 0,
});

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function nonNegativeNumber(value, name) {
  finiteNumber(value, name);
  if (value < 0) {
    throw new RangeError(`${name} must be non-negative`);
  }
  return value;
}

function transform(options) {
  const result = { ...DEFAULT_TRANSFORM };
  for (const key of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'zIndex']) {
    if (options[key] !== undefined) result[key] = finiteNumber(options[key], key);
  }
  if (options.opacity !== undefined) {
    result.opacity = finiteNumber(options.opacity, 'opacity');
    if (result.opacity < 0 || result.opacity > 1) {
      throw new RangeError('opacity must be between 0 and 1');
    }
  }
  if (options.visible !== undefined) {
    if (typeof options.visible !== 'boolean') {
      throw new TypeError('visible must be a boolean');
    }
    result.visible = options.visible;
  }
  return result;
}

export function group(options = {}) {
  const children = options.children ?? [];
  if (!Array.isArray(children) || children.some((child) => !child || typeof child !== 'object')) {
    throw new TypeError('children must be an array of scene nodes');
  }
  return { type: 'group', ...transform(options), children: [...children] };
}

export function rectangle(options = {}) {
  const { width, height } = options;
  if (width === undefined || height === undefined) {
    throw new TypeError('rectangle width and height are required');
  }
  return {
    type: 'rectangle',
    ...transform(options),
    width: nonNegativeNumber(width, 'width'),
    height: nonNegativeNumber(height, 'height'),
    fill: options.fill ?? null,
    stroke: options.stroke ?? null,
    lineWidth: nonNegativeNumber(options.lineWidth ?? 1, 'lineWidth'),
  };
}

export function circle(options = {}) {
  if (options.radius === undefined) {
    throw new TypeError('circle radius is required');
  }
  return {
    type: 'circle',
    ...transform(options),
    radius: nonNegativeNumber(options.radius, 'radius'),
    fill: options.fill ?? null,
    stroke: options.stroke ?? null,
    lineWidth: nonNegativeNumber(options.lineWidth ?? 1, 'lineWidth'),
  };
}

export function sprite(options = {}) {
  if (!options.image) throw new TypeError('sprite image is required');
  if (options.width === undefined || options.height === undefined) {
    throw new TypeError('sprite width and height are required');
  }
  let source = null;
  if (options.source !== undefined && options.source !== null) {
    const { x, y, width, height } = options.source;
    source = {
      x: nonNegativeNumber(x, 'source.x'),
      y: nonNegativeNumber(y, 'source.y'),
      width: nonNegativeNumber(width, 'source.width'),
      height: nonNegativeNumber(height, 'source.height'),
    };
  }
  return {
    type: 'sprite',
    ...transform(options),
    image: options.image,
    source,
    width: nonNegativeNumber(options.width, 'width'),
    height: nonNegativeNumber(options.height, 'height'),
  };
}
