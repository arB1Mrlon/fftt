require('dotenv').config();
const mineflayer = require('mineflayer');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const express = require('express');
const db = require('./db');

const {
  MC_HOST, MC_PORT, MC_USERNAME, MC_AUTH,
  VIEWER_PORT, SPHERE_PRICE, SPHERE_ITEM_NAME,
  GAME_BOT_API_PORT, GAME_BOT_API_TOKEN,
} = process.env;

// ---------- очередь задач, чтобы бот не хватался за 2 дела одновременно ----------
let busy = false;
const taskQueue = [];
function enqueue(task) {
  taskQueue.push(task);
  runQueue();
}
async function runQueue() {
  if (busy || taskQueue.length === 0) return;
  busy = true;
  const task = taskQueue.shift();
  try {
    await task();
  } catch (e) {
    console.error('Ошибка задачи из очереди:', e);
  } finally {
    busy = false;
    runQueue();
  }
}

// ---------- запуск бота ----------
const bot = mineflayer.createBot({
  host: MC_HOST,
  port: Number(MC_PORT) || 25565,
  username: MC_USERNAME,
  auth: MC_AUTH || 'microsoft',
});

let captchaPending = false;

bot.once('spawn', () => {
  console.log('Бот заспавнился.');
  mineflayerViewer(bot, { port: Number(VIEWER_PORT) || 3007, firstPerson: true });
  startAntiAfk();
});

bot.on('kicked', (reason) => console.log('Кикнут:', reason));
bot.on('error', (err) => console.log('Ошибка соединения:', err));
bot.on('end', () => {
  console.log('Соединение разорвано, переподключение через 10 сек...');
  setTimeout(() => process.exit(1), 10000); // pm2/systemd подхватит рестарт
});

// ---------- анти-афк: раз в ~50 сек лёгкое действие ----------
function startAntiAfk() {
  setInterval(() => {
    const actions = ['jump', 'turn', 'step'];
    const action = actions[Math.floor(Math.random() * actions.length)];
    if (action === 'jump') {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
    } else if (action === 'turn') {
      bot.look(bot.entity.yaw + (Math.random() - 0.5), bot.entity.pitch, true);
    } else {
      bot.setControlState('forward', true);
      setTimeout(() => {
        bot.setControlState('forward', false);
        bot.setControlState('back', true);
        setTimeout(() => bot.setControlState('back', false), 300);
      }, 300);
    }
  }, 50 * 1000);
}

// ---------- капча: ловим системные сообщения, при подозрении на капчу — просим человека ----------
// ВАЖНО: под конкретный формат капчи Фантайм регэксп ниже нужно поправить самому,
// когда увидишь как она реально выглядит в чате/окне.
const CAPTCHA_REGEX = /капч|введите код|подтвердите/i;

bot.on('message', (jsonMsg) => {
  const text = jsonMsg.toString();
  if (CAPTCHA_REGEX.test(text) && !captchaPending) {
    captchaPending = true;
    console.log('Похоже на капчу, жду ответа человека:', text);
    const row = db.prepare(
      `INSERT INTO captcha_requests (status) VALUES ('waiting')`
    ).run();
    notifyAdminAboutCaptcha(row.lastInsertRowid, text);
    waitForCaptchaAnswer(row.lastInsertRowid);
  }
});

function notifyAdminAboutCaptcha(requestId, text) {
  // Сюда можно воткнуть прямой вызов telegram API либо просто лог —
  // adminBot.js параллельно поллит таблицу captcha_requests и шлёт алерт.
  console.log(`[CAPTCHA #${requestId}] Требуется ручной ввод: ${text}`);
}

function waitForCaptchaAnswer(requestId) {
  const interval = setInterval(() => {
    const row = db.prepare(`SELECT * FROM captcha_requests WHERE id = ?`).get(requestId);
    if (row && row.status === 'answered' && row.answer) {
      clearInterval(interval);
      bot.chat(row.answer);
      captchaPending = false;
      console.log(`Капча #${requestId} отправлена в чат: ${row.answer}`);
    }
  }, 2000);
}

// ---------- ДЕПОЗИТ: положить N сфер в шалкер, переименованный под ник ----------
// ЗАГЛУШКИ ПОД ТВОЙ СЕРВЕР: координаты сундука со сферами, наковальни и места для шалкера
// нужно прописать под реальную базу бота на Фантайм.
const CHEST_WITH_SPHERES = { x: 0, y: 64, z: 0 };
const ANVIL_BLOCK = { x: 1, y: 64, z: 0 };
const SHULKER_PLACEMENT = { x: 2, y: 64, z: 0 };

