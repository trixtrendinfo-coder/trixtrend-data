import { setTimeout as pause } from 'node:timers/promises';

// Intentionally excludes every trading operation, order and position modification.
const allowed = new Map([[2100, 2101], [2102, 2103], [2121, 2122], [2133, 2134], [2143, 2144], [2149, 2150]]);

export class CTrader {
  constructor(environment = 'live') {
    if (!['live', 'demo'].includes(environment)) throw new Error('Invalid environment');
    this.url = `wss://${environment}.ctraderapi.com:5036`;
    this.pending = new Map();
    this.sequence = 0;
  }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        const pending = this.pending.get(message.clientMsgId);
        if (!pending) return;
        this.pending.delete(message.clientMsgId);
        clearTimeout(pending.timer);
        if (message.payloadType !== pending.expected || message.payload?.errorCode) {
          pending.reject(new Error('cTrader rejected a read-only request'));
        } else pending.resolve(message.payload);
      } catch {
        this.failAll(new Error('Invalid cTrader message'));
      }
    });
    this.socket.addEventListener('close', () => this.failAll(new Error('cTrader connection closed')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.close(); reject(new Error('Connection timeout')); }, 20000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Connection failed')); }, { once: true });
    });
    this.heartbeat = setInterval(() => {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ payloadType: 51, payload: {} }));
      }
    }, 10000);
  }
  failAll(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  async request(type, payload) {
    if (!allowed.has(type)) throw new Error('Operation blocked: read-only allowlist');
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Not connected');
    // Historical requests are limited to five per second; use a conservative shared interval.
    await pause(275);
    const clientMsgId = 'trix-' + ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error('Read-only request timed out'));
      }, 20000);
      this.pending.set(clientMsgId, { resolve, reject, timer, expected: allowed.get(type) });
      this.socket.send(JSON.stringify({ clientMsgId, payloadType: type, payload }));
    });
  }
  close() {
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.failAll(new Error('Connection finished'));
  }
}

export async function fetchDeals(api, account, from, to) {
  const result = await api.request(2133, {
    ctidTraderAccountId: account, fromTimestamp: from, toTimestamp: to, maxRows: 1000
  });
  if (!result.hasMore) return result.deal ?? [];
  // Split the time interval rather than skipping records at a shared millisecond boundary.
  if (from >= to) throw new Error('Too many deals at one timestamp; publication stopped');
  const middle = Math.floor((from + to) / 2);
  return [...await fetchDeals(api, account, from, middle), ...await fetchDeals(api, account, middle + 1, to)];
}

export async function fetchHistory(api, account, from, to) {
  const deals = [], cashFlows = [];
  const week = 7 * 86400000;
  for (let begin = from; begin <= to; begin += week) {
    const end = Math.min(begin + week - 1, to);
    deals.push(...await fetchDeals(api, account, begin, end));
    const cash = await api.request(2143, {
      ctidTraderAccountId: account, fromTimestamp: begin, toTimestamp: end
    });
    cashFlows.push(...cash.depositWithdraw ?? []);
  }
  return { deals, cashFlows };
}
