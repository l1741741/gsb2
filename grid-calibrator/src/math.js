// Pure calibration math: normalized polynomial fitting and residual metrics.

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function rms(values) {
  if (!values.length) return 0;
  return Math.sqrt(mean(values.map((value) => value * value)));
}

export function uniqueNumbers(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

// Terms of a total-degree polynomial in normalized grid coordinates.
export function polynomialTerms(u, v, degree = 3) {
  if (degree === 2) {
    return [1, u, v, u * u, u * v, v * v];
  }
  return [
    1,
    u,
    v,
    u * u,
    u * v,
    v * v,
    u * u * u,
    u * u * v,
    u * v * v,
    v * v * v,
  ];
}

export function polynomialCoefficientCount(degree) {
  return polynomialTerms(0, 0, degree).length;
}

// Gaussian elimination with partial pivoting. Throws on a singular matrix.
export function solveLinearSystem(sourceMatrix, sourceVector) {
  const n = sourceVector.length;
  const matrix = sourceMatrix.map((row, i) => [...row, sourceVector[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) {
        pivot = row;
      }
    }

    if (Math.abs(matrix[pivot][col]) < 1e-12) {
      throw new Error('标定矩阵奇异：交点行列排列不足以稳定拟合');
    }

    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];

    for (let row = col + 1; row < n; row += 1) {
      const factor = matrix[row][col] / matrix[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) {
        matrix[row][k] -= factor * matrix[col][k];
      }
    }
  }

  const answer = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = matrix[row][n];
    for (let col = row + 1; col < n; col += 1) {
      sum -= matrix[row][col] * answer[col];
    }
    answer[row] = sum / matrix[row][row];
  }
  return answer;
}

function normalEquations(points, degree, norm, coordinateKey) {
  const termCount = polynomialCoefficientCount(degree);
  const matrix = Array.from({ length: termCount }, () => new Array(termCount).fill(0));
  const vector = new Array(termCount).fill(0);

  for (const point of points) {
    const u = (point.col - norm.centerCol) / norm.scale;
    const v = (point.row - norm.centerRow) / norm.scale;
    const terms = polynomialTerms(u, v, degree);
    const value = point[coordinateKey];

    for (let i = 0; i < termCount; i += 1) {
      vector[i] += terms[i] * value;
      for (let j = 0; j < termCount; j += 1) {
        matrix[i][j] += terms[i] * terms[j];
      }
    }
  }

  // Small relative ridge keeps near-degenerate manual markings numerically finite.
  for (let i = 0; i < termCount; i += 1) {
    matrix[i][i] += 1e-8 * Math.max(1, Math.abs(matrix[i][i]));
  }

  return { matrix, vector };
}

export function fitPolynomial(points, options = {}) {
  if (!points.length) throw new Error('没有可用于拟合的标记点');

  const cols = points.map((point) => point.col);
  const rows = points.map((point) => point.row);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  const minRow = Math.min(...rows);
  const maxRow = Math.max(...rows);

  const norm = options.norm ?? {
    centerCol: (minCol + maxCol) / 2,
    centerRow: (minRow + maxRow) / 2,
    scale: Math.max((maxCol - minCol) / 2, (maxRow - minRow) / 2, 1),
  };
  const degree = options.degree ?? (points.length >= 12 ? 3 : 2);

  const xSystem = normalEquations(points, degree, norm, 'x');
  const ySystem = normalEquations(points, degree, norm, 'y');
  const coeffX = solveLinearSystem(xSystem.matrix, xSystem.vector);
  const coeffY = solveLinearSystem(ySystem.matrix, ySystem.vector);

  return {
    type: 'polynomial',
    version: 1,
    degree,
    norm,
    coeffX,
    coeffY,
  };
}

export function idealToSource(model, col, row) {
  const u = (col - model.norm.centerCol) / model.norm.scale;
  const v = (row - model.norm.centerRow) / model.norm.scale;
  const terms = polynomialTerms(u, v, model.degree);
  let x = 0;
  let y = 0;
  for (let i = 0; i < terms.length; i += 1) {
    x += model.coeffX[i] * terms[i];
    y += model.coeffY[i] * terms[i];
  }
  return { x, y };
}

