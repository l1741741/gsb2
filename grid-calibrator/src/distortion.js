// Deterministic digital lens/perspective warp used by the built-in sample.
// The same function drives both the generated bent grid and check chart.

export const SYNTH_LAYOUT = {
  width: 960,
  height: 720,
  columns: 11,
  rows: 8,
  marginX: 96,
  marginY: 84,
};

export const DEFAULT_WARP = {
  ...SYNTH_LAYOUT,
  k1: -0.1,
  k2: 0.035,
  perspX: 0.045,
  perspY: -0.035,
  curlX: 0.035,
  curlY: -0.025,
};

// Wider than the exact grid rectangle so the one-click demo shows transparent
// out-of-bounds borders and a nontrivial valid-rectangle crop immediately.
export const SAMPLE_OUTPUT = {
  cellPx: 80,
  crop: {
    col0: -1.5,
    row0: -1.5,
    col1: SYNTH_LAYOUT.columns - 1 + 1.5,
    row1: SYNTH_LAYOUT.rows - 1 + 1.5,
  },
};

export function idealGridPoint(layout, col, row) {
  const { width, height, columns, rows, marginX, marginY } = layout;
  const x = columns === 1
    ? width / 2
    : marginX + (col * (width - marginX * 2)) / (columns - 1);
  const y = rows === 1
    ? height / 2
    : marginY + (row * (height - marginY * 2)) / (rows - 1);
  return { x, y };
}

export function warpChartPoint(x, y, warp = DEFAULT_WARP) {
  const { width, height } = warp;
  const radius = Math.min(width, height) / 2;
  const nx = (x - width / 2) / radius;
  const ny = (y - height / 2) / radius;
  const r2 = nx * nx + ny * ny;
  const radial = 1 + warp.k1 * r2 + warp.k2 * r2 * r2;

  // Radial bend plus mild perspective/corner curl, all low-order enough for
  // the polynomial calibrator while remaining visibly curved.
  const wx = nx * radial
    + (warp.perspX ?? 0) * ny
    + (warp.curlX ?? 0) * nx * ny * ny;
  const wy = ny * radial
    + (warp.perspY ?? 0) * nx
    + (warp.curlY ?? 0) * ny * nx * nx;

  return {
    x: width / 2 + wx * radius,
    y: height / 2 + wy * radius,
  };
}

export function warpedGridPoint(warp, col, row) {
  const ideal = idealGridPoint(warp, col, row);
  return warpChartPoint(ideal.x, ideal.y, warp);
}

export function createSyntheticPoints(warp = DEFAULT_WARP, roleFor = null) {
  const points = [];
  for (let row = 0; row < warp.rows; row += 1) {
    for (let col = 0; col < warp.columns; col += 1) {
      const source = warpedGridPoint(warp, col, row);
      points.push({
        id: `syn_${row}_${col}`,
        col,
        row,
        x: source.x,
        y: source.y,
        role: roleFor ? roleFor(col, row) : 'fit',
      });
    }
  }
  return points;
}

export function measureWarp(warp = DEFAULT_WARP) {
  const c = (warp.columns - 1) / 2;
  const r = (warp.rows - 1) / 2;
  const landmarks = [
    { name: 'center', region: 'center', col: c, row: r },
    { name: 'top-edge', region: 'edge', col: c, row: 0 },
    { name: 'bottom-edge', region: 'edge', col: c, row: warp.rows - 1 },
    { name: 'left-edge', region: 'edge', col: 0, row: r },
    { name: 'right-edge', region: 'edge', col: warp.columns - 1, row: r },
    { name: 'top-left-corner', region: 'corner', col: 0, row: 0 },
    { name: 'top-right-corner', region: 'corner', col: warp.columns - 1, row: 0 },
    { name: 'bottom-left-corner', region: 'corner', col: 0, row: warp.rows - 1 },
    { name: 'bottom-right-corner', region: 'corner', col: warp.columns - 1, row: warp.rows - 1 },
  ];

  const measurements = landmarks.map((landmark) => {
    const ideal = idealGridPoint(warp, landmark.col, landmark.row);
    const warped = warpChartPoint(ideal.x, ideal.y, warp);
    const dx = warped.x - ideal.x;
    const dy = warped.y - ideal.y;
    return {
      ...landmark,
      ideal,
      warped,
      dx,
      dy,
      displacement: Math.hypot(dx, dy),
    };
  });

  const center = measurements.find((item) => item.region === 'center');
  const edges = measurements.filter((item) => item.region === 'edge');
  const corners = measurements.filter((item) => item.region === 'corner');
  const average = (items) => items.reduce((sum, item) => sum + item.displacement, 0) /
    Math.max(1, items.length);

  return {
    measurements,
    centerDisplacement: center.displacement,
    edgeMeanDisplacement: average(edges),
    edgeMaxDisplacement: Math.max(...edges.map((item) => item.displacement)),
    cornerMeanDisplacement: average(corners),
    cornerMaxDisplacement: Math.max(...corners.map((item) => item.displacement)),
  };
}
