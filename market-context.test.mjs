import test from 'node:test';
import assert from 'node:assert/strict';
import { getMarketContext } from './market-context.mjs';

const week = { from: '2026-11-16', through: '2026-11-21' };

function marketFeeds(values) {
  return async url => {
    const symbol = /\/(\w+)_History\.csv$/.exec(url)[1];
    const friday = values[symbol];
    if (friday === undefined) throw new Error('Feed unavailable');
    const csv = [
      `DATE,${symbol}`, '11/13/2026,20', '11/19/2026,35',
      ...(friday === null ? [] : [`11/20/2026,${friday}`]), '11/23/2026,40'
    ];
    return { ok: true, async text() { return csv.join('\n'); } };
  };
}

test('uses complete weekly closes from multiple indicators and no instrument names', async () => {
  for (const [values, expected] of [
    [{ VIX: 22, OVX: 26, GVZ: 30 }, /rose/],
    [{ VIX: 18, OVX: 15, GVZ: null }, /eased/],
    [{ VIX: 19.5, OVX: 20, GVZ: 20.2 }, /broadly steady/],
    [{ VIX: 22, OVX: 18, GVZ: 16 }, /varied/]
  ]) {
    const context = await getMarketContext(week, marketFeeds(values));
    assert.match(context, expected);
    assert.doesNotMatch(context, /VIX|OVX|GVZ|gold|oil|Nasdaq/i);
  }
});

test('missing, stale or out-of-period market data cannot make a market claim', async () => {
  assert.equal(await getMarketContext(week, marketFeeds({ VIX: 21.1, OVX: null })), null);
  assert.equal(await getMarketContext(week, marketFeeds({ VIX: null, OVX: null, GVZ: null })), null);
  assert.equal(await getMarketContext({ ...week, through: '2026-11-19' }, marketFeeds({})), null);
});

test('accepts the OHLC schema and the prior week’s last close when Friday was missing', async () => {
  const marketContext = await getMarketContext(week, async () => ({
    ok: true,
    async text() {
      return 'DATE,OPEN,HIGH,LOW,CLOSE\n11/12/2026,18,21,16,20\n11/20/2026,21,25,15,24\n';
    }
  }));
  assert.match(marketContext, /rose/);
});