export function residualForPoint(model, point) {
  const predicted = idealToSource(model, point.col, point.row);
  const dx = point.x - predicted.x;
  const dy = point.y - predicted.y;
  return {
    pointId: point.id,
    row: point.row,
    col: point.col,
    observed: { x: point.x, y: point.y },
    predicted,
    dx,
    dy,
    distance: Math.hypot(dx, dy),
    role: point.role,
    region: point.region,
  };
}

export function summarizeResiduals(model, points) {
  const detailed = points.map((point) => residualForPoint(model, point));
  const distances = detailed.map((item) => item.distance);
  return {
    detailed,
    count: points.length,
    rms: rms(distances),
    mean: mean(distances),
    max: distances.length ? Math.max(...distances) : 0,
  };
}

export function desiredDegreeForCount(count) {
  return count >= 12 ? 3 : 2;
}

// Checks count, row/column spread and image-space coverage before replacing
// the last known usable model.
export function assessFitPoints(fitPoints, imageWidth, imageHeight) {
  const count = fitPoints.length;
  const minimum = 8;
  if (count < minimum) {
    return {
      ok: false,
      code: 'too_few',
      message: `拟合点太少：当前 ${count} 个，至少需要 ${minimum} 个；请补点后再拟合。`,
      coverage: null,
    };
  }

  const cols = uniqueNumbers(fitPoints.map((point) => point.col));
  const rows = uniqueNumbers(fitPoints.map((point) => point.row));
  if (cols.length < 3 || rows.length < 3) {
    return {
      ok: false,
      code: 'labels_too_narrow',
      message: '行列覆盖不足：至少需要 3 个不同行和 3 个不同列，请补齐行列标号。',
      coverage: { colCount: cols.length, rowCount: rows.length },
    };
  }

  if (Math.max(...cols) - Math.min(...cols) < 2 || Math.max(...rows) - Math.min(...rows) < 2) {
    return {
      ok: false,
      code: 'labels_too_narrow',
      message: '行列跨度不足：拟合点至少要跨越 2 行和 2 列的范围。',
      coverage: { colCount: cols.length, rowCount: rows.length },
    };
  }

  const minX = Math.min(...fitPoints.map((point) => point.x));
  const maxX = Math.max(...fitPoints.map((point) => point.x));
  const minY = Math.min(...fitPoints.map((point) => point.y));
  const maxY = Math.max(...fitPoints.map((point) => point.y));
  const widthFraction = imageWidth > 0 ? (maxX - minX) / imageWidth : 1;
  const heightFraction = imageHeight > 0 ? (maxY - minY) / imageHeight : 1;

  if (widthFraction < 0.35 || heightFraction < 0.35) {
    return {
      ok: false,
      code: 'clustered',
      message: '标记集中在画面一角或一小块区域：请在四角、边缘中部和中心附近补点。',
      coverage: { widthFraction, heightFraction },
    };
  }

  // 3x3 image bins catch a marking set that has broad bounds but still occupies
  // only one corner/edge.
  const bins = new Set();
  for (const point of fitPoints) {
    const bx = clamp(Math.floor((point.x / imageWidth) * 3), 0, 2);
    const by = clamp(Math.floor((point.y / imageHeight) * 3), 0, 2);
    bins.add(`${bx},${by}`);
  }
  if (bins.size < 4) {
    return {
      ok: false,
      code: 'clustered',
      message: '标记空间分布太集中：请让点位覆盖至少四个区域，尤其是对角和边缘。',
      coverage: { widthFraction, heightFraction, binCount: bins.size },
    };
  }

  return {
    ok: true,
    code: 'ok',
    message: count < 12
      ? `当前 ${count} 个拟合点可用于二次拟合；补足 12 个以上可启用三次弯曲模型。`
      : `当前 ${count} 个拟合点，可进行三次多项式拟合。`,
    coverage: { widthFraction, heightFraction, binCount: bins.size },
  };
}
