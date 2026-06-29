import { adminPg } from './db.js';
import {
  gearItemStats, QUALITY_BY_RANK,
  GEAR_CLASSES, GEAR_COLORS, GEAR_LEVELS, GEAR_PIECES,
} from './battle/gear.js';

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
  // Боевая модель «треугольник» (Broken Sun): включает в ЖИВОМ бою школьные статы +
  // нормировку + «крит пробивает блок». Выкл одной правкой value→{"enabled":false}.
  `INSERT INTO game_config (key, value) VALUES ('battle.model', '{"enabled": true}')
   ON CONFLICT (key) DO NOTHING`,
  // Очки распределения атрибутов (10/уровень) задают школу треугольника. Бэкфилл
  // существующим персонажам ОДИН раз: положенное за уровень минус уже вложенное.
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM game_config WHERE key = 'migration.alloc_points_v1_done') THEN
       UPDATE character_stats cs
          SET free_points = GREATEST(cs.free_points,
                c.level * 10 - (cs.str + cs.agi + cs.vit + cs.intel + cs.wis))
         FROM characters c WHERE c.id = cs.character_id;
       INSERT INTO game_config (key, value)
          VALUES ('migration.alloc_points_v1_done', 'true'::jsonb);
     END IF;
   END $$`,
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
   VALUES ('character.start', '{"level": 1, "hp": 200, "damage": [14, 22],
                                "crit": 0.14, "dodge": 0.07, "height": 1.85,
                                "xp_max": 200, "pvp_xp_max": 1000}')
   ON CONFLICT (key) DO NOTHING`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM game_config WHERE key = 'migration.low_hp_damage_v1_done') THEN
       UPDATE game_config SET value = value || '{"hp": 200, "damage": [14, 22]}'::jsonb,
              version = version + 1, updated_at = now()
        WHERE key = 'character.start';
       UPDATE characters SET hp_cur = 200 WHERE level <= 1 AND hp_cur > 200;
       INSERT INTO game_config (key, value)
       VALUES ('migration.low_hp_damage_v1_done', 'true'::jsonb);
     END IF;
   END $$`,
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
  // Бронзовый доспех (id 101) убран из игры — уже выданные экземпляры мягко
  // удаляем у владельцев (status=2, как расход). Снятие с продажи/цены — ниже,
  // после добавления колонки price. Идемпотентно: повтор ничего не меняет.
  `UPDATE item_instances SET status = 2, deleted_at = now(), version = version + 1
    WHERE template_id = 101 AND status = 1`,
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
        || '{"hp": 180, "damage": [13, 19], "crit": 0.07, "dodge": 0.04,
             "school": "natisk", "modelHpMult": 1.02, "modelPowerMult": 0.80,
             "aiHealUses": 0, "aiPowerUses": 0,
             "aiHealAmount": 45, "aiHealAt": 0.45,
             "aiPowerMult": 1.15, "aiPowerTurns": 1}'::jsonb
    WHERE id = 1`,
  // «Шайка разбойников» (id 2) — групповая охота: 3 бойца по 900 HP с ролями
  // (отравитель/лекарь/громила, читаются в manager.applyAiElixirs по ai*-полям).
  // Награда переопределяет общую: опыт 70, медь 125 (×2.5 от обычного разбойника).
  `INSERT INTO npc_templates (id, name, level, stats, props) VALUES
     (2, 'Шайка разбойников', 1,
      '{"pack":[
         {"name":"Разбойник-отравитель","school":"uklon","level":1,"hp":90,"damage":[6,10],"crit":0.07,"dodge":0.05,"modelHpMult":0.48,"modelPowerMult":0.48,"aiPoisonUses":2,"aiPoisonPct":0.035,"aiPoisonSecs":15,"aiPoisonEvery":5},
         {"name":"Разбойник-лекарь","school":"oplot","level":1,"hp":105,"damage":[5,9],"crit":0.05,"dodge":0.03,"modelHpMult":0.48,"modelPowerMult":0.43,"aiHealAllyUses":1,"aiHealAmount":40,"aiHealAt":0.55},
         {"name":"Разбойник-громила","school":"natisk","level":1,"hp":120,"damage":[8,13],"crit":0.08,"dodge":0.03,"modelHpMult":0.52,"modelPowerMult":0.52,"aiPowerUses":1,"aiPowerMult":1.18,"aiPowerTurns":1}
       ],"reward":{"currency":"copper","amount":125,"exp":70}}'::jsonb,
      '{"injury_chance":0}'::jsonb)
   ON CONFLICT (id) DO NOTHING`,
  `INSERT INTO npc_spawns (id, npc_template_id, location_id) VALUES (3, 2, 1), (4, 2, 2)
   ON CONFLICT (id) DO NOTHING`,
  // Школы треугольника для NPC (модельный бой): одиночка → Натиск; шайка —
  // отравитель→Уклон (вёрткий), лекарь→Оплот (стойкий), громила→Натиск (бугай).
  // Один раз (флаг), чтобы не затирать админ-правки. withNpcModel читает member.school.
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM game_config WHERE key = 'migration.npc_schools_v1_done') THEN
       UPDATE npc_templates SET stats = coalesce(stats, '{}'::jsonb)
         || '{"school":"natisk","modelHpMult":1.02,"modelPowerMult":0.80}'::jsonb WHERE id = 1;
       UPDATE npc_templates SET stats = jsonb_set(stats, '{pack}', '[
         {"name":"Разбойник-отравитель","school":"uklon","level":1,"hp":90,"damage":[6,10],"crit":0.07,"dodge":0.05,"modelHpMult":0.48,"modelPowerMult":0.48,"aiPoisonUses":2,"aiPoisonPct":0.035,"aiPoisonSecs":15,"aiPoisonEvery":5},
         {"name":"Разбойник-лекарь","school":"oplot","level":1,"hp":105,"damage":[5,9],"crit":0.05,"dodge":0.03,"modelHpMult":0.48,"modelPowerMult":0.43,"aiHealAllyUses":1,"aiHealAmount":40,"aiHealAt":0.55},
         {"name":"Разбойник-громила","school":"natisk","level":1,"hp":120,"damage":[8,13],"crit":0.08,"dodge":0.03,"modelHpMult":0.52,"modelPowerMult":0.52,"aiPowerUses":1,"aiPowerMult":1.18,"aiPowerTurns":1}
       ]'::jsonb) WHERE id = 2 AND stats ? 'pack';
       INSERT INTO game_config (key, value) VALUES ('migration.npc_schools_v1_done', 'true'::jsonb);
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM game_config WHERE key = 'migration.hunt_npc_low_level_v1_done') THEN
       UPDATE npc_templates SET level = 1,
          stats = coalesce(stats, '{}'::jsonb)
            || '{"hp":180,"damage":[13,19],"crit":0.07,"dodge":0.04,
                 "school":"natisk","modelHpMult":1.02,"modelPowerMult":0.80,
                 "aiHealUses":0,"aiPowerUses":0,
                 "aiHealAmount":45,"aiHealAt":0.45,
                 "aiPowerMult":1.15,"aiPowerTurns":1}'::jsonb
        WHERE id = 1;
       UPDATE npc_templates SET level = 1,
          stats = coalesce(stats, '{}'::jsonb) || '{"pack":[
            {"name":"Разбойник-отравитель","school":"uklon","level":1,"hp":90,"damage":[6,10],"crit":0.07,"dodge":0.05,"modelHpMult":0.48,"modelPowerMult":0.48,"aiPoisonUses":2,"aiPoisonPct":0.035,"aiPoisonSecs":15,"aiPoisonEvery":5},
            {"name":"Разбойник-лекарь","school":"oplot","level":1,"hp":105,"damage":[5,9],"crit":0.05,"dodge":0.03,"modelHpMult":0.48,"modelPowerMult":0.43,"aiHealAllyUses":1,"aiHealAmount":40,"aiHealAt":0.55},
            {"name":"Разбойник-громила","school":"natisk","level":1,"hp":120,"damage":[8,13],"crit":0.08,"dodge":0.03,"modelHpMult":0.52,"modelPowerMult":0.52,"aiPowerUses":1,"aiPowerMult":1.18,"aiPowerTurns":1}
          ]}'::jsonb
        WHERE id = 2;
       INSERT INTO game_config (key, value)
          VALUES ('migration.hunt_npc_low_level_v1_done', 'true'::jsonb);
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM game_config WHERE key = 'migration.hunt_npc_bandit_tune_v2_done') THEN
       UPDATE npc_templates SET level = 1,
          stats = coalesce(stats, '{}'::jsonb)
            || '{"hp":180,"damage":[13,19],"crit":0.07,"dodge":0.04,
                 "school":"natisk","modelHpMult":1.02,"modelPowerMult":0.80,
                 "aiHealUses":0,"aiPowerUses":0,
                 "aiHealAmount":45,"aiHealAt":0.45,
                 "aiPowerMult":1.15,"aiPowerTurns":1}'::jsonb
        WHERE id = 1;
       UPDATE npc_templates SET level = 1,
          stats = coalesce(stats, '{}'::jsonb) || '{"pack":[
            {"name":"Разбойник-отравитель","school":"uklon","level":1,"hp":90,"damage":[6,10],"crit":0.07,"dodge":0.05,"modelHpMult":0.48,"modelPowerMult":0.48,"aiPoisonUses":2,"aiPoisonPct":0.035,"aiPoisonSecs":15,"aiPoisonEvery":5},
            {"name":"Разбойник-лекарь","school":"oplot","level":1,"hp":105,"damage":[5,9],"crit":0.05,"dodge":0.03,"modelHpMult":0.48,"modelPowerMult":0.43,"aiHealAllyUses":1,"aiHealAmount":40,"aiHealAt":0.55},
            {"name":"Разбойник-громила","school":"natisk","level":1,"hp":120,"damage":[8,13],"crit":0.08,"dodge":0.03,"modelHpMult":0.52,"modelPowerMult":0.52,"aiPowerUses":1,"aiPowerMult":1.18,"aiPowerTurns":1}
          ]}'::jsonb
        WHERE id = 2;
       INSERT INTO game_config (key, value)
          VALUES ('migration.hunt_npc_bandit_tune_v2_done', 'true'::jsonb);
     END IF;
   END $$`,
  // --- Почта -----------------------------------------------------------
  // Номинальная стоимость предмета (медь). От неё считается налог за вложение
  // в письмо (10%). 0 = бесценок (налог за вложение не берётся).
  `ALTER TABLE item_templates ADD COLUMN IF NOT EXISTS price BIGINT NOT NULL DEFAULT 0`,
  // Бронзовый доспех (id 101) убран из игры: снимаем с продажи и гасим цену
  // (исчезает из магазина). Колонка price уже добавлена выше. Идемпотентно.
  `UPDATE item_templates SET sellable = FALSE, price = 0, version = version + 1
    WHERE id = 101 AND (sellable = TRUE OR price <> 0)`,
  // Стартовые цены для предметов сидов (только пока админ не задал своих — price=0).
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

// 🧪 Эликсир жизни — HoT %maxHP равными порциями каждые 5 c, пока идёт secs
// (на себя/союзника). Длительности battle-relevant и кратны тику (ТЗ #3,#5).
// id 202(T1),211..214
pushTier([202, 211, 212, 213, 214], 'elixHealth', [
  ['Малый эликсир жизни', 0.20, 20, 3, 150],
  ['Лёгкий эликсир жизни', 0.25, 20, 3, 250],
  ['Эликсир жизни', 0.35, 25, 2, 450],
  ['Большой эликсир жизни', 0.45, 25, 2, 800],
  ['Великий эликсир жизни', 0.55, 30, 1, 1300],
], (r) => ({ kind: 'health', heal_pct: r[1], secs: r[2], tick: 5, belt_max: r[3] }));

// ⚗️ Эликсир мощи — +урон% на N ходов (на себя). id 203(T1),221..224
pushTier([203, 221, 222, 223, 224], 'elixPower', [
  ['Эликсир мощи: проблеск', 1.25, 1, 5, 120],
  ['Эликсир мощи', 1.30, 1, 6, 200],
  ['Эликсир мощи: прилив', 1.35, 1, 7, 360],
  ['Эликсир ярости', 1.45, 2, 10, 650],
  ['Эликсир неистовства', 1.50, 3, 11, 1100],
], (r) => ({ power_mult: r[1], power_turns: r[2], belt_max: r[3] }));

// 🔮 Эликсир маны — восстановление MP% равными порциями каждые 5 c (на себя/союзника).
// id 230..234
pushTier([230, 231, 232, 233, 234], 'elixMana', [
  ['Малый эликсир маны', 0.20, 20, 3, 120],
  ['Лёгкий эликсир маны', 0.25, 20, 3, 200],
  ['Эликсир маны', 0.35, 25, 2, 360],
  ['Большой эликсир маны', 0.45, 25, 2, 650],
  ['Великий эликсир маны', 0.55, 30, 1, 1100],
], (r) => ({ kind: 'mana', mana_pct: r[1], secs: r[2], tick: 5, belt_max: r[3] }));

// 🩸 Эликсир крови — +шанс крита (проц. пункты) на 1 ход (на себя). id 240..244
pushTier([240, 241, 242, 243, 244], 'elixBlood', [
  ['Малый эликсир крови', 0.20, 3, 140],
  ['Лёгкий эликсир крови', 0.25, 4, 240],
  ['Эликсир крови', 0.30, 6, 430],
  ['Большой эликсир крови', 0.35, 7, 780],
  ['Великий эликсир крови', 0.40, 9, 1250],
], (r) => ({ kind: 'blood', crit_add: r[1], turns: 1, belt_max: r[2] }));

// ☠️ Свиток отравления — DoT %maxHP цели равными порциями каждые 5 c (на врага),
// с тайм-аутом (cooldown > длительности — без вечного аптайма). id 250..254
pushTier([250, 251, 252, 253, 254], 'scrollPoison', [
  ['Слабый свиток отравления', 0.15, 20, 30, 1, 180],
  ['Свиток отравления', 0.20, 20, 30, 1, 300],
  ['Крепкий свиток отравления', 0.25, 25, 35, 1, 520],
  ['Свиток едкого яда', 0.30, 25, 35, 1, 900],
  ['Свиток смертельного яда', 0.36, 30, 40, 3, 1500],
], (r) => ({ scroll: 'poison', dmg_pct: r[1], secs: r[2], cooldown: r[3], tick: 5, belt_max: r[4] }));

// ✚ Свиток исцеления — HoT %maxHP цели равными порциями каждые 5 c (на себя/союзника),
// с тайм-аутом. id 260..264
pushTier([260, 261, 262, 263, 264], 'scrollHeal', [
  ['Малый свиток исцеления', 0.15, 20, 30, 1, 180],
  ['Свиток исцеления', 0.20, 20, 30, 1, 300],
  ['Большой свиток исцеления', 0.25, 25, 35, 1, 520],
  ['Великий свиток исцеления', 0.30, 25, 35, 1, 900],
  ['Священный свиток исцеления', 0.36, 30, 40, 3, 1500],
], (r) => ({ scroll: 'heal', heal_pct: r[1], secs: r[2], cooldown: r[3], tick: 5, belt_max: r[4] }));

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

// ---------------------------------------------------------------------------
// Экипировка под треугольник: 3 класса × уровни 1–15 × 10 слотов × 5 цветов
// (серый…оранжевый = quality 1..5). В живом бою base_stats — реальный вклад вещи:
// общий скелет (health/power) + школьные статы cls. id 300..2549.
// ---------------------------------------------------------------------------
// id 300..449 оставлены за вещами 1 уровня (совместимость старого диапазона).
let gearId = 300;
for (const lvl of GEAR_LEVELS) {
  for (const [cls, clsName] of GEAR_CLASSES) {
    for (const [piece, slot, type] of GEAR_PIECES) {
      for (let q = 1; q <= 5; q++) {
        const id = gearId++;
        const name = `${piece} «${clsName}» ур. ${lvl} · ${GEAR_COLORS[q - 1]}`;
        const stats = { cls, ...gearItemStats(slot, { cls, level: lvl, quality: QUALITY_BY_RANK[q - 1] }) };
        STATEMENTS.push(
          `INSERT INTO item_templates (id, name, type, slot, quality, level_req, base_stats, icon, price, sellable, stackable)
           VALUES (${id}, ${sq(name)}, ${type}, ${slot}, ${q}, ${lvl},
             ${sq(JSON.stringify(stats))}::jsonb, ${sq('gear' + piece)}, ${50 * q * lvl}, TRUE, FALSE)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type,
             slot = EXCLUDED.slot, quality = EXCLUDED.quality, level_req = EXCLUDED.level_req,
             base_stats = EXCLUDED.base_stats, icon = EXCLUDED.icon, price = EXCLUDED.price,
             sellable = EXCLUDED.sellable, version = item_templates.version + 1`);
      }
    }
  }
}

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

// Ребаланс v2 (ТЗ #5): дискретные тики + battle-relevant длительности. INSERT выше
// (DO NOTHING) не трогает существующие строки, а v1 мог вернуть 202/203 к старым
// значениям — поэтому ПОСЛЕ v1 один раз ФОРСИРОВАННО приводим base_stats/имя/цену/
// уровень к новым значениям по тем же consumables, что и сид (guard — флаг v2,
// чтобы не затирать последующие админ-правки).
const v2updates = consumables.map((c) =>
  `UPDATE item_templates SET base_stats = ${sq(JSON.stringify(c.stats))}::jsonb,
      name = ${sq(c.name)}, price = ${c.price}, level_req = ${c.level},
      quality = ${c.quality}, version = version + 1 WHERE id = ${c.id};`).join('\n       ');
STATEMENTS.push(
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM game_config WHERE key = 'migration.consumables_v2_done') THEN
       ${v2updates}
       INSERT INTO game_config (key, value)
          VALUES ('migration.consumables_v2_done', 'true'::jsonb);
     END IF;
   END $$`);

