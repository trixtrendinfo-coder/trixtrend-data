// Account-wide closed-trade returns. This is not mark-to-market equity or exact TWR.
export function money(value, digits = 2) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || !Number.isInteger(digits) || digits < 0 || digits > 8) {
    throw new Error('Invalid monetary value or precision');
  }
  return n / 10 ** digits;
}

export function closedReturn(deal, defaultDigits = 2) {
  const d = deal.closePositionDetail;
  if (!d) return null;
  const digits = d.moneyDigits ?? defaultDigits;
  const commission = money(d.commission, digits);
  // A non-zero conversion fee needs statement reconciliation before support is enabled.
  if (Number(d.pnlConversionFee ?? 0) !== 0 || commission > 0) {
    throw new Error('Unverified commission/conversion-fee convention; publication stopped');
  }
  const net = money(d.grossProfit, digits) + money(d.swap, digits) + commission;
  const balanceAfter = money(d.balance, digits);
  const balanceBefore = balanceAfter - net;
  const timestamp = Number(deal.executionTimestamp);
  if (!(balanceBefore > 0) || !(balanceAfter > 0) || !Number.isSafeInteger(timestamp)) {
    throw new Error('Non-positive account balance or invalid closing timestamp');
  }
  return { timestamp, factor: 1 + net / balanceBefore };
}

export function historyTime(value, offsetMinutes = 0) {
  return Date.parse(value.endsWith('Z') ? value : value + 'Z') - offsetMinutes * 60000;
}

function statementDayStart(date, offset) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Invalid report date');
  }
  const wallTime = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(wallTime.getTime()) || wallTime.toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid report date');
  }
  return wallTime.getTime() - offset * 60000;
}

function summarizeClosings(reportWeek, events, offset, historyStart, asOf) {
  const { from, through } = reportWeek ?? {};
  const first = statementDayStart(from, offset);
  const last = statementDayStart(through, offset);
  const end = last + 86400000;
  if (last < first || first < historyStart || end > asOf) {
    throw new Error('Report period is outside the verified history');
  }
  let factor = 1;
  let closedTrades = 0;
  for (const event of events) {
    if (event.isClosing && event.timestamp >= first && event.timestamp < end) {
      factor *= event.factor;
      closedTrades++;
    }
  }
  const performancePercent = (factor - 1) * 100;
  if (!Number.isFinite(performancePercent) || !(factor > 0)) {
    throw new Error('Invalid report return');
  }
  return { from, through, performancePercent, closedTrades };
}

export function buildHistory({ baseline, deals, cashFlows, moneyDigits = 2, asOf, reportWeek }) {
  const offset = baseline.sourceUtcOffsetMinutes ?? 0;
  if (!Number.isInteger(offset) || Math.abs(offset) > 840) throw new Error('Invalid statement time offset');
  const time = value => historyTime(value, offset);
  const start = time(baseline.points[0].date);
  const cutoff = time(baseline.through + 'T23:59:59.999');
  if (!Number.isSafeInteger(asOf) || asOf < cutoff) throw new Error('Snapshot precedes the verified baseline');
  const seen = new Map();
  for (const d of deals) {
    if (d.dealId == null) throw new Error('Missing deal identifier');
    const id = String(d.dealId);
    if (seen.has(id) && JSON.stringify(seen.get(id)) !== JSON.stringify(d)) {
      throw new Error('Conflicting duplicate deal');
    }
    seen.set(id, d);
  }
  const events = [];
  for (const d of seen.values()) {
    if (!d.closePositionDetail) continue;
    if (![2, 3, 'FILLED', 'PARTIALLY_FILLED'].includes(d.dealStatus)) {
      throw new Error('Unexpected closing deal status');
    }
    const r = closedReturn(d, moneyDigits);
    if (r.timestamp >= start && r.timestamp <= asOf) {
      events.push({ ...r, version: d.closePositionDetail.balanceVersion, id: String(d.dealId), isClosing: true });
    }
  }
  const cashSeen = new Set();
  for (const c of cashFlows) {
    if (c.balanceHistoryId == null) throw new Error('Missing cash-flow identifier');
    const id = String(c.balanceHistoryId);
    if (cashSeen.has(id)) continue;
    cashSeen.add(id);
    const timestamp = Number(c.changeBalanceTimestamp);
    if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid cash-flow timestamp');
    if (timestamp >= start && timestamp <= asOf) {
      events.push({ timestamp, factor: 1, version: c.balanceVersion, id: 'cash-' + id });
    }
  }
  events.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.version != null && b.version != null) {
      return Number(BigInt(a.version) - BigInt(b.version));
    }
    if (a.factor !== 1 && b.factor !== 1) {
      throw new Error('Simultaneous closings without balance versions');
    }
    return a.id.localeCompare(b.id);
  });
  let index = 100;
  const points = [{ date: baseline.points[0].date, index }];
  for (const e of events) {
    index *= e.factor;
    if (!Number.isFinite(index) || !(index > 0)) throw new Error('Invalid return index');
    points.push({ date: new Date(e.timestamp + offset * 60000).toISOString().replace(/Z$/, ''), index: +index.toFixed(8) });
  }
  // Verify every historical closing against the owner's previously reconciled statement.
  // New API data must never silently rewrite the existing published track record.
  const reference = new Map(baseline.points.map(p => [time(p.date), p.index]));
  for (const e of events.filter(e => e.factor !== 1 && e.timestamp <= cutoff)) {
    if (!reference.has(e.timestamp)) throw new Error('API/statement closing timestamp mismatch');
  }
  const oldIndex = baseline.points.at(-1).index;
  const matched = points.filter(p => time(p.date) <= cutoff).at(-1)?.index;
  if (Math.abs(matched - oldIndex) > 0.00002) {
    throw new Error('API returns do not match the reconciled historical statement');
  }
  for (const p of points.filter(p => time(p.date) <= cutoff)) {
    const prior = reference.get(time(p.date));
    if (prior != null && Math.abs(prior - p.index) > 0.00002) {
      throw new Error('Historical return point differs from the statement');
    }
  }
  // Preserve existing history exactly; append only verified later observations.
  return {
    schemaVersion: 1,
    through: new Date(asOf + offset * 60000).toISOString().slice(0, 10),
    updatedAt: new Date(asOf).toISOString(),
    mode: 'automatic',
    returnType: 'cash-flow-adjusted-closed-trade-return',
    maxDrawdown: { value: -12.07, source: 'owner-specified', automatic: false },
    points: [...baseline.points, ...points.filter(p => time(p.date) > cutoff)],
    ...(reportWeek !== undefined && { weeklyReport: summarizeClosings(reportWeek, events, offset, start, asOf) })
  };
}

