import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubStore } from './github-store.mjs';
import { reportWeekFor, runWeeklyReport } from './weekly-telegram.mjs';

const week = { from: '2026-11-16', through: '2026-11-21' };
const stateFile = 'telegram-weeks/2026-11-16.json';

function fixture(publish = true) {
  const files = new Map();
  const calls = { collect: 0, render: 0, send: 0 };
  let version = 0;
  const store = {
    async read(name) { return files.get(name); },
    async writeChecked(name, value, _, expectedSha) {
      assert.equal(name, stateFile);
      if (files.get(name)?.sha !== expectedSha) throw new Error('Concurrent update');
      const sha = String(++version);
      files.set(name, { value, sha });
      return sha;
    }
  };
  return { files, calls, options: { week, store, publish,
    async marketContextFor(period) {
      assert.deepEqual(period, week);
      return 'Several market volatility indicators rose over the week.';
    },
    async collectReport(options) {
      calls.collect++;
      assert.equal(options.publish, false);
      assert.deepEqual(options.reportWeek, week);
      return { weeklyReport: { ...week, performancePercent: 2.60310224, closedTrades: 10 } };
    },
    async render({ period, performance, closedTrades }) {
      calls.render++;
      assert.match(period, /16.*21 Nov 2026/);
      assert.equal(performance, '+2.60%');
      assert.equal(closedTrades, 10);
      return Buffer.from('test photo');
    },
    async send({ chatId, caption }) {
      calls.send++;
      assert.equal(chatId, '@TrixTrendAlgoMonitor');
      assert.match(caption, /Weekly return \+2\.60%\nClosed trades 10/);
      assert.match(caption, /finished the week with a net gain\. Several market volatility indicators rose/);
      assert.equal(files.get(stateFile).value.status, 'pending');
      return { messageId: 87 };
    }
  } };
}

test('scheduled reports use the Vilnius Sunday and cover only its completed report week', () => {
  const now = new Date('2026-11-22T08:30:00Z');
  assert.deepEqual(reportWeekFor({ scheduled: true, now }), week);
  assert.equal(reportWeekFor({ scheduled: true, now, firstWeek: '2026-11-23' }), null);
  assert.equal(reportWeekFor({ scheduled: true, now: new Date('2026-11-22T22:01:00Z') }), null);
  assert.deepEqual(reportWeekFor({ now: new Date('2026-11-22T22:01:00Z') }), week);
  assert.deepEqual(reportWeekFor({ scheduled: true, now: new Date('2027-03-28T07:30:00Z') }),
    { from: '2027-03-22', through: '2027-03-27' });
  assert.deepEqual(reportWeekFor({ now, weekOf: '2026-11-09' }), { from: '2026-11-09', through: '2026-11-14' });
  assert.throws(() => reportWeekFor({ now, weekOf: '2026-11-17' }), /Monday/);
  assert.throws(() => reportWeekFor({ now, weekOf: '2026-11-23' }), /completed/);
});

test('preview generates the exact card and caption without claiming a week or sending', async () => {
  const f = fixture(false);
  const result = await runWeeklyReport(f.options);
  assert.equal(result.status, 'preview');
  assert.match(result.caption, /https:\/\/www\.trixtrend\.com\/quant-gold/);
  assert.equal(f.files.size, 0);
  assert.deepEqual(f.calls, { collect: 1, render: 1, send: 0 });
});

test('every caption comments on the result when market context is unavailable', async () => {
  const scenarios = [
    [-2.5, 10, /finished the week with a net loss/],
    [-0.001, 10, /finished the week broadly flat/],
    [0, 0, /No trades closed this week/]
  ];
  for (const [performancePercent, closedTrades, expectedComment] of scenarios) {
    const { options } = fixture(false);
    const result = await runWeeklyReport({ ...options,
      async collectReport() { return { weeklyReport: { ...week, performancePercent, closedTrades } }; },
      async render() { return Buffer.from('test photo'); },
      async marketContextFor() { return null; }
    });
    assert.match(result.caption, expectedComment);
    assert.doesNotMatch(result.caption, /volatility/);
  }
});

test('atomic weekly claim prevents both concurrent and subsequent duplicate posts', async () => {
  const f = fixture();
  const attempts = await Promise.allSettled([runWeeklyReport(f.options), runWeeklyReport(f.options)]);
  assert.equal(attempts.filter(entry => entry.status === 'fulfilled').length, 1);
  assert.equal(f.calls.send, 1);
  assert.deepEqual(f.files.get(stateFile).value, { ...week, status: 'sent', messageId: 87 });
  assert.deepEqual(await runWeeklyReport(f.options), { status: 'already sent', messageId: 87 });
  assert.equal(f.calls.send, 1);
});

test('confirmed rejection permits a retry; unconfirmed delivery stays pending', async () => {
  const rejected = fixture();
  await assert.rejects(runWeeklyReport({ ...rejected.options,
    send: async () => { throw Object.assign(new Error('Rejected'), { deliveryState: 'rejected' }); }
  }), /Rejected/);
  assert.equal(rejected.files.get(stateFile).value.status, 'failed');
  assert.equal((await runWeeklyReport(rejected.options)).status, 'sent');

  const unknown = fixture();
  await assert.rejects(runWeeklyReport({ ...unknown.options, send: async () => { throw new Error('Timed out'); } }), /unconfirmed/);
  assert.equal(unknown.files.get(stateFile).value.status, 'pending');
  await assert.rejects(runWeeklyReport(unknown.options), /pending/);
  assert.equal(unknown.calls.send, 0);
});

test('inconsistent collection and render failure never claim a week', async () => {
  const f = fixture();
  await assert.rejects(runWeeklyReport({ ...f.options,
    collectReport: async () => ({ weeklyReport: { ...week, through: '2026-11-20', performancePercent: 1, closedTrades: 2 } })
  }), /did not verify/);
  await assert.rejects(runWeeklyReport({ ...f.options, render: async () => { throw new Error('Render failed'); } }), /Render failed/);
  assert.equal(f.files.size, 0);
  assert.equal(f.calls.send, 0);
});

test('GitHub weekly writes send the expected version with no recapture or retries', async () => {
  const calls = [];
  const store = new GitHubStore({ repository: 'test/repo', token: 'fake', fetcher: async (url, request) => {
    calls.push({ url, request });
    return { ok: true, json: async () => ({ content: { sha: 'new-sha' } }) };
  } });
  const pending = { ...week, status: 'pending' };
  assert.equal(await store.writeChecked(stateFile, pending, 'Test'), 'new-sha');
  const creation = JSON.parse(calls[0].request.body);
  assert.equal(calls[0].request.method, 'PUT');
  assert.equal(creation.sha, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(creation.content, 'base64')), pending);
  await store.writeChecked(stateFile, { ...week, status: 'sent', messageId: 87 }, 'Test', 'new-sha');
  assert.equal(JSON.parse(calls[1].request.body).sha, 'new-sha');
  assert.equal(calls.length, 2);
  await assert.rejects(store.writeChecked('telegram-weeks/../secret.json', {}, 'Test'), /not allowed/);
});
