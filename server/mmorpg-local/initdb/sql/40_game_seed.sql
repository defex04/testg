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
    (1, 'Город Надежды',     1, 1),
    (2, 'Поселение Зеленое', 1, 1);

INSERT INTO location_links (from_id, to_id) VALUES
    (1, 2), (2, 1);

-- Экипировка из ITEMS: бронзовый доспех, слот 1 = torso
INSERT INTO item_templates (id, name, type, slot, quality, stackable, base_stats, icon)
VALUES (101, 'Бронзовый доспех', 2, 1, 2, FALSE, '{"hp": 250, "dodge": 0.01}', 'bronzeArmor');

-- NPC «Разбойник» для «Охоты»: статы brawlerElite из main.js
INSERT INTO npc_templates (id, name, level, stats, props) VALUES
    (1, 'Разбойник', 15,
     '{"hp": 1100, "damage": [140, 220], "crit": 0.1, "dodge": 0.05, "height": 1.92,
       "aiHealUses": 1, "aiPowerUses": 1, "aiHealAmount": 800, "aiHealAt": 0.6,
       "aiPowerMult": 1.5, "aiPowerTurns": 3}',
     '{"injury_chance": 0}');
INSERT INTO npc_spawns (id, npc_template_id, location_id) VALUES
    (1, 1, 1), (2, 1, 2);

INSERT INTO game_config (key, value) VALUES
    ('battle.turn_time',     '20'),
    ('battle.reward.hunt',   '{"currency": "copper", "amount": 50, "exp": 120}'),
    -- вмешательство в бой по умолчанию: в охоту нельзя, в PvP можно;
    -- переопределяется на уровне локации (locations.flags) и конкретного боя
    ('battle.intervention.default', '{"hunt": false, "pvp": true}'),
    ('battle.max_per_side',  '10'),
    -- выбор цели в NvN: соперник «липкий», переключается с вероятностью
    -- switch_chance; боец без размена cold_turns раундов — «холодный», и его
    -- приоритетно берут в цель (вес растёт на cold_weight за раунд «холода»)
    ('battle.target.switch_chance', '0.25'),
    ('battle.target.cold_turns',    '2'),
    ('battle.target.cold_weight',   '1.5'),
    ('character.start',      '{"level": 15, "hp": 2330, "damage": [160, 240],
                               "crit": 0.14, "dodge": 0.07, "height": 1.85,
                               "xp_max": 2000, "pvp_xp_max": 1000}'),
    ('chat.history_limit',   '50');

INSERT INTO name_blacklist (name) VALUES
    ('admin'), ('administrator'), ('moderator'), ('system'), ('gm');

INSERT INTO seasons (id, category, starts_at, ends_at) VALUES
    (1, 3, now(), now() + interval '90 days');
