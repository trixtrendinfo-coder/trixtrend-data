const cboeHistory = 'https://cdn-api.cboe.com/api/global/us_indices/daily_prices/';
const indicators = ['VIX', 'OVX', 'GVZ'];
const day = 86_400_000;

function closeDirection(csv, indicator, monday) {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  const columns = header.replace(/^\uFEFF/, '').split(',').map(value => value.trim().toUpperCase());
  const dateColumn = columns.indexOf('DATE');
  const closeColumn = columns.includes('CLOSE') ? columns.indexOf('CLOSE') : columns.indexOf(indicator);
  if (dateColumn < 0 || closeColumn < 0) return null;

  const closes = new Map();
  for (const row of rows) {
    const fields = row.split(',');
    const date = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(fields[dateColumn] ?? '');
    if (!date) continue;
    const [, month, dateOfMonth, year] = date;
    const iso = `${year}-${month.padStart(2, '0')}-${dateOfMonth.padStart(2, '0')}`;
    const time = Date.parse(`${iso}T00:00:00Z`);
    if (!Number.isFinite(time) || time < monday - 7 * day || time > monday + 4 * day ||
        new Date(time).toISOString().slice(0, 10) !== iso) continue;
    const close = Number(fields[closeColumn]);
    if (!Number.isFinite(close) || close <= 0) continue;
    if (closes.has(time) && closes.get(time) !== close) return null;
    closes.set(time, close);
  }

  // Require the current Friday's close. Missing Friday data could be a holiday or a stale feed.
  const latest = closes.get(monday + 4 * day);
  const priorDate = Math.max(...[...closes.keys()].filter(time => time <= monday - 3 * day));
  const previous = closes.get(priorDate);
  if (!latest || !previous) return null;
  const change = latest / previous - 1;
  if (change >= 0.05) return 'up';
  if (change <= -0.05) return 'down';
  return 'steady';
}

export async function getMarketContext(week, fetcher = fetch) {
  const monday = Date.parse(`${week.from}T00:00:00Z`);
  const end = Date.parse(`${week.through}T00:00:00Z`);
  if (new Date(monday).getUTCDay() !== 1 || end < monday + 4 * day || end > monday + 5 * day ||
      !Number.isFinite(end)) return null;

  const directions = (await Promise.all(indicators.map(async indicator => {
    try {
      const response = await fetcher(`${cboeHistory}${indicator}_History.csv`, {
        redirect: 'error', signal: AbortSignal.timeout(8000)
      });
      return response.ok ? closeDirection(await response.text(), indicator, monday) : null;
    } catch {
      return null;
    }
  }))).filter(Boolean);

  if (directions.length < 2) return null;
  if (directions.every(value => value === 'up')) return 'Expectations for market volatility rose across the indicators tracked.';
  if (directions.every(value => value === 'down')) return 'Expectations for market volatility eased across the indicators tracked.';
  if (directions.every(value => value === 'steady')) return 'Expectations for market volatility stayed broadly steady across the indicators tracked.';
  return 'Market volatility expectations varied across the indicators tracked.';
}
