// Shared by the browser and offline validation. No credentials or account amounts.
export function validateChartData(candidate, baseline, previous = baseline) {
  if (!candidate || candidate.schemaVersion !== 1 || !['manual', 'automatic'].includes(candidate.mode)) {
    throw new Error('Unsupported chart data');
  }
  const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!dayPattern.test(candidate.through) ||
      new Date(candidate.through + 'T00:00:00Z').toISOString().slice(0, 10) !== candidate.through) {
    throw new Error('Invalid coverage date');
  }
  if (candidate.through < previous.through) throw new Error('Older chart data');
  if (candidate.returnType !== 'cash-flow-adjusted-closed-trade-return') {
    throw new Error('Unexpected return methodology');
  }
  const input = candidate.points;
  if (!Array.isArray(input) || input.length < baseline.points.length || input.length > 100000) {
    throw new Error('Incomplete or oversized chart history');
  }
  let last = -Infinity;
  const limit = Date.parse(candidate.through + 'T23:59:59.999Z');
  const points = input.map(p => {
    if (!p || typeof p.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(p.date)) {
      throw new Error('Invalid observation date');
    }
    const timestamp = Date.parse(p.date + 'Z');
    if (!Number.isFinite(timestamp) || timestamp < last || timestamp > limit ||
        typeof p.index !== 'number' || !Number.isFinite(p.index) || p.index <= 0) {
      throw new Error('Invalid or unordered observation');
    }
    last = timestamp;
    // Whitelist public fields; never copy arbitrary API payloads into the viewer.
    return { date: p.date, index: p.index };
  });
  for (let i = 0; i < baseline.points.length; i++) {
    if (points[i].date !== baseline.points[i].date ||
        Math.abs(points[i].index - baseline.points[i].index) > 0.0000001) {
      throw new Error('Published historical data was changed');
    }
  }
  if (points.length < previous.points.length ||
      points.at(-1).date < previous.points.at(-1).date) {
    throw new Error('Chart data moved backwards');
  }
  if (candidate.mode === 'automatic' && !Number.isFinite(Date.parse(candidate.updatedAt))) {
    throw new Error('Automatic data requires an actual update timestamp');
  }
  const result = {
    schemaVersion: 1,
    through: candidate.through,
    mode: candidate.mode,
    returnType: candidate.returnType,
    points
  };
  if (candidate.mode === 'automatic') result.updatedAt = new Date(candidate.updatedAt).toISOString();
  return result;
}
