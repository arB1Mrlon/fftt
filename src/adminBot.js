require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const {
  ADMIN_BOT_TOKEN, ADMIN_WHITELIST,
  GAME_BOT_API_PORT, GAME_BOT_API_TOKEN,
} = process.env;

const whitelist = new Set(
  (ADMIN_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean)
);

const bot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
const GAME_API = `http://127.0.0.1:${GAME_BOT_API_PORT || 4000}`;

function isAllowed(msg) {
  return whitelist.has(String(msg.from.id));
}

function deny(chatId) {
  bot.sendMessage(chatId, 'У тебя нет доступа к этому боту.');
}

async function callGameApi(path, body) {
  const res = await fetch(`${GAME_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-token': GAME_BOT_API_TOKEN,
    },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

// ---------- /ah sell цена ----------
bot.onText(/\/ah sell (\d+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const price = Number(match[1]);
  await callGameApi('/ah/sell', { price });
  bot.sendMessage(msg.chat.id, `Выставил лот с ценой ${price}`);
});

// ---------- /ah search ник ----------
bot.onText(/\/ah search (\S+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const nickname = match[1];
  const result = await callGameApi('/ah/search', { nickname });
  if (!result.lots || result.lots.length === 0) {
    return bot.sendMessage(msg.chat.id, `Лотов от ${nickname} не найдено.`);
  }
  const text = result.lots
    .map(l => `слот ${l.slot} — продавец: ${l.seller}, цена: ${l.price}`)
    .join('\n');
  bot.sendMessage(msg.chat.id, text);
});

// ---------- обработка ожидающих капч: /captcha id ответ ----------
bot.onText(/\/captcha (\d+) (.+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const [, id, answer] = match;
  await callGameApi(`/captcha/answer/${id}`, { answer });
  bot.sendMessage(msg.chat.id, `Ответ на капчу #${id} отправлен.`);
});

// ---------- ручной запуск обработки депозита/вывода ----------
bot.onText(/\/deposit_run (\d+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  await callGameApi(`/deposit/${match[1]}`);
  bot.sendMessage(msg.chat.id, `Депозит #${match[1]} поставлен в очередь.`);
});

bot.onText(/\/withdraw_run (\d+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  await callGameApi(`/withdraw/${match[1]}`);
  bot.sendMessage(msg.chat.id, `Вывод #${match[1]} поставлен в очередь.`);
});

// ---------- статистика ----------
bot.onText(/\/stats/, (msg) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const pendingDeposits = db.prepare(`SELECT COUNT(*) c FROM deposits WHERE status='pending'`).get().c;
  const pendingWithdrawals = db.prepare(`SELECT COUNT(*) c FROM withdrawals WHERE status='pending'`).get().c;
  const failedToday = db.prepare(
    `SELECT COUNT(*) c FROM deposits WHERE status='failed' AND date(created_at)=date('now')`
  ).get().c;
  bot.sendMessage(
    msg.chat.id,
    `Ожидают депозита: ${pendingDeposits}\nОжидают вывода: ${pendingWithdrawals}\nПровалились сегодня: ${failedToday}`
  );
});

// ---------- периодический опрос новых капча-запросов, алерт всем из вайтлиста ----------
setInterval(() => {
  const waiting = db.prepare(`SELECT * FROM captcha_requests WHERE status='waiting'`).all();
  for (const req of waiting) {
    for (const adminId of whitelist) {
      bot.sendMessage(
        adminId,
        `⚠️ Бот просит капчу #${req.id} (создана ${req.created_at}).\n` +
        `Открой картинку в вьювере и ответь: /captcha ${req.id} <текст>`
      );
    }
  }
}, 15000);

// ---------- автозапуск новых pending-депозитов/выводов ----------
setInterval(async () => {
  const deposits = db.prepare(`SELECT id FROM deposits WHERE status='pending'`).all();
  for (const d of deposits) await callGameApi(`/deposit/${d.id}`);

  const withdrawals = db.prepare(`SELECT id FROM withdrawals WHERE status='pending'`).all();
  for (const w of withdrawals) await callGameApi(`/withdraw/${w.id}`);
}, 10000);

console.log('Admin-бот запущен.');