// ---------------------------------------------------------------------------
// Аукцион и биржа. Таблицы заведены ещё в initdb (30_game_schema.sql); здесь —
// идемпотентные добавки: флаги лота, денормализация template_id, тарифы в
// game_config, инструменты биржи и явные GRANT'ы (на случай рантайм-создания).
// ---------------------------------------------------------------------------
STATEMENTS.push(
  `ALTER TABLE auction_lots ADD COLUMN IF NOT EXISTS template_id INT`,
  `ALTER TABLE auction_lots ADD COLUMN IF NOT EXISTS anonymous  BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE auction_lots ADD COLUMN IF NOT EXISTS featured   BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE auction_lots ADD COLUMN IF NOT EXISTS auto_extend BOOLEAN NOT NULL DEFAULT FALSE`,
  // старым лотам (если есть) проставим template_id из их экземпляра
  `UPDATE auction_lots l SET template_id = i.template_id
     FROM item_instances i WHERE l.item_instance_id = i.id AND l.template_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_lots_template ON auction_lots (template_id) WHERE status = 1`,
  // Тарифы аукциона (медь): сбор за выставление = listing_fee_pct × стартовой,
  // налог с продажи = sale_tax_pct × финальной. max_lots — лимит активных лотов.
  `INSERT INTO game_config (key, value) VALUES ('auction.listing_fee_pct', '0.05') ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('auction.sale_tax_pct', '0.15') ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('auction.max_lots', '3') ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('auction.min_bid_increment_pct', '0.05') ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('auction.featured_fee', '500') ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('auction.anti_snipe_min', '5') ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('auction.durations', '[2, 6, 12, 24, 48]') ON CONFLICT (key) DO NOTHING`,
  // Биржа = доска заявок на покупку: у заявки есть срок, товар к ней приходит
  // частями. exchange_orders.ends_at — срок; sell_order_id у заявочной модели
  // нет (продажа идёт «в заявку»), снимаем NOT NULL.
  `ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ`,
  `ALTER TABLE exchange_trades ALTER COLUMN sell_order_id DROP NOT NULL`,
  `INSERT INTO game_config (key, value) VALUES ('exchange.max_orders', '10') ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value) VALUES ('exchange.durations', '[6, 12, 24, 48]') ON CONFLICT (key) DO NOTHING`,
  // Инструменты биржи — расходники-«ресурсы» (зависят от шаблонов, добавленных
  // выше в этом же прогоне). item_template_id ссылается на item_templates.
  `INSERT INTO exchange_instruments (instrument_id, item_template_id, tick_size, lot_size, active)
   VALUES (1,202,1,1,TRUE),(2,203,1,1,TRUE),(3,230,1,1,TRUE),(4,240,1,1,TRUE),
          (5,250,1,1,TRUE),(6,260,1,1,TRUE),(7,270,1,1,TRUE),(8,201,1,1,TRUE)
   ON CONFLICT (instrument_id) DO NOTHING`,
  // Права игровой роли на таблицы рынка (без DELETE — закрытие через status).
  `GRANT SELECT, INSERT, UPDATE ON auction_lots, auction_bids, auction_price_history TO game_rw`,
  `GRANT SELECT, INSERT, UPDATE ON exchange_instruments, exchange_orders, exchange_trades, exchange_candles TO game_rw`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO game_rw`,
);

export async function runMigrations() {
  for (const sql of STATEMENTS) await adminPg().query(sql);
  console.log('Миграции применены:', STATEMENTS.length);
}
