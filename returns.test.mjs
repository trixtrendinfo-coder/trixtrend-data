import test from 'node:test';
import assert from 'node:assert/strict';
import { closedReturn, money, buildHistory } from './returns.mjs';
import { CTrader, fetchDeals } from './ctrader.mjs';

const deal = (id, timestamp, profit, balance, commission = 0, digits = 2) => ({
  dealId: id, executionTimestamp: timestamp, dealStatus: 2,
  closePositionDetail: { grossProfit: profit, swap: 0, commission, balance, moneyDigits: digits }
});

test('commissions and swaps reduce net return; precision is respected', () => {
  const d = deal('1', 1, 12000, 110000, -2000);
  assert.equal(closedReturn(d).factor, 1.1);
  d.closePositionDetail.swap = -1000;
  d.closePositionDetail.balance = 109000;
  assert.equal(closedReturn(d).factor, 1.09);
  assert.equal(money('10053099944', 8), 100.53099944);
  assert.throws(() => money('9007199254740993'));
});

test('deposits are excluded, duplicate deals are counted once, old history is retained', () => {
  const start = '2026-01-01T00:00:00';
  const ts = Date.parse('2026-01-02T12:00:00Z');
  const first = deal('1', ts, 10000, 110000);
  const second = deal('2', ts + 86400000, 21000, 231000);
  const baseline = { through: '2026-01-02', points: [{ date: start, index: 100 }, { date: '2026-01-02T12:00:00', index: 110 }] };
  const output = buildHistory({ baseline, deals: [second, first, first], cashFlows: [
    { balanceHistoryId: 9, changeBalanceTimestamp: ts + 1, delta: 100000 }
  ], asOf: ts + 2 * 86400000 });
  assert.equal(output.points.at(-1).index, 121);
  assert.deepEqual(output.points.slice(0, 2), baseline.points);
  assert.ok(!JSON.stringify(output).includes('balance'));
  assert.ok(!JSON.stringify(output).includes('dealId'));
});

test('weekly report counts closing executions within the statement dates and compounds net return', () => {
  const baseline = { through: '2026-11-15', sourceUtcOffsetMinutes: 120,
    points: [{ date: '2026-11-14T00:00:00', index: 100 }, { date: '2026-11-15T23:59:59.999', index: 105 }] };
  const reportWeek = { from: '2026-11-16', through: '2026-11-21' };
  const monday = Date.parse('2026-11-15T22:00:00Z');
  const sunday = Date.parse('2026-11-21T22:00:00Z');
  const prior = deal('1', monday - 1, 5000, 105000);
  const partial = { ...deal('2', monday, 11000, 115000, -1000), positionId: 7, dealStatus: 3 };
  const flat = { ...deal('3', monday + 1, 0, 115000), positionId: 7 };
  const saturday = deal('4', Date.parse('2026-11-20T22:00:00Z'), -23000, 207000);
  const after = deal('5', sunday, 20700, 227700);
  const opening = { dealId: '6', executionTimestamp: monday + 3, dealStatus: 2 };
  const output = buildHistory({ baseline, deals: [after, saturday, partial, prior, flat, partial, opening],
    cashFlows: [{ changeBalanceTimestamp: monday + 2, balanceHistoryId: 1 }], asOf: sunday, reportWeek });
  assert.equal(output.weeklyReport.from, reportWeek.from);
  assert.equal(output.weeklyReport.through, reportWeek.through);
  assert.equal(output.weeklyReport.closedTrades, 3);
  assert.ok(Math.abs(output.weeklyReport.performancePercent - ((115 / 105) * 0.9 - 1) * 100) < 1e-10);
});

test('weekly report accepts a fully observed idle week and rejects incomplete or invalid coverage', () => {
  const reportWeek = { from: '2026-11-16', through: '2026-11-21' };
  const options = { baseline: { through: '2026-11-15', sourceUtcOffsetMinutes: 120,
    points: [{ date: '2026-11-14T00:00:00', index: 100 }] }, deals: [], cashFlows: [],
  asOf: Date.parse('2026-11-21T22:00:00Z'), reportWeek };
  assert.deepEqual(buildHistory(options).weeklyReport, { ...reportWeek, performancePercent: 0, closedTrades: 0 });
  assert.throws(() => buildHistory({ ...options, asOf: options.asOf - 1 }), /outside the verified history/);
  assert.throws(() => buildHistory({ ...options, reportWeek: { ...reportWeek, from: '2026-11-13' } }), /outside the verified history/);
  assert.throws(() => buildHistory({ ...options, reportWeek: { ...reportWeek, through: '2026-11-15' } }), /outside the verified history/);
  assert.throws(() => buildHistory({ ...options, reportWeek: { ...reportWeek, from: '2026-02-30' } }), /Invalid report date/);
});

test('mismatched historical returns stop publication', () => {
  const baseline = { through: '2026-01-02', points: [{ date: '2026-01-01T00:00:00', index: 100 }, { date: '2026-01-02T12:00:00', index: 115 }] };
  assert.throws(() => buildHistory({ baseline, deals: [], cashFlows: [], asOf: Date.parse('2026-01-03T00:00:00Z') }), /do not match/);
});

test('unverified fee convention and non-positive balance are rejected', () => {
  assert.throws(() => closedReturn(deal('1', 1, 100, 1100, 10)), /Unverified/);
  assert.throws(() => closedReturn(deal('1', 1, 100, 0)), /Non-positive/);
});

test('trading requests are blocked before network access', async () => {
  await assert.rejects(new CTrader().request(2106, {}), /blocked/);
});

test('pagination splits without dropping a boundary timestamp', async () => {
  const calls = [];
  const api = { request: async (_, p) => {
    calls.push([p.fromTimestamp, p.toTimestamp]);
    if (p.toTimestamp - p.fromTimestamp > 1) return { hasMore: true };
    return { hasMore: false, deal: [p.fromTimestamp] };
  }};
  assert.deepEqual(await fetchDeals(api, 1, 0, 3), [0, 2]);
  assert.deepEqual(calls, [[0, 3], [0, 1], [2, 3]]);
});
