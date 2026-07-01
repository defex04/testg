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

-- NPC «Разбойник» для «Охоты»: статы brawlerElite из main.js
INSERT INTO npc_templates (id, name, level, stats, props) VALUES
    (1, 'Разбойник', 1,
     '{"hp": 180, "damage": [13, 19], "crit": 0.07, "dodge": 0.04, "height": 1.88,
       "school": "natisk", "modelHpMult": 1.02, "modelPowerMult": 0.80,
       "aiHealUses": 0, "aiPowerUses": 0, "aiHealAmount": 45, "aiHealAt": 0.45,
       "aiPowerMult": 1.15, "aiPowerTurns": 1}',
     '{"injury_chance": 0}');
INSERT INTO npc_spawns (id, npc_template_id, location_id) VALUES
    (1, 1, 1), (2, 1, 2);

-- Мирные NPC для диалогов и квестовых цепочек.
INSERT INTO npc_templates (id, name, level, kind, description, image, stats, props) VALUES
    (100, 'Староста Мирай', 1, 2,
     'Староста Города Надежды собирает новости, выдаёт поручения новичкам и принимает отчёты.',
     NULL, '{}'::jsonb, '{}'::jsonb),
    (101, 'Травница Лея', 1, 2,
     'Лея знает окрестные тропы и помогает понять, где искать первые следы разбойников.',
     NULL, '{}'::jsonb, '{}'::jsonb);
INSERT INTO npc_spawns (id, npc_template_id, location_id, config) VALUES
    (100, 100, 1, '{"order": 10}'),
    (101, 101, 2, '{"order": 10}');

INSERT INTO quest_templates (id, type, repeatable, name, description, image, level_req,
    active, giver_npc_id, turnin_npc_id, dialogue, prereq, objectives, rewards)
VALUES
    (1000, 1, 1, 'Первые поручения старосты',
     'Короткая цепочка для новичка: поговорить с Леей, отбить нападение разбойников и принести взнос на стражу.',
     NULL, 1, TRUE, 100, 100,
     '{"greeting":"Нужны быстрые ноги и крепкая рука. Сходи к Лее в Зеленое поселение, она подскажет, где видели разбойников.","progress":"Сначала поговори с Леей, затем разберись с разбойниками и принеси 20 меди на стражу.","ready":"Вижу, ты вернулся с делом. Покажи, что собрал для стражи.","done":"Хорошая работа. Город запомнит тех, кто начал с помощи людям.","talk":{"101":["Староста прислал тебя? Хорошо, слушай внимательно.","На северной дороге видели одиночных разбойников. Они проверяют, кто слабее, и зовут остальных.","Победи пару разбойников и возвращайся к старосте. Теперь ты знаешь, куда идти."]}}'::jsonb,
     '{}'::jsonb,
     '{"mode":"sequence","stages":[{"title":"Весть из поселения","objectives":[{"kind":"talk","npcId":101,"count":1}]},{"title":"Разбойники на дороге","objectives":[{"kind":"kill","npcId":1,"count":2}]},{"title":"Взнос на стражу","objectives":[{"kind":"money","currency":"copper","amount":20,"consume":true}]}]}'::jsonb,
     '{"copper":150,"exp":150,"items":[{"templateId":202,"count":1}]}'::jsonb);

INSERT INTO game_config (key, value) VALUES
    ('battle.turn_time',     '20'),
    ('battle.reward.hunt',   '{"currency": "copper", "amount": 50, "exp": 25}'),
    ('character.leveling',   '{"maxLevel": 15, "thresholds": [0, 200, 500, 1000, 1800, 3200, 5500, 9000, 14000, 21000, 31000, 45000, 64000, 90000, 125000]}'),
    -- вмешательство в бой по умолчанию: в охоту нельзя, в PvP можно;
    -- переопределяется на уровне локации (locations.flags) и конкретного боя
    ('battle.intervention.default', '{"hunt": false, "pvp": true}'),
    ('battle.max_per_side',  '10'),
    -- контратака (рипост) в живом бою: шанс ответного удара получившего удар (0..1).
    -- 1 = всегда отвечает сразу за ударом соперника (без направления, см. engine)
    ('battle.counter_chance', '1'),
    -- выбор цели в NvN: соперник «липкий», переключается с вероятностью
    -- switch_chance; боец без размена cold_turns раундов — «холодный», и его
    -- приоритетно берут в цель (вес растёт на cold_weight за раунд «холода»)
    ('battle.target.switch_chance', '0.25'),
    ('battle.target.cold_turns',    '2'),
    ('battle.target.cold_weight',   '1.5'),
    ('character.start',      '{"level": 1, "hp": 200, "damage": [14, 22],
                               "crit": 0.14, "dodge": 0.07, "height": 1.85,
                               "xp_max": 200, "pvp_xp_max": 1000}'),
    ('chat.history_limit',   '50');

INSERT INTO name_blacklist (name) VALUES
    ('admin'), ('administrator'), ('moderator'), ('system'), ('gm');

INSERT INTO seasons (id, category, starts_at, ends_at) VALUES
    (1, 3, now(), now() + interval '90 days');
