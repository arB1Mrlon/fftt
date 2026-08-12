# Fantime Exchange Bot — скелет проекта

## Структура

```
src/
  db.js               — SQLite: users, deposits, withdrawals, captcha_requests
  depositBot.js        — игровой бот (mineflayer): анти-афк, вьювер, депозит/вывод, локальное HTTP API
  adminBot.js           — Telegram-бот управления (вайтлист): /ah sell, /ah search, капча, статистика
  depositClientBot.js  — Telegram-бот для клиентов: создание заявок на пополнение
```

Все три процесса общаются через одну SQLite базу + локальное HTTP API игрового бота
(`GAME_BOT_API_PORT`, доступен только на 127.0.0.1, наружу не торчит).

## Что нужно доделать под конкретно Фантайм (заглушки в коде помечены комментариями)

1. **Координаты** сундука со сферами, наковальни, места установки шалкера — `depositBot.js`.
2. **Формат капчи** — сейчас ловится по regex `CAPTCHA_REGEX` в чате. Если капча через GUI-окно
   (не чат) — нужно перехватывать `windowOpen`, а не `message`.
3. **Парсинг лора аукциона** — `extractSellerFromLore` / `extractPriceFromLore`. Формат лора у
   каждого сервера свой, нужно один раз залогировать `item.nbt` реального лота и подогнать regex.
4. **Переименование через наковальню** — если `mineflayer-anvil` плагин не подходит под протокол
   сервера, переименование делается через `clickWindow` в текстовое поле окна наковальни (зависит
   от реализации GUI на сервере).

## Установка

```bash
git clone <твой репозиторий> fantime-bot
cd fantime-bot
npm install
cp .env.example .env
nano .env   # вписать токены, host, whitelist
```

## Запуск через PM2 (чтобы жило без твоего компа)

```bash
npm i -g pm2

pm2 start src/depositBot.js --name mc-game-bot
pm2 start src/adminBot.js --name mc-admin-bot
pm2 start src/depositClientBot.js --name mc-deposit-bot

pm2 save
pm2 startup   # выполнить команду, которую выведет pm2 — привяжет автозапуск к systemd
```

Проверка статуса / логов:

```bash
pm2 status
pm2 logs mc-game-bot
```

## Просмотр картинки игры

```
http://<IP_твоего_VDS>:3007
```

⚠️ Обязательно закрой этот порт файрволом снаружи или повесь nginx с basic-auth —
иначе картинку твоей игры сможет открыть кто угодно:

```bash
ufw allow from <твой_домашний_ip> to any port 3007
ufw deny 3007
```

## Вайтлист

Управлять `adminBot.js` (команды `/ah sell`, `/ah search`, подтверждение капчи, статистика)
может только тот, чей Telegram user_id указан в `ADMIN_WHITELIST` в `.env`. Узнать свой id можно
у бота @userinfobot.

`depositClientBot.js` — открытый для всех клиентов, доступа к управлению у него нет,
только создание заявок в БД.

## Безопасность денег

- Перед покупкой лота на вывод бот **строго сверяет** ник продавца и цену с тем, что указано
  в заявке (`processWithdrawal`). Не убирай эту проверку — иначе пользователь сможет подсунуть
  лот дороже и слить тебе баланс.
- Ставь лимиты на сумму одной заявки и лимит заявок в час на пользователя — это стоит добавить
  в `depositClientBot.js` дополнительно.
- Веди лог всех failed-заявок (`error` в таблицах) — пригодится для разбора споров.
