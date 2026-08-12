require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const { DEPOSIT_BOT_TOKEN, SPHERE_PRICE } = process.env;
const bot = new TelegramBot(DEPOSIT_BOT_TOKEN, { polling: true });

const userState = new Map(); // telegram_id -> шаг диалога

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Привет! Это бот пополнения на Фантайм.\n' +
    'Напиши /deposit чтобы пополнить баланс.'
  );
});

bot.onText(/\/deposit/, (msg) => {
  userState.set(msg.from.id, { step: 'awaiting_nickname' });
  bot.sendMessage(msg.chat.id, 'Введи свой игровой ник на сервере:');
});

bot.on('message', (msg) => {
  const state = userState.get(msg.from.id);
  if (!state || msg.text.startsWith('/')) return;

  if (state.step === 'awaiting_nickname') {
    state.nickname = msg.text.trim();
    state.step = 'awaiting_amount';
    bot.sendMessage(msg.chat.id, `Ник принят: ${state.nickname}\nСколько монет хочешь закинуть? (кратно ${SPHERE_PRICE})`);
    return;
  }

  if (state.step === 'awaiting_amount') {
    const amount = Number(msg.text.replace(/\D/g, ''));
    const price = Number(SPHERE_PRICE);
    if (!amount || amount % price !== 0) {
      bot.sendMessage(msg.chat.id, `Сумма должна быть кратна ${price}. Попробуй ещё раз.`);
      return;
    }
    const spheresCount = amount / price;

    const result = db.prepare(
      `INSERT INTO deposits (telegram_id, mc_nickname, amount, spheres_count, status)
       VALUES (?, ?, ?, ?, 'pending')`
    ).run(msg.from.id, state.nickname, amount, spheresCount);

    userState.delete(msg.from.id);
    bot.sendMessage(
      msg.chat.id,
      `Заявка #${result.lastInsertRowid} создана.\n` +
      `Ник: ${state.nickname}\nСумма: ${amount}\nСфер к выдаче: ${spheresCount}\n\n` +
      `Бот сам заберёт шалкер с сервера в течение нескольких минут. Отслеживать статус: /status ${result.lastInsertRowid}`
    );
  }
});

bot.onText(/\/status (\d+)/, (msg, match) => {
  const dep = db.prepare(`SELECT * FROM deposits WHERE id=? AND telegram_id=?`).get(
    Number(match[1]), msg.from.id
  );
  if (!dep) return bot.sendMessage(msg.chat.id, 'Заявка не найдена.');
  const statusText = {
    pending: 'в очереди',
    processing: 'бот сейчас выполняет',
    done: 'выполнено ✅',
    failed: `ошибка ❌ (${dep.error || 'неизвестно'})`,
  }[dep.status];
  bot.sendMessage(msg.chat.id, `Заявка #${dep.id}: ${statusText}`);
});

console.log('Клиентский депозит-бот запущен.');