async function processDeposit(depositId) {
  const deposit = db.prepare(`SELECT * FROM deposits WHERE id = ?`).get(depositId);
  if (!deposit) return;

  db.prepare(`UPDATE deposits SET status = 'processing' WHERE id = ?`).run(depositId);

  try {
    const count = deposit.spheres_count;

    // 1. Забрать сферы из сундука
    const chestBlock = bot.blockAt(bot.vec3 ? bot.vec3(CHEST_WITH_SPHERES) : CHEST_WITH_SPHERES);
    const chestWindow = await bot.openContainer(chestBlock);
    const sphereItem = chestWindow.containerItems().find(i => i.name.includes(SPHERE_ITEM_NAME));
    if (!sphereItem) throw new Error('Сферы закончились на складе — нужно пополнить вручную');
    await bot.withdraw(sphereItem.type, null, count);
    await chestWindow.close();

    // 2. Переименовать стак сфер через наковальню под ник пользователя
    const anvilBlockRef = bot.blockAt(bot.vec3 ? bot.vec3(ANVIL_BLOCK) : ANVIL_BLOCK);
    const anvilWindow = await bot.openAnvil(anvilBlockRef);
    // mineflayer-anvil (плагин) — если используешь, тут anvilWindow.rename(name)
    // если голый mineflayer, переименование делается через clickWindow + текстовое поле,
    // сервер должен прислать окно с текстовым вводом — реализация зависит от протокола.
    await anvilWindow.rename(deposit.mc_nickname);
    await bot.closeWindow(anvilWindow);

    // 3. Положить в шалкер
    const shulkerBlockRef = bot.blockAt(bot.vec3 ? bot.vec3(SHULKER_PLACEMENT) : SHULKER_PLACEMENT);
    const shulkerWindow = await bot.openContainer(shulkerBlockRef);
    const renamedStack = bot.inventory.items().find(i => i.name.includes(SPHERE_ITEM_NAME));
    await bot.deposit(shulkerWindow, renamedStack.type, null, count);
    await shulkerWindow.close();

    db.prepare(
      `UPDATE deposits SET status = 'done', completed_at = datetime('now') WHERE id = ?`
    ).run(depositId);
    console.log(`Депозит #${depositId} выполнен: ${count} сфер для ${deposit.mc_nickname}`);
  } catch (e) {
    db.prepare(
      `UPDATE deposits SET status = 'failed', error = ? WHERE id = ?`
    ).run(String(e.message || e), depositId);
    console.error(`Депозит #${depositId} провалился:`, e);
  }
}

// ---------- ВЫВОД: /ah search ник -> проверка цены -> покупка ----------
async function ahSearch(nickname) {
  bot.chat(`/ah search ${nickname}`);
  return new Promise((resolve) => {
    const lots = [];
    const onWindowOpen = (window) => {
      for (const slot of window.slots) {
        if (!slot) continue;
        const lore = getLore(slot);
        const seller = extractSellerFromLore(lore);
        const price = extractPriceFromLore(lore);
        if (seller && price) {
          lots.push({ slot: slot.slot, seller, price, raw: slot });
        }
      }
      bot.removeListener('windowOpen', onWindowOpen);
      resolve({ window, lots });
    };
    bot.once('windowOpen', onWindowOpen);
  });
}

function getLore(item) {
  try {
    const nbt = item.nbt;
    return nbt?.value?.display?.value?.Lore?.value?.value || [];
  } catch {
    return [];
  }
}
// ЗАГЛУШКИ: парсинг ника/цены из лора зависит от формата конкретно Фантайм —
// нужно один раз залогировать реальный item.nbt и подогнать regexp.
function extractSellerFromLore(loreLines) {
  const line = loreLines.find(l => /продавец|seller/i.test(l));
  if (!line) return null;
  const match = line.match(/:\s*(\S+)/);
  return match ? match[1].replace(/§./g, '') : null;
}
function extractPriceFromLore(loreLines) {
  const line = loreLines.find(l => /цена|price/i.test(l));
  if (!line) return null;
  const digits = line.replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

async function processWithdrawal(withdrawalId) {
  const w = db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).get(withdrawalId);
  if (!w) return;

  db.prepare(`UPDATE withdrawals SET status = 'processing' WHERE id = ?`).run(withdrawalId);

  try {
    const { window, lots } = await ahSearch(w.mc_nickname);
    const lot = lots.find(l => l.seller.toLowerCase() === w.mc_nickname.toLowerCase());

    if (!lot) throw new Error(`Лот от ${w.mc_nickname} не найден на аукционе`);
    if (lot.price !== w.expected_price) {
      throw new Error(`Цена не совпадает: ожидалось ${w.expected_price}, в лоте ${lot.price}`);
    }

    await bot.clickWindow(lot.slot, 0, 0);
    await bot.closeWindow(window);

    db.prepare(
      `UPDATE withdrawals SET status = 'done', completed_at = datetime('now') WHERE id = ?`
    ).run(withdrawalId);
    console.log(`Вывод #${withdrawalId} выполнен: куплен лот ${w.mc_nickname} за ${lot.price}`);
  } catch (e) {
    db.prepare(
      `UPDATE withdrawals SET status = 'failed', error = ? WHERE id = ?`
    ).run(String(e.message || e), withdrawalId);
    console.error(`Вывод #${withdrawalId} провалился:`, e);
  }
}

// ---------- локальное HTTP API для admin-бота ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers['x-api-token'] !== GAME_BOT_API_TOKEN) return res.sendStatus(403);
  next();
});

app.post('/deposit/:id', (req, res) => {
  enqueue(() => processDeposit(Number(req.params.id)));
  res.json({ queued: true });
});

app.post('/withdraw/:id', (req, res) => {
  enqueue(() => processWithdrawal(Number(req.params.id)));
  res.json({ queued: true });
});

app.post('/ah/sell', async (req, res) => {
  const { price } = req.body;
  bot.chat(`/ah sell ${price}`);
  res.json({ sent: true });
});

app.post('/ah/search', async (req, res) => {
  const { nickname } = req.body;
  const { lots } = await ahSearch(nickname);
  res.json({ lots });
});

app.post('/captcha/answer/:id', (req, res) => {
  const { answer } = req.body;
  db.prepare(`UPDATE captcha_requests SET status='answered', answer=? WHERE id=?`)
    .run(answer, req.params.id);
  res.json({ ok: true });
});

app.listen(Number(GAME_BOT_API_PORT) || 4000, () =>
  console.log(`Локальное API игрового бота слушает порт ${GAME_BOT_API_PORT || 4000}`)
);
