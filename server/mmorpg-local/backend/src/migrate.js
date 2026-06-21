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
  `INSERT INTO game_config (key, value) VALUES ('battle.escape_elixir', '201')
   ON CONFLICT (key) DO NOTHING`,
  `INSERT INTO game_config (key, value)
   VALUES ('battle.intervention.default', '{"hunt": false, "pvp": true}')
   ON CONFLICT (key) DO NOTHING`,
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
];

export async function runMigrations() {
  for (const sql of STATEMENTS) await adminPg().query(sql);
  console.log('Миграции применены:', STATEMENTS.length);
}
