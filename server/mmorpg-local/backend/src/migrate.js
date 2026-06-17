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
  // Эликсир побега — единственный легальный выход из боя
  `INSERT INTO item_templates (id, name, type, quality, stackable, max_stack, base_stats, icon)
   VALUES (201, 'Эликсир побега', 4, 2, TRUE, 10, '{"escape": true}', 'escapeElixir')
   ON CONFLICT (id) DO NOTHING`,
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
