import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { collect } from './collector.mjs';
import { GitHubStore } from './github-store.mjs';
import { getMarketContext } from './market-context.mjs';
import { sendWeeklyPhoto } from './telegram.mjs';

const DAY = 86400000;
const CHANNEL = '@TrixTrendAlgoMonitor';
const localDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Vilnius', year: 'numeric', month: '2-digit', day: '2-digit'
});
const displayDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric'
});
const displayPercent = new Intl.NumberFormat('en-GB', {
  style: 'percent', signDisplay: 'exceptZero', useGrouping: false,
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
const run = promisify(execFile);

function isoDate(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function monday(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Choose the Monday of the report week in YYYY-MM-DD format.');
  }
  const time = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(time) || isoDate(time) !== date || new Date(time).getUTCDay() !== 1) {
    throw new Error('Choose the Monday of the report week in YYYY-MM-DD format.');
  }
  return time;
}

export function reportWeekFor({ now = new Date(), scheduled = false, weekOf, firstWeek }) {
  const dateInVilnius = Date.parse(localDate.format(now) + 'T00:00:00Z');
  const weekday = new Date(dateInVilnius).getUTCDay();
  if (scheduled && weekday !== 0) return null;
  const latestMonday = dateInVilnius - (weekday + 6) * DAY;
  const first = weekOf ? monday(weekOf) : latestMonday;
  if (first > latestMonday) throw new Error('Choose a completed report week.');
  if (scheduled && firstWeek && first < monday(firstWeek)) return null;
  return { from: isoDate(first), through: isoDate(first + 5 * DAY) };
}

async function renderPhoto({ period, performance, closedTrades, output }) {
  const script = fileURLToPath(new URL('./render-weekly-card.py', import.meta.url));
  await mkdir(path.dirname(output), { recursive: true });
  await run(process.env.PYTHON_BIN || 'python3', [script, `--period=${period}`,
    `--performance=${performance}`, `--trades=${closedTrades}`, `--output=${output}`], { timeout: 30000 });
  return readFile(output);
}

function deliveryStatus(entry, week) {
  if (!entry) return undefined;
  const { from, through, status, messageId } = entry.value ?? {};
  if (from !== week.from || through !== week.through || !['pending', 'failed', 'sent'].includes(status) ||
      (status === 'sent' && (!Number.isSafeInteger(messageId) || messageId <= 0))) {
    throw new Error('The saved Telegram report status is invalid.');
  }
  return status;
}

function weeklyComment(performance, closedTrades, marketContext) {
  if (!closedTrades) {
    return ['No trades closed this week.', marketContext].filter(Boolean).join(' ');
  }
  const outcome = {
    '+': 'The strategy finished the week with a net gain.',
    '-': 'The strategy finished the week with a net loss.'
  }[performance[0]] ?? 'The strategy finished the week broadly flat.';
  return [outcome, marketContext].filter(Boolean).join(' ');
}

export async function runWeeklyReport({ week, baseline, store, connection, publish = false,
  token, chatId = CHANNEL, output, collectReport = collect, render = renderPhoto, send = sendWeeklyPhoto,
  marketContextFor = getMarketContext }) {
  const stateFile = `telegram-weeks/${week.from}.json`;
  const message = `Record Quant Gold Telegram status for ${week.from} [skip ci]`;
  const prior = publish ? await store.read(stateFile) : null;
  const status = deliveryStatus(prior, week);
  if (status === 'sent') return { status: 'already sent', messageId: prior.value.messageId };
  if (status === 'pending') throw new Error('Telegram delivery is pending. Check the channel before resolving the saved status.');

  const { weeklyReport } = await collectReport({ ...connection, baseline, store, reportWeek: week, publish: false });
  const { from, through, performancePercent, closedTrades } = weeklyReport ?? {};
  if (from !== week.from || through !== week.through || !Number.isFinite(performancePercent) ||
      !Number.isSafeInteger(closedTrades) || closedTrades < 0) {
    throw new Error('The collector did not verify results for the requested week.');
  }
  const period = displayDate.formatRange(Date.parse(from + 'T00:00:00Z'), Date.parse(through + 'T00:00:00Z'));
  const performance = displayPercent.format(performancePercent / 100);
  const [photo, marketContext] = await Promise.all([
    render({ period, performance, closedTrades, output }),
    marketContextFor(week)
  ]);
  const caption = [
    'Quant Gold | Weekly results', period, '',
    `Weekly return ${performance}`, `Closed trades ${closedTrades}`, '',
    weeklyComment(performance, closedTrades, marketContext), '',
    'Past performance does not guarantee future results.', 'https://www.trixtrend.com/quant-gold'
  ].join('\n');
  if (!publish) return { status: 'preview', weeklyReport, caption };

  const reportDates = { from, through };
  const pendingSha = await store.writeChecked(stateFile, { ...reportDates, status: 'pending' }, message, prior?.sha);
  let delivery;
  try {
    delivery = await send({ token, chatId, photo, caption });
  } catch (error) {
    if (error?.deliveryState === 'rejected') {
      await store.writeChecked(stateFile, { ...reportDates, status: 'failed' }, message, pendingSha);
      throw error;
    }
    throw new Error('Telegram delivery is unconfirmed. Check the channel before resolving the saved status.');
  }
  const { messageId } = delivery ?? {};
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('Telegram did not confirm the message ID.');
  await store.writeChecked(stateFile, { ...reportDates, status: 'sent', messageId }, message, pendingSha);
  return { status: 'sent', messageId, weeklyReport, caption };
}

async function main(env) {
  const scheduled = env.GITHUB_EVENT_NAME === 'schedule';
  if (scheduled && Number(env.GITHUB_RUN_ATTEMPT) > 1) {
    console.log('Use a manual run with an explicit week to retry a scheduled report.');
    return;
  }
  const publish = scheduled || env.PUBLISH_TELEGRAM === 'true';
  if (env.CTRADER_CONFIGURED !== 'true') throw new Error('Configure the read-only cTrader connection first.');
  if (publish && (env.TELEGRAM_WEEKLY_ENABLED !== 'true' || env.CTRADER_WEEKLY_VERIFIED !== 'true')) {
    throw new Error('Verify the read-only weekly preview and enable Telegram publication first.');
  }
  if (publish && !scheduled && !env.REPORT_WEEK) throw new Error('Manual publication requires a report week.');
  const week = reportWeekFor({ scheduled, weekOf: scheduled ? undefined : env.REPORT_WEEK, firstWeek: env.TELEGRAM_WEEKLY_START });
  if (!week) { console.log('No Telegram report is due today.'); return; }
  const baseline = JSON.parse(await readFile(new URL('./baseline.json', import.meta.url), 'utf8'));
  const output = path.resolve('weekly-report/quant-gold.png');
  const result = await runWeeklyReport({ week, baseline, output, publish,
    store: new GitHubStore({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN }),
    connection: {
      stateKey: env.STATE_KEY, clientId: env.CTRADER_CLIENT_ID, clientSecret: env.CTRADER_CLIENT_SECRET,
      accountLogin: env.CTRADER_ACCOUNT_LOGIN, environment: 'live',
      bootstrapTokens: env.CTRADER_TOKEN_BUNDLE ? JSON.parse(env.CTRADER_TOKEN_BUNDLE) : undefined
    }, token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID || CHANNEL });
  const { caption, ...summary } = result;
  if (result.status === 'preview') await writeFile(path.join(path.dirname(output), 'caption.txt'), caption + '\n');
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.env); }
  catch (error) {
    const message = error?.message;
    console.error(typeof message === 'string' && !/https?:|token=|secret=|Bearer/i.test(message)
      ? message : 'The weekly Telegram report failed.');
    process.exitCode = 1;
  }
}
