// Output geometry, direct ideal->source resampling, and valid-rectangle logic.
import { idealToSource } from './math.js';

export function defaultCrop(columns, rows) {
  return {
    col0: -0.5,
    row0: -0.5,
    col1: Math.max(0, columns - 1) + 0.5,
    row1: Math.max(0, rows - 1) + 0.5,
  };
}

export function outputSize(output) {
  const width = Math.max(1, Math.round((output.crop.col1 - output.crop.col0) * output.cellPx));
  const height = Math.max(1, Math.round((output.crop.row1 - output.crop.row0) * output.cellPx));
  return { width, height };
}

function readRgba(data, index) {
  return [data[index], data[index + 1], data[index + 2], data[index + 3]];
}

// Returns premultiplied bilinear RGBA. Null means the inverse-warped position
// is outside the source image and the output pixel must stay transparent.
export function bilinearSample(source, x, y) {
  const { data, width, height } = source;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;

  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  const p00 = readRgba(data, i00);
  const p10 = readRgba(data, i10);
  const p01 = readRgba(data, i01);
  const p11 = readRgba(data, i11);

  const weights = [
    (1 - fx) * (1 - fy),
    fx * (1 - fy),
    (1 - fx) * fy,
    fx * fy,
  ];
  const pixels = [p00, p10, p01, p11];
  let alpha = 0;
  for (let i = 0; i < 4; i += 1) alpha += pixels[i][3] * weights[i];
  alpha = Math.round(alpha);

  if (alpha === 0) return [0, 0, 0, 0];

  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = pixels[i][3];
    const w = weights[i] * a;
    r += pixels[i][0] * w;
    g += pixels[i][1] * w;
    b += pixels[i][2] * w;
  }

  return [
    Math.round(r / alpha),
    Math.round(g / alpha),
    Math.round(b / alpha),
    alpha,
  ];
}

export function renderCorrection(source, model, output) {
  if (!model) throw new Error('没有可用的标定模型');
  const { width, height } = outputSize(output);
  const destination = new Uint8ClampedArray(width * height * 4);
  const valid = new Uint8Array(width * height);
  const { crop, cellPx } = output;
  let outOfBoundsPixels = 0;
  let minSx = Infinity;
  let minSy = Infinity;
  let maxSx = -Infinity;
  let maxSy = -Infinity;

  for (let py = 0; py < height; py += 1) {
    const row = crop.row0 + (py + 0.5) / cellPx;
    for (let px = 0; px < width; px += 1) {
      const col = crop.col0 + (px + 0.5) / cellPx;
      const sourcePoint = idealToSource(model, col, row);
      const pixelIndex = py * width + px;
      const dataIndex = pixelIndex * 4;

      minSx = Math.min(minSx, sourcePoint.x);
      minSy = Math.min(minSy, sourcePoint.y);
      maxSx = Math.max(maxSx, sourcePoint.x);
      maxSy = Math.max(maxSy, sourcePoint.y);

      const sample = bilinearSample(source, sourcePoint.x, sourcePoint.y);
      if (!sample) {
        outOfBoundsPixels += 1;
        destination[dataIndex + 3] = 0;
        continue;
      }

      valid[pixelIndex] = 1;
      destination[dataIndex] = sample[0];
      destination[dataIndex + 1] = sample[1];
      destination[dataIndex + 2] = sample[2];
      destination[dataIndex + 3] = sample[3];
    }
  }

  return {
    width,
    height,
    data: destination,
    valid,
    stats: {
      totalPixels: width * height,
      validPixels: width * height - outOfBoundsPixels,
      outOfBoundsPixels,
      outOfBoundsFraction: outOfBoundsPixels / (width * height),
      sourceBounds: { minSx, minSy, maxSx, maxSy },
    },
  };
}

// Largest all-valid axis-aligned rectangle using the histogram-stack algorithm.
export function largestValidRectangle(valid, width, height) {
  if (!valid || width <= 0 || height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, area: 0 };
  }

  const histogram = new Array(width).fill(0);
  let best = { x: 0, y: 0, width: 0, height: 0, area: 0 };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      histogram[x] = valid[y * width + x] ? histogram[x] + 1 : 0;
    }

    const stack = [];
    for (let x = 0; x <= width; x += 1) {
      const currentHeight = x === width ? 0 : histogram[x];
      while (stack.length && histogram[stack[stack.length - 1]] > currentHeight) {
        const rectHeight = histogram[stack.pop()];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const rectWidth = x - left;
        const area = rectWidth * rectHeight;
        if (area > best.area) {
          best = {
            x: left,
            y: y - rectHeight + 1,
            width: rectWidth,
            height: rectHeight,
            area,
          };
        }
      }
      stack.push(x);
    }
  }

  return best;
}

export function hashFrame(frame) {
  let hash = 2166136261;
  for (let i = 0; i < frame.data.length; i += 1) {
    hash ^= frame.data[i];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
