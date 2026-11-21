import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChartData } from './chart-data.mjs';

const baseline = { through: '2026-11-20', points: [
  { date: '2026-11-19T12:00:00', index: 100 },
  { date: '2026-11-20T12:00:00', index: 105 }
] };
const fixture = () => ({ schemaVersion: 1, mode: 'automatic',
  returnType: 'cash-flow-adjusted-closed-trade-return', through: '2026-11-21',
  updatedAt: '2026-11-21T11:00:00Z', points: [...baseline.points,
    { date: '2026-11-21T10:00:00', index: 106 }] });

test('accepts a valid extension and drops fields that do not belong in public chart data', () => {
  const data = fixture(); data.accessToken = 'must-not-copy'; data.points.at(-1).balance = 123;
  const result = validateChartData(data, baseline);
  assert.equal(result.points.at(-1).index, 106);
  assert.ok(!JSON.stringify(result).includes('accessToken'));
  assert.ok(!JSON.stringify(result).includes('balance'));
});
test('rejects a rewritten historical point', () => {
  const data = fixture(); data.points = structuredClone(data.points); data.points[1].index = 150;
  assert.throws(() => validateChartData(data, baseline), /historical/);
});
test('rejects older, truncated and unordered histories', () => {
  const data = fixture(); data.through = '2026-11-01';
  assert.throws(() => validateChartData(data, baseline));
  data.through = '2026-11-21'; data.points = [];
  assert.throws(() => validateChartData(data, baseline));
  data.points = [...baseline.points].reverse();
  assert.throws(() => validateChartData(data, baseline));
});
test('rejects invalid numbers, incompatible return definitions and unknown modes', () => {
  const data = fixture(); data.points.at(-1).index = NaN;
  assert.throws(() => validateChartData(data, baseline));
  data.points.at(-1).index = 106; data.returnType = 'equity';
  assert.throws(() => validateChartData(data, baseline));
  data.returnType = 'cash-flow-adjusted-closed-trade-return'; data.mode = 'unknown';
  assert.throws(() => validateChartData(data, baseline));
});
test('does not allow a newer history to be replaced by an older cached response', () => {
  const current = fixture(); const old = fixture(); old.points.pop();
  assert.throws(() => validateChartData(old, baseline, current), /backwards/);
});
