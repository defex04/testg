# MMORPG — локальный стек: базы данных + бэкенд под arena-game

Все БД из архитектурного документа готовы целиком; функционал бэкенда —
ровно тот, что в прототипе `arena-game`: персонаж с кошельком и опытом,
локации с переходами, «Охота» (пошаговый бой 3×3 против NPC, формулы из
`BattleSystem.js` один в один), экипировка, чат локации, список игроков
в локации. Вход — Telegram Mini App (или dev-вход для браузера).

## Запуск (Docker Desktop)

```powershell
copy .env.example .env
docker compose up -d --build
```

Поднимется: PostgreSQL (`mmo_auth` / `mmo_billing` / `mmo_game`, ~110 таблиц),
Redis, API на http://localhost:8080. Scylla/Kafka/ClickHouse — профиль `full`,
на этапе 1 не нужны. Сброс начисто: `docker compose down -v`.

Быстрая проверка:

```powershell
curl http://localhost:8080/api/health
curl -X POST http://localhost:8080/api/auth/dev -H "Content-Type: application/json" -d "{\"name\":\"ИгрокА\"}"
```

Второй вызов вернёт токен и персонажа: создан аккаунт, персонаж 15 уровня
в Деревне со стартовым бронзовым доспехом (всё через ledger'ы).

## Сервер на Azure (для GitHub Pages)

Развёрнут на VM `azureuser@4.231.90.10` (Ubuntu 24.04, Docker) в `~/mmorpg-local`.
API доступен по **https://4.231.90.10.sslip.io** — Caddy (`docker-compose.azure.yml` +
`Caddyfile`) терминирует TLS с автосертификатом Let's Encrypt и проксирует на api:8080.
HTTPS обязателен: GitHub Pages блокирует http/ws с https-страницы (mixed content).

Сервер выбирает игрок на стартовом экране (`index.html`): «Локальный сервер»
или «Сервер Azure»; рекомендуемый вариант подсвечивается по месту запуска
(localhost — локальный, внешний хостинг — Azure). Выбор кладётся в
`window.API_URL`, и только потом загружается `js/main.js`.

Обновление сервера на VM:

```powershell
scp -i C:\Users\andre\Downloads\mygame_key.pem -r server\mmorpg-local azureuser@4.231.90.10:~/
ssh -i C:\Users\andre\Downloads\mygame_key.pem azureuser@4.231.90.10 "chmod -R a+rX ~/mmorpg-local; cd ~/mmorpg-local; sudo docker compose -f docker-compose.yml -f docker-compose.azure.yml up -d --build"
```

`.env` на VM не перезатирать: там боевой `ADMIN_PASSWORD` (выдан при деплое).
В NSG виртуалки должны быть открыты порты 80 и 443.

## Что реализовано на сервере

| Прототип (main.js) | Сервер |
|---|---|
| PLAYER: кошелёк 4 валюты, xp/pvpXp | `GET /api/me` — из `character_currencies` + `characters.exp` |
| LOCATIONS: деревня/каньон/лощина, переходы | `GET /api/locations`, `POST /api/locations/move` (валидация по `location_links`) |
| Список игроков в локации (был заглушкой) | `GET /api/locations/players` — живой, из Redis `loc:{id}:players` |
| «Охота» → BattleSystem | WS: `{type:'hunt'}` → события `turnStart/timer/resolve/battleEnd`; ход `{type:'move',attack,block}`; те же зоны, блок ×0.12, крит ×1.8, крит+блок ×0.85, пропуск по таймауту |
| Награда за победу (+50 меди, +120 опыта) | из `game_config('battle.reward.hunt')`, начисление через `currency_ledger` |
| ITEMS / примерочная | `GET /api/inventory`, `POST equip/unequip` — `item_instances` + `item_ledger`, проверка травм на слот |
| Чат (был заглушкой) | WS `{type:'chat',text}` + `GET /api/chat/history` — Redis pub/sub + `chat_messages` |
| Telegram WebApp | `POST /api/auth/telegram` (подпись initData + replay-защита); `POST /api/auth/dev` для браузера |

Каждый бой оставляет след в БД: `battles`, `battle_participants`
(результат, урон, опыт), `battle_rounds` (каждый удар), снапшот хода — в
Redis `battle:{id}:state`. Победа видна в `currency_ledger`.

## Подключение фронта (arena-game)

1. Скопируй `client-patch/net.js` в `arena-game/js/net/net.js`.
2. В `main.js`:
   - в начале: `import { api, ServerBattle } from './net/net.js';`
     затем `const character = await api.login();` и заполни PLAYER из ответа
     (`wallet`, `xp/xpMax`, `pvpXp/pvpXpMax`, `name`, `level`);
   - в `initBattle()` замени создание боя:
     `battle = await ServerBattle.hunt();` — события и `submitMove`/`finishTurn`
     совпадают с локальным BattleSystem, оркестрация анимаций не меняется
     (награду при `battleEnd` больше не начисляй локально — она в `detail.reward`);
   - кнопки переходов: `await api.move(id)`; список игроков: `api.players()`;
     чат: `api.sendChat(text)` + `api.onChat(...)`, история — `api.chatHistory()`.
3. `start.bat` как раньше поднимает фронт; API на 8080, CORS открыт.

В Telegram Mini App тот же код сам уйдёт в `auth/telegram` — задай `BOT_TOKEN`
в `.env` и пересоздай контейнер api.

## Структура

```
docker-compose.yml          postgres + redis + api (+ профиль full)
initdb/                     схемы трёх БД и сид под контент arena-game
backend/src/
  index.js                  express + ws, CORS, обвязка ошибок
  auth.js                   Telegram initData / dev-вход, сессии
  characters.js             создание и выдача персонажа
  locations.js              переходы + присутствие в Redis
  inventory.js              экипировка через item_ledger
  economy.js                деньги только через currency_ledger + идемпотентность
  chat.js                   чат локации (pub/sub + история в PG)
  battle/engine.js          порт BattleSystem.js (формулы 1:1)
  battle/manager.js         бои в памяти, снапшоты в Redis, итоги в PG
client-patch/net.js         адаптер для фронта (REST + WS + ServerBattle)
scylla/schema.cql           на будущее (профиль full)
```

## Конвенции (важно при доработке)

1. Деньги/предметы меняются только в транзакции со вставкой в ledger.
2. Состояние идущего боя в PG не пишется — память + Redis-снапшот.
3. «Кто в локации» читается только из Redis.
4. Баланс правится в `game_config` (статы старта, награды, таймер хода) —
   без правок кода.

## Итерация v2

Добавлено: задания (создаются в админке, отслеживаются автоматически, награды
через ledger), Эликсир побега (шаблон 201) — единственный способ покинуть бой,
переживание F5/обрыва связи (battleResume), лог смертей в battle_rounds,
загрузка картинок (/uploads, том uploads_data), авто-миграции при старте API,
правка персонажей/предметов/экземпляров и прерывание боя из админки.
Обновление: заменить backend и docker-compose.yml, `docker compose up -d --build api`.
Данные БД сохраняются; миграции применяются сами.
