import assert from 'node:assert/strict';
import test from 'node:test';
import { sendWeeklyPhoto } from './telegram.mjs';

const token = '123:fake_token-for_test';
const channelId = -1001234567890;
const bot = { id: 123, is_bot: true };
const channel = { id: channelId, type: 'channel' };
const administrator = { user: bot, status: 'administrator', can_post_messages: true };
const photo = Buffer.from('89504e470d0a1a0a', 'hex');
const caption = 'Quant Gold\nWeekly change +2.60%\n10 closed trades';
const options = { token, chatId: '@TrixTrendTest', photo, caption };

function ok(result) {
  return Response.json({ ok: true, result });
}

function telegramMock({ chat = channel, member = administrator, send } = {}) {
  const calls = [];
  const fetcher = async (url, request) => {
    const method = new URL(url).pathname.split('/').at(-1);
    calls.push({ method, request });
    if (method === 'getMe') return ok(bot);
    if (method === 'getChat') return ok(chat);
    if (method === 'getChatMember') return ok(member);
    if (send) return send(url);
    return ok({ message_id: 42, chat: channel });
  };
  return { calls, fetcher };
}

test('posts a plain caption and photo to the verified numeric Telegram channel', async () => {
  const { calls, fetcher } = telegramMock();
  assert.deepEqual(await sendWeeklyPhoto({ ...options, fetcher }), { messageId: 42 });
  assert.deepEqual(calls.map(({ method }) => method), ['getMe', 'getChat', 'getChatMember', 'sendPhoto']);
  assert.deepEqual(JSON.parse(calls[1].request.body), { chat_id: options.chatId });
  assert.deepEqual(JSON.parse(calls[2].request.body), { chat_id: channelId, user_id: bot.id });
  const { body, redirect } = calls[3].request;
  assert.equal(redirect, 'error');
  assert.equal(body.get('chat_id'), String(channelId));
  assert.equal(body.get('caption'), caption);
  assert.equal(body.get('parse_mode'), null);
  assert.equal(body.get('photo').type, 'image/png');
  assert.deepEqual(Buffer.from(await body.get('photo').arrayBuffer()), photo);
});

test('rejects invalid destinations and refuses to post to a group or without posting permission', async () => {
  const invalid = telegramMock();
  await assert.rejects(sendWeeklyPhoto({ ...options, chatId: 'https://t.me/TrixTrendTest', fetcher: invalid.fetcher }),
    { deliveryState: 'rejected' });
  assert.equal(invalid.calls.length, 0);

  const group = telegramMock({ chat: { ...channel, type: 'supergroup' } });
  await assert.rejects(sendWeeklyPhoto({ ...options, fetcher: group.fetcher }), { deliveryState: 'rejected' });
  assert.deepEqual(group.calls.map(({ method }) => method), ['getMe', 'getChat']);

  const restricted = telegramMock({ member: { ...administrator, can_post_messages: false } });
  await assert.rejects(sendWeeklyPhoto({ ...options, chatId: String(channelId), fetcher: restricted.fetcher }),
    { deliveryState: 'rejected' });
  assert.deepEqual(restricted.calls.map(({ method }) => method), ['getMe', 'getChat', 'getChatMember']);
});

test('labels a Telegram rejection as retryable by the caller and keeps response descriptions out of errors', async () => {
  const { fetcher } = telegramMock({
    send: url => Response.json({ ok: false, error_code: 403, description: url }, { status: 403 })
  });
  await assert.rejects(sendWeeklyPhoto({ ...options, fetcher }), error => {
    assert.equal(error.deliveryState, 'rejected');
    assert.equal(error.message, 'Telegram rejected sendPhoto (HTTP 403).');
    return true;
  });
});

test('treats uncertain upload outcomes as unknown without retrying or leaking the request URL', async () => {
  const inconsistentChat = { ...channel, id: channelId - 1 };
  const responses = [
    url => { throw new Error(url); },
    () => Response.json({ ok: false, error_code: 503 }, { status: 503 }),
    () => new Response('Gateway Timeout', { status: 504 }),
    () => ok({ message_id: 0, chat: channel }),
    () => ok({ message_id: 14, chat: inconsistentChat })
  ];
  for (const send of responses) {
    const { calls, fetcher } = telegramMock({ send });
    await assert.rejects(sendWeeklyPhoto({ ...options, fetcher }), error => {
      assert.equal(error.deliveryState, 'unknown');
      assert.equal(error.message.includes(token) || error.message.includes('https://'), false);
      return true;
    });
    assert.equal(calls.filter(({ method }) => method === 'sendPhoto').length, 1);
  }
});
