const TELEGRAM_API = 'https://api.telegram.org';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function deliveryError(message, deliveryState = 'rejected') {
  return Object.assign(new Error(message), { deliveryState });
}

function isChannelId(id) {
  return Number.isSafeInteger(id) && id < -1_000_000_000_000;
}

function isTarget(chatId) {
  return /^@[a-z][a-z0-9_]{2,31}$/i.test(chatId) ||
    (/^-[1-9]\d{12,15}$/.test(chatId) && isChannelId(Number(chatId)));
}

async function telegramRequest({ token, method, fields, upload, fetcher }) {
  const sending = method === 'sendPhoto';
  const failureState = sending ? 'unknown' : 'rejected';
  let response;
  let result;
  try {
    response = await fetcher(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(sending ? 45000 : 15000),
      headers: upload ? undefined : { 'Content-Type': 'application/json' },
      body: upload ?? JSON.stringify(fields)
    });
    result = await response.json();
  } catch {
    throw deliveryError(`Telegram ${method} did not return a readable response.`, failureState);
  }

  if (response.ok && result?.ok === true) return result.result;

  const status = response.status;
  if (status >= 400 && status < 500 && status !== 408 &&
      result?.ok === false && result.error_code === status) {
    throw deliveryError(`Telegram rejected ${method} (HTTP ${status}).`);
  }
  throw deliveryError(`Telegram ${method} returned an unconfirmed result.`, failureState);
}

export async function verifyPostingChannel({ token, chatId, fetcher = fetch }) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw deliveryError('A valid Telegram bot token is required.');
  }
  const target = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId) : '';
  if (!isTarget(target)) throw deliveryError('A Telegram channel username or numeric channel ID is required.');

  const request = (method, fields) => telegramRequest({ token, method, fields, fetcher });
  const [bot, channel] = await Promise.all([
    request('getMe', {}),
    request('getChat', { chat_id: target })
  ]);
  if (bot?.is_bot !== true || !Number.isSafeInteger(bot.id) || bot.id <= 0) {
    throw deliveryError('Telegram did not confirm the bot identity.');
  }
  if (channel?.type !== 'channel' || !isChannelId(channel.id) ||
      (target.startsWith('-') && channel.id !== Number(target))) {
    throw deliveryError('Telegram did not confirm the configured broadcast channel.');
  }

  const member = await request('getChatMember', { chat_id: channel.id, user_id: bot.id });
  if (member?.user?.id !== bot.id || member.status !== 'administrator' || member.can_post_messages !== true) {
    throw deliveryError('The Telegram bot requires permission to post messages in the channel.');
  }
  return channel.id;
}

export async function sendWeeklyPhoto({ token, chatId, photo, caption, fetcher = fetch }) {
  if (!Buffer.isBuffer(photo) || photo.length === 0 || photo.length > MAX_PHOTO_BYTES) {
    throw deliveryError('The Telegram photo must be a non-empty Buffer up to 10 MB.');
  }
  if (typeof caption !== 'string' || !caption.trim() || caption.length > 1024) {
    throw deliveryError('The Telegram caption must contain between 1 and 1,024 characters.');
  }

  // Use the resolved numeric channel ID so a username change cannot redirect the post.
  const channelId = await verifyPostingChannel({ token, chatId, fetcher });
  const upload = new FormData();
  upload.append('chat_id', String(channelId));
  upload.append('photo', new Blob([photo], { type: 'image/png' }), 'quant-gold.png');
  upload.append('caption', caption);
  const message = await telegramRequest({ token, method: 'sendPhoto', upload, fetcher });
  if (!Number.isSafeInteger(message?.message_id) || message.message_id <= 0 || message.chat?.id !== channelId) {
    throw deliveryError('Telegram did not confirm the posted photo and channel.', 'unknown');
  }
  return { messageId: message.message_id };
}
