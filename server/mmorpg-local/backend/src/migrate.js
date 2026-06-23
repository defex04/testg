import { adminPg } from './db.js';

const STATEMENTS = [
  // Квесты: имя, описание, картинка, уровень, активность
  `ALTER TABLE quest_templates ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE quest_templates ADD COLUMN IF NOT EXISTS description TEXT`,
  `ALTER TABLE quest_templates ADD COLUMN IF NOT EXISTS image TEXT`,
  `ALTER TABLE quest_templates ADD COLUMN IF NOT EXISTS level_req SMALLINT NOT NULL DEFAULT 1`,
  `ALTER TABLE quest_templates ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`,
  // Требования к надеванию предметов (уровень, класс, ...)
  `ALTER TABLE item_templates ADD COLUMN IF NOT EXISTS requirements JSONB`,
  // 3D-модель предмета (URL загруженного GLB/FBX или ключ из content.js) —
  // для превью в админке и будущей подгрузки клиентом
  `ALTER TABLE item_templates ADD COLUMN IF NOT EXISTS model TEXT`,
  // Эликсир побега — единственный легальный выход из боя
  `INSERT INTO item_templates (id, name, type, quality, stackable, max_stack, base_stats, icon)
   VALUES (201, 'Эликсир побега', 4, 2, TRUE, 10, '{"escape": true}', 'escapeElixir')
   ON CONFLICT (id) DO NOTHING`,
  // Боевые эликсиры (тип 4) для свежей БД — формат как в сидах: здоровье
  // {heal:N}, мощь {power_mult:M, power_turns:T}. На существующей БД эти id уже
  // есть (DO NOTHING) — сервер берёт параметры эффекта ОТСЮДА (анти-чит).
  `INSERT INTO item_templates (id, name, type, quality, stackable, max_stack, base_stats, icon)
   VALUES (202, 'Эликсир жизни', 4, 2, TRUE, 20, '{"heal": 800}', 'elixirHealth')
   ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO item_templates (id, name, type, quality, stackable, max_stack, base_stats, icon)
   VALUES (203, 'Эликсир ярости', 4, 2, TRUE, 20, '{"power_mult": 1.5, "power_turns": 3}', 'elixirPower')
   ON CONFLICT (id) DO NOTHING`,
  // Пояс эликсиров: сервер ПОМНИТ состав пояса персонажа (slot -> эликсир)
  `CREATE TABLE IF NOT EXISTS character_belt (
     character_id BIGINT   NOT NULL,
     slot         SMALLINT NOT NULL,
     template_id  INT      NOT NULL REFERENCES item_templates(id),
     PRIMARY KEY (character_id, slot)
   )`,
  // Заряды в ячейке: эликсиры мощи копятся стопкой в одном слоте (quantity>1),
  // эликсиры жизни — по 1 на слот (но можно занять несколько слотов). Расход в
  // бою и надевание держат инвариант SUM(quantity по шаблону) ≤ «есть в рюкзаке».
  `ALTER TABLE character_belt ADD COLUMN IF NOT EXISTS quantity SMALLINT NOT NULL DEFAULT 1`,
  // таблица создана админ-ролью в рантайме → выдаём права игровой роли явно
  // (схемный GRANT ON ALL TABLES к новым таблицам не применяется). Пояс —
  // изменяемый конфиг, а не аудит, поэтому DELETE здесь уместен (очистка ячейки).
  `GRANT SELECT, INSERT, UPDATE, DELETE ON character_belt TO game_rw`,
  `GRANT SELECT ON item_templates TO game_rw`,
  `GRANT UPDATE (id) ON item_templates TO game_rw`,
  `GRANT SELECT, INSERT, UPDATE ON item_instances TO game_rw`,
  `GRANT INSERT ON item_ledger, item_ledger_default TO game_rw`,
  `GRANT USAGE, SELECT ON SEQUENCE item_ledger_id_seq TO game_rw`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO game_rw`,
  `INSERT INTO game_config (key, value) VALUES ('battle.escape_elixir', '201')
   ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value)
   VALUES ('battle.intervention.default', '{"hunt": false, "pvp": true}')
   ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value)
   VALUES ('character.leveling',
           '{"maxLevel": 15, "thresholds": [0, 200, 500, 1000, 1800, 3200, 5500, 9000, 14000, 21000, 31000, 45000, 64000, 90000, 125000]}')
   ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value)
   VALUES ('battle.reward.hunt', '{"currency": "copper", "amount": 50, "exp": 25}')
   ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value)
   VALUES ('character.start', '{"level": 1, "hp": 2330, "damage": [160, 240],
                                "crit": 0.14, "dodge": 0.07, "height": 1.85,
                                "xp_max": 200, "pvp_xp_max": 1000}')
   ON CONFLICT (key) DO NOTHING`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM game_config WHERE key = 'migration.level_system_v1_reset_done') THEN
       UPDATE game_config SET value = value || '{"exp": 25}'::jsonb,
              version = version + 1, updated_at = now()
        WHERE key = 'battle.reward.hunt';
       UPDATE game_config SET value = value || '{"level": 1, "xp_max": 200}'::jsonb,
              version = version + 1, updated_at = now()
        WHERE key = 'character.start';
       UPDATE game_config SET value =
              '{"maxLevel": 15, "thresholds": [0, 200, 500, 1000, 1800, 3200, 5500, 9000, 14000, 21000, 31000, 45000, 64000, 90000, 125000]}'::jsonb,
              version = version + 1, updated_at = now()
        WHERE key = 'character.leveling';
       UPDATE npc_templates SET level = 1 WHERE id = 1;
       UPDATE characters SET level = 1, exp = 0;
       INSERT INTO game_config (key, value)
       VALUES ('migration.level_system_v1_reset_done', 'true'::jsonb);
     END IF;
   END $$`,
  // Бронзовый доспех из сида был без статов — дозаполняем один раз
  // (если админ уже задал свои base_stats, не трогаем)
  `UPDATE item_templates
      SET base_stats = '{"hp": 250, "dodge": 0.01}'::jsonb, version = version + 1
    WHERE id = 101 AND (base_stats IS NULL OR base_stats = '{}'::jsonb)`,
  // Мир из content.js: Город Надежды (1) ↔ Поселение Зеленое (2); локация 3 убрана
  `UPDATE locations SET name = 'Город Надежды', type = 1 WHERE id = 1`,
  `UPDATE locations SET name = 'Поселение Зеленое', type = 1 WHERE id = 2`,
  `UPDATE characters SET location_id = 1 WHERE location_id = 3`,
  `UPDATE battles SET location_id = 1 WHERE location_id = 3`,
  `DELETE FROM npc_spawns WHERE location_id = 3`,
  `DELETE FROM location_links WHERE from_id = 3 OR to_id = 3`,
  `DELETE FROM locations WHERE id = 3`,
  `INSERT INTO location_links (from_id, to_id) VALUES (1, 2), (2, 1)
   ON CONFLICT (from_id, to_id) DO NOTHING`,
  `UPDATE npc_templates
      SET stats = coalesce(stats, '{}'::jsonb)
        || '{"hp": 1100, "aiHealUses": 1, "aiPowerUses": 1,
             "aiHealAmount": 800, "aiHealAt": 0.6,
             "aiPowerMult": 1.5, "aiPowerTurns": 3}'::jsonb
    WHERE id = 1`,
  // --- Почта -----------------------------------------------------------
  // Номинальная стоимость предмета (медь). От неё считается налог за вложение
  // в письмо (10%). 0 = бесценок (налог за вложение не берётся).
  `ALTER TABLE item_templates ADD COLUMN IF NOT EXISTS price BIGINT NOT NULL DEFAULT 0`,
  // Стартовые цены для предметов сидов (только пока админ не задал своих — price=0).
  `UPDATE item_templates SET price = 1000 WHERE id = 101 AND price = 0`,  // бронзовый доспех
  `UPDATE item_templates SET price = 300  WHERE id = 201 AND price = 0`,  // эликсир побега
  `UPDATE item_templates SET price = 200  WHERE id = 202 AND price = 0`,  // эликсир жизни
  `UPDATE item_templates SET price = 250  WHERE id = 203 AND price = 0`,  // эликсир ярости
  // Тарифы почты: фикс за письмо + доля от стоимости каждого вложенного предмета.
  `INSERT INTO game_config (key, value) VALUES ('mail.tax_send', '100')
   ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('mail.tax_item_pct', '0.1')
   ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('mail.max_attachments', '8')
   ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('mail.expire_days', '30')
   ON CONFLICT (key) DO NOTHING`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS deleted_by_sender BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS deleted_by_recipient BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE INDEX IF NOT EXISTS ix_mail_sender ON mail_messages (sender_id, created_at)
     WHERE deleted_by_sender = FALSE`,
  // --- Приватный чат (личка) ------------------------------------------
  // Канал лички на пару игроков: chat_channels(type=6) хранит сообщения,
  // dm_pairs стабильно отображает упорядоченную пару (lo,hi) -> channel_id.
  `CREATE TABLE IF NOT EXISTS dm_pairs (
     lo         BIGINT NOT NULL,
     hi         BIGINT NOT NULL,
     channel_id BIGINT NOT NULL,
     PRIMARY KEY (lo, hi)
   )`,
  `GRANT SELECT, INSERT ON dm_pairs TO game_rw`,
  // Адресат личного сообщения в общем чате — чтобы стрелка «→ Ник» пережила релог
  `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS target_name TEXT`,
];

// ---------------------------------------------------------------------------
// Боевые расходники: 7 категорий × 5 уровней качества (серый→зелёный→синий→
// фиолетовый→оранжевый). Цвет фона рисует клиент по quality; доступ — level_req
// (1/3/5/10/15); параметры эффекта лежат в base_stats — единый источник правды
// (сервер их валидирует, анти-чит). Стопка в рюкзаке без лимита (max_stack 999),
// вместимость ячейки пояса — belt_max. Новые шаблоны вставляются идемпотентно
// (ON CONFLICT DO NOTHING — админ-правки не затираются); существующие 201/202/203
// конвертируются ОДИН раз под флагом migration.consumables_v1_done.
// ---------------------------------------------------------------------------
const Q_LEVEL = [1, 3, 5, 10, 15];           // level_req по уровню качества 1..5
const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const consumables = [];
const pushTier = (ids, icon, rows, mkStats) =>
  rows.forEach((row, i) => consumables.push({
    id: ids[i], name: row[0], quality: i + 1, level: Q_LEVEL[i],
    price: row[row.length - 1], icon, stats: mkStats(row, i) }));

// 🧪 Эликсир жизни — HoT %maxHP за секунды (на себя/союзника). id 202(T1),211..214
pushTier([202, 211, 212, 213, 214], 'elixHealth', [
  ['Малый эликсир жизни', 0.20, 60, 3, 150],
  ['Лёгкий эликсир жизни', 0.25, 55, 3, 250],
  ['Эликсир жизни', 0.35, 40, 2, 450],
  ['Большой эликсир жизни', 0.45, 35, 2, 800],
  ['Великий эликсир жизни', 0.55, 30, 1, 1300],
], (r) => ({ kind: 'health', heal_pct: r[1], secs: r[2], belt_max: r[3] }));

// ⚗️ Эликсир мощи — +урон% на N ходов (на себя). id 203(T1),221..224
pushTier([203, 221, 222, 223, 224], 'elixPower', [
  ['Эликсир мощи: проблеск', 1.25, 1, 5, 120],
  ['Эликсир мощи', 1.30, 1, 6, 200],
  ['Эликсир мощи: прилив', 1.35, 1, 7, 360],
  ['Эликсир ярости', 1.45, 2, 10, 650],
  ['Эликсир неистовства', 1.50, 3, 11, 1100],
], (r) => ({ power_mult: r[1], power_turns: r[2], belt_max: r[3] }));

// 🔮 Эликсир маны — восстановление MP% за секунды (на себя/союзника). id 230..234
pushTier([230, 231, 232, 233, 234], 'elixMana', [
  ['Малый эликсир маны', 0.20, 60, 3, 120],
  ['Лёгкий эликсир маны', 0.25, 55, 3, 200],
  ['Эликсир маны', 0.35, 40, 2, 360],
  ['Большой эликсир маны', 0.45, 35, 2, 650],
  ['Великий эликсир маны', 0.55, 30, 1, 1100],
], (r) => ({ kind: 'mana', mana_pct: r[1], secs: r[2], belt_max: r[3] }));

// 🩸 Эликсир крови — +шанс крита (проц. пункты) на 1 ход (на себя). id 240..244
pushTier([240, 241, 242, 243, 244], 'elixBlood', [
  ['Малый эликсир крови', 0.20, 3, 140],
  ['Лёгкий эликсир крови', 0.25, 4, 240],
  ['Эликсир крови', 0.30, 6, 430],
  ['Большой эликсир крови', 0.35, 7, 780],
  ['Великий эликсир крови', 0.40, 9, 1250],
], (r) => ({ kind: 'blood', crit_add: r[1], turns: 1, belt_max: r[2] }));

// ☠️ Свиток отравления — DoT %maxHP цели за секунды (на врага), с тайм-аутом. id 250..254
pushTier([250, 251, 252, 253, 254], 'scrollPoison', [
  ['Слабый свиток отравления', 0.15, 120, 150, 1, 180],
  ['Свиток отравления', 0.20, 110, 140, 1, 300],
  ['Крепкий свиток отравления', 0.25, 100, 130, 1, 520],
  ['Свиток едкого яда', 0.30, 90, 120, 1, 900],
  ['Свиток смертельного яда', 0.30, 90, 110, 3, 1500],
], (r) => ({ scroll: 'poison', dmg_pct: r[1], secs: r[2], cooldown: r[3], belt_max: r[4] }));

// ✚ Свиток исцеления — HoT %maxHP цели за секунды (на себя/союзника), с тайм-аутом. id 260..264
pushTier([260, 261, 262, 263, 264], 'scrollHeal', [
  ['Малый свиток исцеления', 0.15, 120, 150, 1, 180],
  ['Свиток исцеления', 0.20, 110, 140, 1, 300],
  ['Большой свиток исцеления', 0.25, 100, 130, 1, 520],
  ['Великий свиток исцеления', 0.30, 90, 120, 1, 900],
  ['Священный свиток исцеления', 0.30, 90, 110, 3, 1500],
], (r) => ({ scroll: 'heal', heal_pct: r[1], secs: r[2], cooldown: r[3], belt_max: r[4] }));

// 🌀 Свиток очищения — снимает отравление И исцеление с цели (любой), с тайм-аутом. id 270..274
pushTier([270, 271, 272, 273, 274], 'scrollCleanse', [
  ['Малый свиток очищения', 90, 1, 200],
  ['Свиток очищения', 80, 1, 330],
  ['Большой свиток очищения', 70, 2, 560],
  ['Великий свиток очищения', 60, 2, 950],
  ['Совершенный свиток очищения', 50, 3, 1600],
], (r) => ({ scroll: 'cleanse', removes: ['poison', 'heal_scroll'], cooldown: r[1], belt_max: r[2] }));

for (const c of consumables) {
  STATEMENTS.push(
    `INSERT INTO item_templates (id, name, type, quality, stackable, max_stack,
        base_stats, icon, price, sellable, level_req)
     VALUES (${c.id}, ${sq(c.name)}, 4, ${c.quality}, TRUE, 999,
        ${sq(JSON.stringify(c.stats))}::jsonb, ${sq(c.icon)}, ${c.price}, TRUE, ${c.level})
     ON CONFLICT (id) DO NOTHING`);
}

// Рюкзак не ограничивает стопку расходников (ТЗ: «максимум эликсиров неограничено») —
// поднимаем max_stack у всех боевых расходников. Идемпотентно (гоняется каждую миграцию).
STATEMENTS.push(
  `UPDATE item_templates SET max_stack = 1000000
    WHERE type = 4 AND (max_stack IS NULL OR max_stack < 1000000)`);

// Разовая конвертация старых шаблонов в «серый» уровень новой системы: 202 → жизнь T1
// (формат менялся с {heal:N} на %+время), 203 → мощь T1, 201 → побег (продаётся, ур.1).
STATEMENTS.push(
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM game_config WHERE key = 'migration.consumables_v1_done') THEN
       UPDATE item_templates SET name = 'Малый эликсир жизни', quality = 1, level_req = 1,
          max_stack = 999, sellable = TRUE, price = 150,
          base_stats = '{"kind":"health","heal_pct":0.2,"secs":60,"belt_max":3}'::jsonb,
          version = version + 1 WHERE id = 202;
       UPDATE item_templates SET name = 'Эликсир мощи: проблеск', quality = 1, level_req = 1,
          max_stack = 999, sellable = TRUE, price = 120,
          base_stats = '{"power_mult":1.25,"power_turns":1,"belt_max":5}'::jsonb,
          version = version + 1 WHERE id = 203;
       UPDATE item_templates SET level_req = 1, sellable = TRUE, price = 300, quality = 1,
          max_stack = 999, version = version + 1 WHERE id = 201;
       INSERT INTO game_config (key, value)
          VALUES ('migration.consumables_v1_done', 'true'::jsonb);
     END IF;
   END $$`);

export async function runMigrations() {
  for (const sql of STATEMENTS) await adminPg().query(sql);
  console.log('Миграции применены:', STATEMENTS.length);
}
