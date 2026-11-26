// Fit orchestration: validate current markers, but never discard a good model
// for an incomplete or clustered edit.
import {
  assessFitPoints,
  desiredDegreeForCount,
  fitPolynomial,
  summarizeResiduals,
} from './math.js';
import { annotateRegions } from './state.js';

export function recomputeFit(doc) {
  const annotatedPoints = annotateRegions(
    doc.points,
    doc.grid.columns,
    doc.grid.rows,
  );
  const fitPoints = annotatedPoints.filter((point) => point.role === 'fit');
  const checkPoints = annotatedPoints.filter((point) => point.role === 'check');
  const imageWidth = doc.image?.width ?? 0;
  const imageHeight = doc.image?.height ?? 0;
  const assessment = assessFitPoints(fitPoints, imageWidth, imageHeight);

  if (!assessment.ok) {
    return {
      ok: false,
      assessment,
      doc: {
        ...doc,
        points: annotatedPoints,
        fitReport: {
          ok: false,
          message: assessment.message,
          coverage: assessment.coverage,
          fitCount: fitPoints.length,
          checkCount: checkPoints.length,
          // Explicitly retain doc.activeModel.
          retained: Boolean(doc.activeModel),
        },
      },
    };
  }

  try {
    const degree = desiredDegreeForCount(fitPoints.length);
    const model = fitPolynomial(fitPoints, { degree });
    const fitStats = summarizeResiduals(model, fitPoints);
    const checkStats = summarizeResiduals(model, checkPoints);

    const regionStats = {};
    for (const region of ['center', 'middle', 'edge']) {
      const items = checkStats.detailed.filter((item) => item.region === region);
      regionStats[region] = {
        count: items.length,
        rms: Math.sqrt(
          items.reduce((sum, item) => sum + item.distance * item.distance, 0) /
            Math.max(1, items.length),
        ),
        max: items.length ? Math.max(...items.map((item) => item.distance)) : 0,
      };
    }

    const fitReport = {
      ok: true,
      message: assessment.message,
      coverage: assessment.coverage,
      degree,
      fitCount: fitPoints.length,
      checkCount: checkPoints.length,
      fitRms: fitStats.rms,
      fitMax: fitStats.max,
      checkRms: checkStats.rms,
      checkMax: checkStats.max,
      checkDetails: checkStats.detailed,
      regionStats,
      retained: false,
    };

    return {
      ok: true,
      model,
      doc: { ...doc, points: annotatedPoints, activeModel: model, fitReport },
    };
  } catch (error) {
    return {
      ok: false,
      assessment: {
        ok: false,
        code: 'solve_failed',
        message: `拟合失败：${error.message}。请调整重合或排列异常的点；当前保留上一次可用结果。`,
      },
      doc: {
        ...doc,
        points: annotatedPoints,
        fitReport: {
          ok: false,
          message: `拟合失败：${error.message}`,
          fitCount: fitPoints.length,
          checkCount: checkPoints.length,
          retained: Boolean(doc.activeModel),
        },
      },
    };
  }
}

export function modelSignature(model) {
  if (!model) return 'none';
  return JSON.stringify({
    d: model.degree,
    n: model.norm,
    x: model.coeffX.map((v) => Number(v.toFixed(8))),
    y: model.coeffY.map((v) => Number(v.toFixed(8))),
  });
}
