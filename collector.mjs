import { CTrader, fetchHistory } from './ctrader.mjs';
import { buildHistory, historyTime } from './returns.mjs';
import { validateChartData } from './chart-data.mjs';
import { encryptState, decryptState } from './vault.mjs';

function checkTokens(value) {
  if (!value || typeof value.accessToken !== 'string' || value.accessToken.length < 10 ||
      typeof value.refreshToken !== 'string' || value.refreshToken.length < 10 ||
      !Number.isSafeInteger(value.expiresAt)) throw new Error('Missing or invalid cTrader token bundle');
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt };
}

export async function refreshTokens(tokens, credentials, fetcher = fetch, now = Date.now()) {
  const url = new URL('https://openapi.ctrader.com/apps/token');
  url.search = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken,
    client_id: credentials.clientId, client_secret: credentials.clientSecret });
  // This URL includes credentials: never log it or serialize fetch errors.
  let response;
  try { response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error('cTrader token refresh connection failed; existing chart retained'); }
  if (!response.ok) throw new Error('cTrader token refresh was rejected');
  let result;
  try { result = await response.json(); } catch { throw new Error('Invalid token refresh response'); }
  if (result.errorCode || !Number.isSafeInteger(result.expiresIn) || result.expiresIn <= 0) {
    throw new Error('Token refresh did not return a usable lifetime');
  }
  return checkTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken,
    expiresAt: now + result.expiresIn * 1000 });
}

export async function collect({ baseline, store, stateKey, clientId, clientSecret,
  accountLogin, environment = 'live', bootstrapTokens, publish = false, reportWeek,
  apiFactory = env => new CTrader(env), fetcher = fetch, now = () => Date.now() }) {
  if (!clientId || !clientSecret || !/^\d+$/.test(String(accountLogin))) {
    throw new Error('cTrader application credentials and target account login are required');
  }
  const credentials = { clientId, clientSecret };
  const encrypted = await store.read('session.enc.json');
  let tokens = checkTokens(encrypted ? decryptState(encrypted.value, stateKey) : bootstrapTokens);
  // Verify the encryption key before issuing a refresh, which invalidates the old refresh token.
  encryptState(tokens, stateKey);
  const saveSession = () => store.write('session.enc.json', encryptState(tokens, stateKey),
    'Maintain encrypted read-only connection [skip ci]');
  if (encrypted && tokens.expiresAt - now() < 7 * 86400000) {
    tokens = await refreshTokens(tokens, credentials, fetcher, now());
    // Persist the rotation even when a later history validation fails.
    await saveSession();
  }
  if (tokens.expiresAt <= now()) throw new Error('Access token is expired; bootstrap must be renewed');
  const api = apiFactory(environment);
  try {
    await api.connect();
    await api.request(2100, credentials);
    const accounts = await api.request(2149, { accessToken: tokens.accessToken });
    if (![0, 'SCOPE_VIEW'].includes(accounts.permissionScope)) {
      throw new Error('Connection must be authorized with view-only scope');
    }
    const account = (accounts.ctidTraderAccount ?? []).find(a =>
      String(a.traderLogin) === String(accountLogin) && a.isLive === (environment === 'live'));
    if (!account) throw new Error('The specified account is not authorized in this environment');
    const accountId = account.ctidTraderAccountId;
    if (!Number.isSafeInteger(Number(accountId))) throw new Error('Unsupported account identifier precision');
    await api.request(2102, { ctidTraderAccountId: accountId, accessToken: tokens.accessToken });
    const accountInfo = await api.request(2121, { ctidTraderAccountId: accountId });
    const asOf = now();
    const offset = baseline.sourceUtcOffsetMinutes ?? 0;
    const from = historyTime(baseline.points[0].date, offset);
    const history = await fetchHistory(api, accountId, from, asOf);
    // A second read detects live account changes during collection. Retry on the next scheduled run.
    const after = await api.request(2121, { ctidTraderAccountId: accountId });
    if (String(accountInfo.trader?.balance) !== String(after.trader?.balance) ||
        String(accountInfo.trader?.balanceVersion) !== String(after.trader?.balanceVersion)) {
      throw new Error('Account changed while history was collected; next run will retry');
    }
    const { weeklyReport, ...result } = buildHistory({ baseline, ...history,
      moneyDigits: accountInfo.trader?.moneyDigits ?? 2, asOf, reportWeek });
    const prior = await store.read('quant-gold.json');
    validateChartData(result, baseline, prior?.value ?? baseline);
    // A new bootstrap remains replaceable until scope, account and history all validate.
    if (!encrypted) await saveSession();
    if (publish) {
      await store.write('quant-gold.json', result, 'Update verified performance data [skip ci]');
    }
    return { published: publish, through: result.through, points: result.points.length,
      totalReturn: +(result.points.at(-1).index - 100).toFixed(2), mode: result.mode,
      ...(weeklyReport && { weeklyReport }) };
  } finally { api.close(); }
}
