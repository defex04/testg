-- ============================================================
-- Сид под контент проекта arena-game (FIGHTERS/LOCATIONS/ITEMS из main.js)
-- ============================================================
INSERT INTO currencies (id, code, name) VALUES
    (1, 'copper',  'Медь'),
    (2, 'silver',  'Серебро'),
    (3, 'gold',    'Золото'),
    (4, 'diamond', 'Бриллианты'),
    (5, 'valor',   'Доблесть');

INSERT INTO locations (id, name, type, min_level) VALUES
    (1, 'Деревня',        1, 1),
    (2, 'Каньон',         2, 1),
    (3, 'Ночная лощина',  2, 1);

INSERT INTO location_links (from_id, to_id) VALUES
    (1, 2), (2, 1),          -- деревня <-> каньон («Пройти к мосту»)
    (2, 3), (3, 2);          -- каньон <-> лощина

-- Экипировка из ITEMS: бронзовый доспех, слот 1 = torso
INSERT INTO item_templates (id, name, type, slot, quality, stackable, base_stats, icon)
VALUES (101, 'Бронзовый доспех', 2, 1, 2, FALSE, '{"hp": 250, "dodge": 0.01}', 'bronzeArmor');

-- NPC «Разбойник» для «Охоты»: статы brawlerElite из main.js
INSERT INTO npc_templates (id, name, level, stats, props) VALUES
    (1, 'Разбойник', 15,
     '{"hp": 2600, "damage": [140, 220], "crit": 0.1, "dodge": 0.05, "height": 1.92}',
     '{"injury_chance": 0}');
INSERT INTO npc_spawns (id, npc_template_id, location_id) VALUES
    (1, 1, 1), (2, 1, 2), (3, 1, 3);   -- охота доступна во всех трёх локациях

INSERT INTO game_config (key, value) VALUES
    ('battle.turn_time',     '20'),
    ('battle.reward.hunt',   '{"currency": "copper", "amount": 50, "exp": 120}'),
    ('character.start',      '{"level": 15, "hp": 2330, "damage": [160, 240],
                               "crit": 0.14, "dodge": 0.07, "height": 1.85,
                               "xp_max": 2000, "pvp_xp_max": 1000}'),
    ('chat.history_limit',   '50');

INSERT INTO name_blacklist (name) VALUES
    ('admin'), ('administrator'), ('moderator'), ('system'), ('gm');

INSERT INTO seasons (id, category, starts_at, ends_at) VALUES
    (1, 3, now(), now() + interval '90 days');
