import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptState, decryptState } from './vault.mjs';
import { collect, refreshTokens } from './collector.mjs';

const key = 'ab'.repeat(32);
const now = Date.parse('2026-11-21T12:00:00Z');
const tokens = { accessToken: 'test-access-token', refreshToken: 'test-refresh-token',
  expiresAt: now + 30 * 86400000 };
const baseline = { schemaVersion: 1, mode: 'manual',
  returnType: 'cash-flow-adjusted-closed-trade-return', through: '2026-11-20',
  sourceUtcOffsetMinutes: 120, points: [
    { date: '2026-11-19T12:00:00', index: 100 },
    { date: '2026-11-20T12:00:00', index: 110 }
  ] };
const deals = [{ dealId: 1, dealStatus: 2, executionTimestamp: Date.parse('2026-11-20T10:00:00Z'),
  closePositionDetail: { grossProfit: 10000, swap: 0, commission: 0, balance: 110000, moneyDigits: 2 } },
{ dealId: 2, dealStatus: 2, executionTimestamp: Date.parse('2026-11-21T10:00:00Z'),
  closePositionDetail: { grossProfit: 11000, swap: 0, commission: 0, balance: 121000, moneyDigits: 2 } }];

export function fixture({ scope = 0, initialState = false, failHistory = false } = {}) {
  const writes = [], requests = [];
  const files = new Map([['quant-gold.json', baseline]]);
  if (initialState) files.set('session.enc.json', encryptState(tokens, key));
  const store = {
    async read(path) { return files.has(path) ? { value: files.get(path) } : null; },
    async write(path, value) { writes.push({ path, value }); files.set(path, value); }
  };
  const api = {
    async connect() {}, close() { this.closed = true; },
    async request(type, payload) {
      requests.push(type);
      if ([2100, 2102].includes(type)) return {};
      if (type === 2149) return { permissionScope: scope, ctidTraderAccount: [
        { traderLogin: 123456, ctidTraderAccountId: 99, isLive: true }] };
      if (type === 2121) return { trader: { balance: 121000, balanceVersion: 3, moneyDigits: 2 } };
      if (type === 2133) {
        if (failHistory) throw new Error('History not available');
        return { deal: deals.filter(d => d.executionTimestamp >= payload.fromTimestamp &&
          d.executionTimestamp <= payload.toTimestamp), hasMore: false };
      }
      if (type === 2143) return {};
      throw new Error('Unexpected request');
    }
  };
  return { store, api, files, writes, requests, options: { baseline, store, stateKey: key,
    clientId: 'test-client', clientSecret: 'test-client-secret', accountLogin: '123456',
    bootstrapTokens: tokens, publish: true, apiFactory: () => api, now: () => now } };
}

test('encrypted state is authenticated, uses a random IV and never exposes tokens', () => {
  const a = encryptState(tokens, key), b = encryptState(tokens, key);
  assert.notEqual(a.iv, b.iv);
  assert.ok(!JSON.stringify(a).includes(tokens.accessToken));
  assert.deepEqual(decryptState(a, key), tokens);
  assert.throws(() => decryptState(a, 'cd'.repeat(32)));
  assert.throws(() => decryptState({ ...a, tag: b.tag }, key));
});
test('complete collection preserves baseline, handles UTC+2 and publishes sanitized data', async () => {
  const f = fixture();
  const result = await collect(f.options);
  assert.equal(result.published, true);
  assert.equal(result.totalReturn, 21);
  const data = f.files.get('quant-gold.json');
  assert.deepEqual(data.points.slice(0, 2), baseline.points);
  assert.equal(data.points.at(-1).date, '2026-11-21T12:00:00.000');
  assert.equal(data.maxDrawdown.value, -12.07);
  assert.equal(data.updatedAt, '2026-11-21T12:00:00.000Z');
  assert.ok(!/accessToken|refreshToken|balance|traderLogin/.test(JSON.stringify(data)));
  assert.ok(f.api.closed);
  assert.deepEqual(f.writes.map(w => w.path), ['session.enc.json', 'quant-gold.json']);
  assert.ok(f.requests.every(t => [2100, 2102, 2121, 2133, 2143, 2149].includes(t)));
});
test('trade-enabled authorization is rejected and previous chart remains intact', async () => {
  const f = fixture({ scope: 1 });
  await assert.rejects(collect(f.options), /view-only/);
  assert.deepEqual(f.files.get('quant-gold.json'), baseline);
  assert.ok(!f.requests.includes(2133));
});
test('API failure does not overwrite the public chart', async () => {
  const f = fixture({ initialState: true, failHistory: true });
  await assert.rejects(collect(f.options), /History/);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.files.get('quant-gold.json'), baseline);
  assert.ok(f.api.closed);
});
test('dry run checks data without publishing it', async () => {
  const f = fixture({ initialState: true }); f.options.publish = false;
  const result = await collect(f.options);
  assert.equal(result.published, false);
  assert.equal(result.totalReturn, 21);
  assert.equal(f.writes.length, 0);
});
test('rotated tokens are saved even if subsequent history retrieval fails', async () => {
  const f = fixture({ failHistory: true });
  f.files.set('session.enc.json', encryptState({ ...tokens, expiresAt: now + 1000 }, key));
  f.options.fetcher = async () => ({ ok: true, json: async () => ({
    accessToken: 'new-access-token', refreshToken: 'new-refresh-token', expiresIn: 2628000 }) });
  await assert.rejects(collect(f.options), /History/);
  assert.deepEqual(f.writes.map(w => w.path), ['session.enc.json']);
  assert.equal(decryptState(f.files.get('session.enc.json'), key).refreshToken, 'new-refresh-token');
});
test('failed refresh never prints a credential-bearing request URL', async () => {
  await assert.rejects(refreshTokens(tokens, { clientId: 'id', clientSecret: 'sensitive' },
    async () => { throw new Error('https://example.test/?secret=sensitive'); }, now),
    error => !error.message.includes('sensitive') && !error.message.includes('https:'));
});
