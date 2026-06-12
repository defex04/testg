-- ============================================================
-- mmo_game: игровой мир (один мир = один такой кластер)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- СТАТИКА (шаблоны): read-only для игры, правится редактором
-- контента. Грузится сервисами в память при старте.
-- ============================================================
CREATE TABLE currencies (
    id   SMALLINT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,    -- gold / premium / valor / event_*
    name TEXT NOT NULL
);

CREATE TABLE item_templates (
    id         INT      PRIMARY KEY,
    name       TEXT     NOT NULL,
    type       SMALLINT NOT NULL,   -- 1 оружие, 2 броня, 3 ресурс, 4 эликсир,
                                    -- 5 артефакт, 6 скальп, 7 подарок, ...
    subtype    SMALLINT,
    quality    SMALLINT NOT NULL DEFAULT 1,
    level_req  SMALLINT NOT NULL DEFAULT 1,
    class_req  SMALLINT,
    slot       SMALLINT,            -- куда надевается (NULL = не экипируется)
    base_stats JSONB,
    stackable  BOOLEAN  NOT NULL DEFAULT FALSE,
    max_stack  INT      NOT NULL DEFAULT 1,
    tradable   BOOLEAN  NOT NULL DEFAULT TRUE,
    sellable   BOOLEAN  NOT NULL DEFAULT TRUE,
    droppable  BOOLEAN  NOT NULL DEFAULT TRUE,
    repairable BOOLEAN  NOT NULL DEFAULT FALSE,
    icon       TEXT,
    version    INT      NOT NULL DEFAULT 1
);

CREATE TABLE skill_templates (        -- навыки (палач, профессии боевые и т.п.)
    id INT PRIMARY KEY, name TEXT NOT NULL, max_level SMALLINT NOT NULL DEFAULT 10,
    config JSONB, version INT NOT NULL DEFAULT 1
);

CREATE TABLE ability_templates (      -- касты и антикасты
    id INT PRIMARY KEY,
    name            TEXT     NOT NULL,
    target_type     SMALLINT NOT NULL,  -- 1 self, 2 ally, 3 enemy, 4 side, 5 area
    usable_in_battle  BOOLEAN NOT NULL DEFAULT TRUE,
    usable_outside    BOOLEAN NOT NULL DEFAULT FALSE,
    cooldown_sec    INT,
    duration_sec    INT,
    charges         INT,
    effects         JSONB,              -- ссылки на effect_templates + параметры
    requirements    JSONB,
    version         INT NOT NULL DEFAULT 1
);

CREATE TABLE effect_templates (
    id INT PRIMARY KEY,
    kind            SMALLINT NOT NULL,  -- 1 buff, 2 debuff, 3 heal, 4 dot, 5 hot, 6 stun
    name            TEXT NOT NULL,
    stat_modifiers  JSONB,
    tick            JSONB,
    max_stacks      SMALLINT NOT NULL DEFAULT 1,
    dispellable     BOOLEAN  NOT NULL DEFAULT TRUE,
    default_duration_sec INT,
    version         INT NOT NULL DEFAULT 1
);

CREATE TABLE profession_templates (
    id INT PRIMARY KEY, name TEXT NOT NULL, config JSONB, version INT NOT NULL DEFAULT 1
);
CREATE TABLE recipe_templates (
    id INT PRIMARY KEY, profession_id INT REFERENCES profession_templates(id),
    inputs JSONB NOT NULL, outputs JSONB NOT NULL, config JSONB,
    version INT NOT NULL DEFAULT 1
);
CREATE TABLE achievement_templates (
    id INT PRIMARY KEY, name TEXT NOT NULL, config JSONB, version INT NOT NULL DEFAULT 1
);
CREATE TABLE title_templates (
    id INT PRIMARY KEY, name TEXT NOT NULL, config JSONB, version INT NOT NULL DEFAULT 1
);
CREATE TABLE collection_templates (
    id INT PRIMARY KEY, name TEXT NOT NULL, config JSONB, version INT NOT NULL DEFAULT 1
);
CREATE TABLE gift_templates (
    id INT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, price BIGINT,
    version INT NOT NULL DEFAULT 1
);
CREATE TABLE medal_templates (
    id INT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, description TEXT,
    version INT NOT NULL DEFAULT 1
);
CREATE TABLE pet_templates (
    id INT PRIMARY KEY, name TEXT NOT NULL, config JSONB, version INT NOT NULL DEFAULT 1
);
CREATE TABLE quest_templates (
    id INT PRIMARY KEY,
    type SMALLINT NOT NULL,
    repeatable SMALLINT NOT NULL DEFAULT 1,  -- 1 once, 2 daily, 3 weekly, 4 event
    prereq JSONB, objectives JSONB NOT NULL, rewards JSONB,
    version INT NOT NULL DEFAULT 1
);
CREATE TABLE npc_templates (
    id INT PRIMARY KEY, name TEXT NOT NULL, level SMALLINT NOT NULL,
    stats JSONB, loot_table JSONB,
    props JSONB,                    -- в т.ч. injury_chance — шанс травмы в PvE
    version INT NOT NULL DEFAULT 1
);
CREATE TABLE instance_templates (
    id INT PRIMARY KEY, name TEXT NOT NULL,
    party_min SMALLINT NOT NULL DEFAULT 1, party_max SMALLINT NOT NULL DEFAULT 5,
    level_req SMALLINT NOT NULL DEFAULT 1, lockout_hours INT NOT NULL DEFAULT 0,
    config JSONB, version INT NOT NULL DEFAULT 1
);

CREATE TABLE locations (
    id INT PRIMARY KEY,
    name TEXT NOT NULL,
    type SMALLINT NOT NULL,         -- 1 city, 2 field, 3 dungeon, 4 arena
    faction_zone SMALLINT,          -- NULL = нейтральная
    min_level SMALLINT NOT NULL DEFAULT 1,
    capacity INT,
    flags JSONB,
    version INT NOT NULL DEFAULT 1
);
CREATE TABLE location_links (
    from_id INT NOT NULL REFERENCES locations(id),
    to_id   INT NOT NULL REFERENCES locations(id),
    requirements JSONB,
    PRIMARY KEY (from_id, to_id)
);

-- ============================================================
-- ПЕРСОНАЖ
-- ============================================================
CREATE TABLE characters (
    id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    account_id  BIGINT      NOT NULL,            -- из mmo_auth, без FK между БД
    world_id    SMALLINT    NOT NULL DEFAULT 1,
    name        CITEXT      NOT NULL,
    faction     SMALLINT    NOT NULL,            -- враждующие расы
    class       SMALLINT,
    gender      SMALLINT,
    level       SMALLINT    NOT NULL DEFAULT 1,
    exp         BIGINT      NOT NULL DEFAULT 0,
    location_id INT         NOT NULL REFERENCES locations(id),
    hp_cur      INT         NOT NULL DEFAULT 1,
    mp_cur      INT         NOT NULL DEFAULT 0,
    energy      INT         NOT NULL DEFAULT 100,
    status      SMALLINT    NOT NULL DEFAULT 1,  -- 1 active, 2 blocked, 3 deleted
    online_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    UNIQUE (world_id, name)
);
CREATE INDEX ix_characters_account ON characters (account_id);

CREATE TABLE character_stats (
    character_id BIGINT PRIMARY KEY REFERENCES characters(id),
    str INT NOT NULL DEFAULT 0,
    agi INT NOT NULL DEFAULT 0,
    vit INT NOT NULL DEFAULT 0,
    intel INT NOT NULL DEFAULT 0,
    wis INT NOT NULL DEFAULT 0,
    free_points INT NOT NULL DEFAULT 0
    -- только БАЗОВЫЕ очки; итоговые (вещи+бафы) считает сервер, кеш в Redis
);

CREATE TABLE character_currencies (
    character_id BIGINT   NOT NULL REFERENCES characters(id),
    currency_id  SMALLINT NOT NULL REFERENCES currencies(id),
    balance      BIGINT   NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (character_id, currency_id)
);

CREATE TABLE character_skills (
    character_id BIGINT NOT NULL REFERENCES characters(id),
    skill_id     INT    NOT NULL REFERENCES skill_templates(id),
    level        SMALLINT NOT NULL DEFAULT 1,
    exp          BIGINT   NOT NULL DEFAULT 0,
    PRIMARY KEY (character_id, skill_id)
);

CREATE TABLE character_abilities (
    character_id BIGINT NOT NULL REFERENCES characters(id),
    ability_id   INT    NOT NULL REFERENCES ability_templates(id),
    learned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    slot         SMALLINT,
    PRIMARY KEY (character_id, ability_id)
);

CREATE TABLE character_professions (
    character_id  BIGINT NOT NULL REFERENCES characters(id),
    profession_id INT    NOT NULL REFERENCES profession_templates(id),
    level SMALLINT NOT NULL DEFAULT 1,
    exp   BIGINT   NOT NULL DEFAULT 0,
    PRIMARY KEY (character_id, profession_id)
);

CREATE TABLE character_recipes (
    character_id BIGINT NOT NULL REFERENCES characters(id),
    recipe_id    INT    NOT NULL REFERENCES recipe_templates(id),
    learned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (character_id, recipe_id)
);

-- Добоевые благословения/эликсиры: переживают релог, подхватываются боем
CREATE TABLE active_effects (
    id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    character_id BIGINT   NOT NULL REFERENCES characters(id),
    effect_id    INT      NOT NULL REFERENCES effect_templates(id),
    source_type  SMALLINT,
    source_id    BIGINT,
    stacks       SMALLINT NOT NULL DEFAULT 1,
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ
);
CREATE INDEX ix_effects_char ON active_effects (character_id);
CREATE INDEX ix_effects_expiry ON active_effects (expires_at);

CREATE TABLE character_cooldowns (      -- только длинные (часы/сутки)
    character_id BIGINT NOT NULL REFERENCES characters(id),
    key          TEXT   NOT NULL,
    ready_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (character_id, key)
);

CREATE TABLE character_reputation (
    character_id BIGINT   NOT NULL REFERENCES characters(id),
    faction_id   SMALLINT NOT NULL,
    value        INT      NOT NULL DEFAULT 0,
    PRIMARY KEY (character_id, faction_id)
);

CREATE TABLE character_achievements (
    character_id   BIGINT NOT NULL REFERENCES characters(id),
    achievement_id INT    NOT NULL REFERENCES achievement_templates(id),
    progress       JSONB,
    completed_at   TIMESTAMPTZ,
    PRIMARY KEY (character_id, achievement_id)
);

CREATE TABLE character_titles (
    character_id BIGINT NOT NULL REFERENCES characters(id),
    title_id     INT    NOT NULL REFERENCES title_templates(id),
    obtained_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active    BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (character_id, title_id)
);

CREATE TABLE character_collections (
    character_id  BIGINT NOT NULL REFERENCES characters(id),
    collection_id INT    NOT NULL REFERENCES collection_templates(id),
    progress      JSONB,
    PRIMARY KEY (character_id, collection_id)
);

CREATE TABLE character_pets (
    id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    character_id BIGINT NOT NULL REFERENCES characters(id),
    template_id  INT    NOT NULL REFERENCES pet_templates(id),
    name         TEXT,
    level        SMALLINT NOT NULL DEFAULT 1,
    exp          BIGINT   NOT NULL DEFAULT 0,
    stats        JSONB,
    status       SMALLINT NOT NULL DEFAULT 1
);
CREATE INDEX ix_pets_char ON character_pets (character_id);

CREATE TABLE character_daily (          -- дневные/недельные лимиты
    character_id BIGINT NOT NULL REFERENCES characters(id),
    key          TEXT   NOT NULL,
    value        BIGINT NOT NULL DEFAULT 0,
    resets_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (character_id, key)
);

CREATE TABLE character_settings (
    character_id BIGINT PRIMARY KEY REFERENCES characters(id),
    settings     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE character_profile (        -- блок «информация» на странице
    character_id BIGINT PRIMARY KEY REFERENCES characters(id),
    about        TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE character_statistics (     -- pvp_wins, pve_kills, scalps_taken, ...
    character_id BIGINT NOT NULL REFERENCES characters(id),
    metric       TEXT   NOT NULL,
    value        BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (character_id, metric)
    -- инкременты копить в Redis, сбрасывать батчем
);

CREATE TABLE character_gifts (          -- витрина подарков
    id                BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    to_character_id   BIGINT NOT NULL REFERENCES characters(id),
    from_character_id BIGINT REFERENCES characters(id),
    gift_template_id  INT    NOT NULL REFERENCES gift_templates(id),
    message           TEXT,
    is_anonymous      BOOLEAN NOT NULL DEFAULT FALSE,
    is_visible        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_gifts_to ON character_gifts (to_character_id);

CREATE TABLE character_medals (
    character_id BIGINT NOT NULL REFERENCES characters(id),
    medal_id     INT    NOT NULL REFERENCES medal_templates(id),
    awarded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    awarded_by   BIGINT,
    reason       TEXT,
    PRIMARY KEY (character_id, medal_id)
);

CREATE TABLE rename_history (
    character_id BIGINT NOT NULL REFERENCES characters(id),
    old_name     CITEXT NOT NULL,
    new_name     CITEXT NOT NULL,
    ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
    initiated_by BIGINT
);
CREATE INDEX ix_rename_char ON rename_history (character_id);

CREATE TABLE name_blacklist (
    name CITEXT PRIMARY KEY
);

-- Травмы: body_part маппится 1:1 на слоты экипировки
CREATE TABLE character_injuries (
    id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    character_id BIGINT   NOT NULL REFERENCES characters(id),
    body_part    SMALLINT NOT NULL,
    severity     SMALLINT NOT NULL DEFAULT 1,  -- 1 лёгкая, 2 средняя, 3 тяжёлая
    effects      JSONB,
    source_type  SMALLINT NOT NULL,            -- 1 pvp, 2 pve
    battle_id    BIGINT,
    inflictor_id BIGINT,        -- палач (pvp) или npc_template_id (pve)
    inflicted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    heals_at     TIMESTAMPTZ,
    treated_by   SMALLINT,      -- 1 знахарь, 2 эликсир, 3 истекла
    treated_at   TIMESTAMPTZ,
    status       SMALLINT NOT NULL DEFAULT 1   -- 1 active, 2 healed
);
CREATE UNIQUE INDEX ux_injury_part ON character_injuries (character_id, body_part)
    WHERE status = 1;           -- одна активная травма на часть тела

-- ============================================================
-- ПРЕДМЕТЫ И ЭКОНОМИКА
-- ============================================================
CREATE TABLE item_instances (
    id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    template_id   INT      NOT NULL REFERENCES item_templates(id),
    owner_type    SMALLINT NOT NULL,  -- 1 инвентарь, 2 экипировка, 3 банк,
                                      -- 4 клан-склад, 5 почта, 6 аукцион,
                                      -- 7 trade-эскроу, 8 система
    owner_id      BIGINT   NOT NULL,
    slot          INT,
    quantity      INT      NOT NULL DEFAULT 1 CHECK (quantity > 0),
    durability    INT,
    durability_max INT,
    bind_type     SMALLINT NOT NULL DEFAULT 0,   -- 0 нет, 1 персонаж, 2 аккаунт
    enchant_level SMALLINT NOT NULL DEFAULT 0,
    props         JSONB,    -- руны, случайные статы; у скальпа: victim_id,
                            -- victim_name, victim_level, battle_id
    status        SMALLINT NOT NULL DEFAULT 1,   -- 1 active, 2 deleted (не DROP!)
    version       INT      NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ
);
CREATE INDEX ix_items_owner ON item_instances (owner_type, owner_id) WHERE status = 1;
CREATE UNIQUE INDEX ux_equip_slot ON item_instances (owner_id, slot)
    WHERE owner_type = 2 AND status = 1;

-- Идемпотентность переносов ценностей (общая для денег и предметов)
CREATE TABLE idempotency_keys (
    key        UUID        NOT NULL,
    scope      TEXT        NOT NULL,   -- 'currency', 'item', 'mail', ...
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (key, scope)
);

CREATE SEQUENCE item_ledger_id_seq;
CREATE TABLE item_ledger (
    id              BIGINT NOT NULL DEFAULT nextval('item_ledger_id_seq'),
    idempotency_key UUID,
    item_instance_id BIGINT  NOT NULL,
    template_id     INT      NOT NULL,
    quantity        INT      NOT NULL,
    from_owner_type SMALLINT,
    from_owner_id   BIGINT,
    to_owner_type   SMALLINT,
    to_owner_id     BIGINT,
    reason          SMALLINT NOT NULL,  -- 1 drop, 2 quest, 3 trade, 4 auction,
                                        -- 5 mail, 6 craft, 7 destroy, 8 repair,
                                        -- 9 injury, 10 battle_loot, 11 admin
    ref_type        SMALLINT,
    ref_id          BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE item_ledger_default PARTITION OF item_ledger DEFAULT;
CREATE INDEX ix_item_ledger_item ON item_ledger (item_instance_id, created_at);

CREATE SEQUENCE currency_ledger_id_seq;
CREATE TABLE currency_ledger (
    id              BIGINT NOT NULL DEFAULT nextval('currency_ledger_id_seq'),
    idempotency_key UUID,
    subject_type    SMALLINT NOT NULL DEFAULT 1,  -- 1 персонаж, 2 клан, 3 система
    subject_id      BIGINT   NOT NULL,
    currency_id     SMALLINT NOT NULL,
    amount          BIGINT   NOT NULL,            -- + приход, − расход
    balance_after   BIGINT   NOT NULL,
    reason          SMALLINT NOT NULL,  -- 1 quest, 2 auction, 3 mail, 4 shop,
                                        -- 5 repair, 6 exchange, 7 battle, 8 admin
    ref_type        SMALLINT,
    ref_id          BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE currency_ledger_default PARTITION OF currency_ledger DEFAULT;
CREATE INDEX ix_curr_ledger_subj ON currency_ledger (subject_type, subject_id, created_at);

-- ============================================================
-- БОЙ (горячее состояние — в RAM боевой ноды + Redis; тут итоги)
-- ============================================================
CREATE TABLE battles (
    id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    world_id     SMALLINT NOT NULL DEFAULT 1,
    type         SMALLINT NOT NULL,  -- 1 duel, 2 group, 3 chaotic, 4 event,
                                     -- 5 instance, 6 clan_war, 7 faction_war
    location_id  INT      NOT NULL REFERENCES locations(id),
    status       SMALLINT NOT NULL DEFAULT 1,  -- 1 forming, 2 active, 3 finished, 4 aborted
    node_id      TEXT,
    max_per_side INT,
    intervention SMALLINT NOT NULL DEFAULT 1,  -- 1 open (можно вмешаться), 2 closed
    allow_leave  BOOLEAN  NOT NULL DEFAULT TRUE,
    stake        JSONB,
    started_at   TIMESTAMPTZ,
    ended_at     TIMESTAMPTZ,
    winner_side  SMALLINT,
    meta         JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_battles_loc_active ON battles (location_id) WHERE status IN (1, 2);

CREATE TABLE battle_participants (
    battle_id     BIGINT   NOT NULL REFERENCES battles(id),
    character_id  BIGINT   NOT NULL REFERENCES characters(id),
    side          SMALLINT NOT NULL,            -- назначает боевой сервер
    joined_round  INT      NOT NULL DEFAULT 0,
    left_round    INT,
    status        SMALLINT NOT NULL DEFAULT 1,  -- 1 fighting, 2 dead, 3 left
    result        SMALLINT,                     -- 1 win, 2 lose, 3 draw, 4 flee, 5 timeout
    damage_dealt  BIGINT NOT NULL DEFAULT 0,
    damage_taken  BIGINT NOT NULL DEFAULT 0,
    healing_done  BIGINT NOT NULL DEFAULT 0,
    kills         INT    NOT NULL DEFAULT 0,
    deaths        INT    NOT NULL DEFAULT 0,
    exp_gained    BIGINT NOT NULL DEFAULT 0,
    valor_gained  BIGINT NOT NULL DEFAULT 0,
    loot          JSONB,
    PRIMARY KEY (battle_id, character_id)
    -- PK не даёт войти повторно после выхода: строка не удаляется никогда
);
CREATE INDEX ix_bp_character ON battle_participants (character_id);

CREATE TABLE battle_challenges (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    from_id    BIGINT NOT NULL REFERENCES characters(id),
    to_id      BIGINT REFERENCES characters(id),
    type       SMALLINT NOT NULL,
    config     JSONB,
    status     SMALLINT NOT NULL DEFAULT 1, -- 1 pending, 2 accepted, 3 declined, 4 expired
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Этап 1: лог ходов в PG (партиции). Позже — Kafka -> ScyllaDB,
-- writer просто меняет приёмник, схема записей та же.
CREATE TABLE battle_rounds (
    battle_id   BIGINT   NOT NULL,
    round_no    INT      NOT NULL,
    action_seq  INT      NOT NULL,
    actor_id    BIGINT,
    action_type SMALLINT NOT NULL,
    target_id   BIGINT,
    value       BIGINT,
    effects     JSONB,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (ts);
CREATE TABLE battle_rounds_default PARTITION OF battle_rounds DEFAULT;
CREATE INDEX ix_battle_rounds ON battle_rounds (battle_id, round_no, action_seq);

-- ============================================================
-- МИР
-- ============================================================
CREATE TABLE npc_spawns (
    id INT PRIMARY KEY,
    npc_template_id INT NOT NULL REFERENCES npc_templates(id),
    location_id INT NOT NULL REFERENCES locations(id),
    config JSONB
);
CREATE TABLE npc_state (
    spawn_id  INT PRIMARY KEY REFERENCES npc_spawns(id),
    status    SMALLINT NOT NULL DEFAULT 1,
    hp        BIGINT,
    respawn_at TIMESTAMPTZ
);
CREATE TABLE resource_nodes (
    id INT PRIMARY KEY,
    location_id INT NOT NULL REFERENCES locations(id),
    type SMALLINT NOT NULL,
    state SMALLINT NOT NULL DEFAULT 1,
    respawn_at TIMESTAMPTZ
);
CREATE TABLE world_boss_state (
    boss_id    INT PRIMARY KEY REFERENCES npc_templates(id),
    status     SMALLINT NOT NULL DEFAULT 1,
    hp         BIGINT,
    spawned_at TIMESTAMPTZ,
    killed_by  BIGINT
);

-- ============================================================
-- СОЦИАЛЬНОЕ: друзья/враги, кланы, альянсы
-- ============================================================
CREATE TABLE character_relations (
    owner_id   BIGINT   NOT NULL REFERENCES characters(id),
    target_id  BIGINT   NOT NULL REFERENCES characters(id),
    relation   SMALLINT NOT NULL,  -- 1 friend, 2 enemy, 3 ignore
    note       VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, target_id, relation),
    CHECK (owner_id <> target_id)
);
CREATE INDEX ix_relations_target ON character_relations (target_id, relation);

CREATE TABLE friend_requests (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    from_id    BIGINT NOT NULL REFERENCES characters(id),
    to_id      BIGINT NOT NULL REFERENCES characters(id),
    message    TEXT,
    status     SMALLINT NOT NULL DEFAULT 1, -- 1 pending, 2 accepted, 3 declined
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_freq_to ON friend_requests (to_id) WHERE status = 1;

CREATE TABLE clans (
    id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    world_id    SMALLINT NOT NULL DEFAULT 1,
    name        CITEXT   NOT NULL,
    tag         CITEXT   NOT NULL,
    faction     SMALLINT NOT NULL,
    leader_id   BIGINT   NOT NULL REFERENCES characters(id),
    level       SMALLINT NOT NULL DEFAULT 1,
    exp         BIGINT   NOT NULL DEFAULT 0,
    emblem_ref  TEXT,
    description TEXT,
    recruiting  BOOLEAN  NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    disbanded_at TIMESTAMPTZ,
    UNIQUE (world_id, name),
    UNIQUE (world_id, tag)
);

CREATE TABLE clan_ranks (
    clan_id     BIGINT   NOT NULL REFERENCES clans(id),
    rank_id     SMALLINT NOT NULL,
    name        TEXT     NOT NULL,
    permissions BIGINT   NOT NULL DEFAULT 0,  -- битовая маска
    PRIMARY KEY (clan_id, rank_id)
);

CREATE TABLE clan_members (
    clan_id            BIGINT NOT NULL REFERENCES clans(id),
    character_id       BIGINT NOT NULL UNIQUE REFERENCES characters(id),
    rank_id            SMALLINT NOT NULL,
    joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    contribution_total BIGINT NOT NULL DEFAULT 0,
    contribution_week  BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (clan_id, character_id)
);

CREATE TABLE clan_applications (
    id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    clan_id      BIGINT NOT NULL REFERENCES clans(id),
    character_id BIGINT NOT NULL REFERENCES characters(id),
    message      TEXT,
    status       SMALLINT NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clan_currencies (
    clan_id     BIGINT   NOT NULL REFERENCES clans(id),
    currency_id SMALLINT NOT NULL REFERENCES currencies(id),
    balance     BIGINT   NOT NULL DEFAULT 0 CHECK (balance >= 0),
    PRIMARY KEY (clan_id, currency_id)
);
-- движения казны идут в общий currency_ledger с subject_type = 2

CREATE TABLE clan_log (
    clan_id  BIGINT   NOT NULL,
    actor_id BIGINT,
    action   SMALLINT NOT NULL,
    details  JSONB,
    ts       TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (ts);
CREATE TABLE clan_log_default PARTITION OF clan_log DEFAULT;
CREATE INDEX ix_clan_log ON clan_log (clan_id, ts);

CREATE TABLE clan_buildings (
    clan_id     BIGINT NOT NULL REFERENCES clans(id),
    building_id SMALLINT NOT NULL,
    level       SMALLINT NOT NULL DEFAULT 1,
    upgraded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (clan_id, building_id)
);

CREATE TABLE alliances (
    id             BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name           CITEXT NOT NULL UNIQUE,
    leader_clan_id BIGINT NOT NULL REFERENCES clans(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    disbanded_at   TIMESTAMPTZ
);
CREATE TABLE alliance_members (
    alliance_id BIGINT NOT NULL REFERENCES alliances(id),
    clan_id     BIGINT NOT NULL UNIQUE REFERENCES clans(id),
    role        SMALLINT NOT NULL DEFAULT 1,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (alliance_id, clan_id)
);
CREATE TABLE clan_relations (
    clan_a      BIGINT NOT NULL REFERENCES clans(id),
    clan_b      BIGINT NOT NULL REFERENCES clans(id),
    relation    SMALLINT NOT NULL,  -- 1 war, 2 truce, 3 ally
    declared_by BIGINT,
    declared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at     TIMESTAMPTZ,
    PRIMARY KEY (clan_a, clan_b),
    CHECK (clan_a < clan_b)
);

-- ============================================================
-- ПОЧТА (единый канал доставки ценностей: аукцион, магазин, ивенты)
-- ============================================================
CREATE TABLE mail_messages (
    id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    recipient_id  BIGINT NOT NULL REFERENCES characters(id),
    sender_id     BIGINT REFERENCES characters(id),  -- NULL = система
    type          SMALLINT NOT NULL DEFAULT 1, -- 1 player, 2 system, 3 auction, 4 cod
    subject       TEXT,
    body          TEXT,
    money_attached BIGINT NOT NULL DEFAULT 0,
    cod_amount    BIGINT NOT NULL DEFAULT 0,   -- наложенный платёж
    has_attachments  BOOLEAN NOT NULL DEFAULT FALSE,
    attachments_taken BOOLEAN NOT NULL DEFAULT FALSE,
    is_read       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ,
    deleted_by_sender    BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_by_recipient BOOLEAN NOT NULL DEFAULT FALSE
);
-- в проде партиционировать по created_at
CREATE INDEX ix_mail_recipient ON mail_messages (recipient_id, created_at)
    WHERE deleted_by_recipient = FALSE;
CREATE INDEX ix_mail_expiry ON mail_messages (expires_at)
    WHERE has_attachments AND NOT attachments_taken;

CREATE TABLE mail_attachments (
    mail_id          BIGINT NOT NULL REFERENCES mail_messages(id),
    item_instance_id BIGINT NOT NULL REFERENCES item_instances(id),
    quantity         INT    NOT NULL DEFAULT 1,
    PRIMARY KEY (mail_id, item_instance_id)
);

-- ============================================================
-- АУКЦИОН
-- ============================================================
CREATE TABLE auction_lots (
    id               BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    world_id         SMALLINT NOT NULL DEFAULT 1,
    seller_id        BIGINT NOT NULL REFERENCES characters(id),
    item_instance_id BIGINT NOT NULL REFERENCES item_instances(id),
    quantity         INT    NOT NULL DEFAULT 1,
    category         SMALLINT NOT NULL,   -- денормализация для фильтров
    subcategory      SMALLINT,
    level            SMALLINT,
    start_price      BIGINT NOT NULL CHECK (start_price > 0),
    buyout_price     BIGINT,
    current_bid      BIGINT,
    current_bidder_id BIGINT REFERENCES characters(id),
    bid_count        INT    NOT NULL DEFAULT 0,
    deposit          BIGINT NOT NULL DEFAULT 0,
    status           SMALLINT NOT NULL DEFAULT 1, -- 1 active, 2 sold, 3 bought_out,
                                                  -- 4 expired, 5 cancelled
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at          TIMESTAMPTZ NOT NULL,
    version          INT NOT NULL DEFAULT 1
);
CREATE INDEX ix_lots_search ON auction_lots (category, subcategory, level)
    WHERE status = 1;
CREATE INDEX ix_lots_finish ON auction_lots (ends_at) WHERE status = 1;
CREATE INDEX ix_lots_seller ON auction_lots (seller_id, created_at);

CREATE TABLE auction_bids (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    lot_id     BIGINT NOT NULL REFERENCES auction_lots(id),
    bidder_id  BIGINT NOT NULL REFERENCES characters(id),
    amount     BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status     SMALLINT NOT NULL DEFAULT 1  -- 1 active, 2 outbid, 3 won, 4 refunded
);
CREATE INDEX ix_bids_lot ON auction_bids (lot_id);

CREATE TABLE auction_price_history (
    template_id INT  NOT NULL,
    day         DATE NOT NULL,
    deals       INT    NOT NULL DEFAULT 0,
    min_price   BIGINT,
    avg_price   BIGINT,
    max_price   BIGINT,
    volume      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (template_id, day)
);

-- ============================================================
-- БИРЖА РЕСУРСОВ
-- ============================================================
CREATE TABLE exchange_instruments (
    instrument_id    INT PRIMARY KEY,
    item_template_id INT NOT NULL REFERENCES item_templates(id),
    tick_size BIGINT NOT NULL DEFAULT 1,
    lot_size  INT    NOT NULL DEFAULT 1,
    active    BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE exchange_orders (
    id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    character_id  BIGINT NOT NULL REFERENCES characters(id),
    instrument_id INT    NOT NULL REFERENCES exchange_instruments(instrument_id),
    side          SMALLINT NOT NULL,  -- 1 buy, 2 sell
    price         BIGINT NOT NULL CHECK (price > 0),
    quantity      INT    NOT NULL CHECK (quantity > 0),
    filled        INT    NOT NULL DEFAULT 0,
    status        SMALLINT NOT NULL DEFAULT 1, -- 1 open, 2 partial, 3 filled, 4 cancelled
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_orders_book ON exchange_orders (instrument_id, side, price)
    WHERE status IN (1, 2);
CREATE TABLE exchange_trades (
    id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    instrument_id INT    NOT NULL,
    buy_order_id  BIGINT NOT NULL,
    sell_order_id BIGINT NOT NULL,
    price         BIGINT NOT NULL,
    quantity      INT    NOT NULL,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_trades_instr ON exchange_trades (instrument_id, ts);
CREATE TABLE exchange_candles (
    instrument_id INT NOT NULL,
    period SMALLINT NOT NULL,  -- 1 = 1h, 2 = 1d
    ts TIMESTAMPTZ NOT NULL,
    open BIGINT, high BIGINT, low BIGINT, close BIGINT,
    volume BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (instrument_id, period, ts)
);

-- ============================================================
-- ПРЯМОЙ ОБМЕН (история; процесс — в Redis)
-- ============================================================
CREATE TABLE trades (
    id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    character_a BIGINT NOT NULL REFERENCES characters(id),
    character_b BIGINT NOT NULL REFERENCES characters(id),
    location_id INT REFERENCES locations(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE trade_items (
    trade_id BIGINT NOT NULL REFERENCES trades(id),
    side     SMALLINT NOT NULL,           -- 1 = a отдал, 2 = b отдал
    item_instance_id BIGINT,
    quantity INT NOT NULL DEFAULT 1,
    money    BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX ix_trade_items ON trade_items (trade_id);

-- ============================================================
-- ЧАТ (этап 1: история в PG; позже — ScyllaDB, схема та же)
-- ============================================================
CREATE TABLE chat_channels (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    type       SMALLINT NOT NULL,  -- 1 global, 2 location, 3 clan, 4 alliance,
                                   -- 5 battle, 6 private, 7 trade
    ref_id     BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (type, ref_id)
);
CREATE TABLE chat_messages (
    channel_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    sender_id  BIGINT,
    sender_name TEXT,
    body       TEXT NOT NULL,
    flags      SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
CREATE TABLE chat_messages_default PARTITION OF chat_messages DEFAULT;
CREATE INDEX ix_chat ON chat_messages (channel_id, created_at);

CREATE TABLE chat_sanctions (
    character_id BIGINT NOT NULL REFERENCES characters(id),
    channel_type SMALLINT NOT NULL,
    muted_until  TIMESTAMPTZ NOT NULL,
    reason       TEXT,
    issued_by    BIGINT,
    PRIMARY KEY (character_id, channel_type)
);
CREATE TABLE chat_reports (
    id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    reporter_id BIGINT NOT NULL,
    message_ref TEXT   NOT NULL,
    reason      SMALLINT,
    status      SMALLINT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- КВЕСТЫ, ИВЕНТЫ, ИНСТАНСЫ
-- ============================================================
CREATE TABLE character_quests (
    character_id BIGINT NOT NULL REFERENCES characters(id),
    quest_id     INT    NOT NULL REFERENCES quest_templates(id),
    status       SMALLINT NOT NULL DEFAULT 1, -- 1 active, 2 done, 3 failed, 4 cooldown
    progress     JSONB,
    accepted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    available_again_at TIMESTAMPTZ,
    PRIMARY KEY (character_id, quest_id)
);
CREATE TABLE quest_history (
    character_id BIGINT NOT NULL,
    quest_id     INT    NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (character_id, quest_id)
);

CREATE TABLE events (
    id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    template_id INT,
    name        TEXT NOT NULL,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ NOT NULL,
    status      SMALLINT NOT NULL DEFAULT 1,
    config      JSONB
);
CREATE TABLE event_participants (
    event_id     BIGINT NOT NULL REFERENCES events(id),
    character_id BIGINT NOT NULL REFERENCES characters(id),
    score        BIGINT NOT NULL DEFAULT 0,
    rank_final   INT,
    rewards_claimed_at TIMESTAMPTZ,
    PRIMARY KEY (event_id, character_id)
);

CREATE TABLE instance_runs (
    id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    template_id INT NOT NULL REFERENCES instance_templates(id),
    world_id    SMALLINT NOT NULL DEFAULT 1,
    leader_id   BIGINT NOT NULL REFERENCES characters(id),
    difficulty  SMALLINT NOT NULL DEFAULT 1,
    status      SMALLINT NOT NULL DEFAULT 1, -- 1 forming, 2 active, 3 completed,
                                             -- 4 failed, 5 expired
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    state_ref   TEXT                          -- ключ состояния в Redis
);
CREATE TABLE instance_members (
    run_id       BIGINT NOT NULL REFERENCES instance_runs(id),
    character_id BIGINT NOT NULL REFERENCES characters(id),
    role         SMALLINT,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, character_id)
);
CREATE TABLE instance_lockouts (
    character_id BIGINT NOT NULL REFERENCES characters(id),
    template_id  INT    NOT NULL REFERENCES instance_templates(id),
    locked_until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (character_id, template_id)
);
CREATE TABLE instance_loot_log (
    run_id           BIGINT NOT NULL,
    character_id     BIGINT NOT NULL,
    item_template_id INT    NOT NULL,
    quantity         INT    NOT NULL DEFAULT 1,
    roll_info        JSONB,
    ts               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_loot_run ON instance_loot_log (run_id);

-- ============================================================
-- РЕЙТИНГИ И СЕЗОНЫ
-- ============================================================
CREATE TABLE seasons (
    id        INT PRIMARY KEY,
    category  SMALLINT NOT NULL,  -- 1 arena_1x1, 2 arena_group, 3 pvp, 4 pve, 5 clan
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at   TIMESTAMPTZ NOT NULL
);
CREATE TABLE ratings (
    season_id    INT      NOT NULL REFERENCES seasons(id),
    category     SMALLINT NOT NULL,
    subject_type SMALLINT NOT NULL,  -- 1 char, 2 clan
    subject_id   BIGINT   NOT NULL,
    rating       INT      NOT NULL DEFAULT 1000,
    wins         INT      NOT NULL DEFAULT 0,
    losses       INT      NOT NULL DEFAULT 0,
    streak       INT      NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (season_id, category, subject_type, subject_id)
);
CREATE TABLE ratings_history (
    season_id    INT NOT NULL,
    category     SMALLINT NOT NULL,
    subject_type SMALLINT NOT NULL,
    subject_id   BIGINT NOT NULL,
    final_rating INT NOT NULL,
    final_rank   INT,
    rewards      JSONB,
    PRIMARY KEY (season_id, category, subject_type, subject_id)
);

-- ============================================================
-- МОДЕРАЦИЯ, ПОДДЕРЖКА, АДМИНКА, ПРОЧЕЕ
-- ============================================================
CREATE TABLE player_reports (
    id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    reporter_id BIGINT NOT NULL REFERENCES characters(id),
    target_id   BIGINT NOT NULL REFERENCES characters(id),
    category    SMALLINT NOT NULL,
    context_ref TEXT,
    description TEXT,
    status      SMALLINT NOT NULL DEFAULT 1,
    assignee_id BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolution  TEXT
);

CREATE TABLE admin_audit (
    id        BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    admin_id  BIGINT NOT NULL,
    action    TEXT   NOT NULL,
    target_type SMALLINT,
    target_id BIGINT,
    details   JSONB,
    ip        INET,
    ts        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE support_tickets (
    id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    account_id  BIGINT NOT NULL,
    subject     TEXT,
    status      SMALLINT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at   TIMESTAMPTZ
);
CREATE TABLE ticket_messages (
    id        BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    ticket_id BIGINT NOT NULL REFERENCES support_tickets(id),
    author_id BIGINT,
    is_staff  BOOLEAN NOT NULL DEFAULT FALSE,
    body      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fraud_flags (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    subject_id BIGINT NOT NULL,
    rule_code  TEXT   NOT NULL,
    score      INT    NOT NULL DEFAULT 0,
    details    JSONB,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE notifications_id_seq;
CREATE TABLE notifications (
    id           BIGINT NOT NULL DEFAULT nextval('notifications_id_seq'),
    character_id BIGINT NOT NULL,
    type         SMALLINT NOT NULL,
    payload      JSONB,
    is_read      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE notifications_default PARTITION OF notifications DEFAULT;
CREATE INDEX ix_notif_char ON notifications (character_id, created_at);

CREATE TABLE news (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    body  TEXT,
    published_at TIMESTAMPTZ
);

CREATE TABLE game_config (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    version    INT   NOT NULL DEFAULT 1,
    updated_by BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE referrals (
    referrer_id         BIGINT NOT NULL REFERENCES characters(id),
    referred_account_id BIGINT NOT NULL,
    status              SMALLINT NOT NULL DEFAULT 1,
    milestones          JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (referrer_id, referred_account_id)
);

-- ============================================================
-- ПРАВА: game_rw — без DELETE везде, ledger'ы и аудит append-only
-- ============================================================
GRANT CONNECT ON DATABASE mmo_game TO game_rw;
GRANT USAGE ON SCHEMA public TO game_rw;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO game_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO game_rw;

REVOKE UPDATE ON
    currency_ledger, currency_ledger_default,
    item_ledger, item_ledger_default,
    admin_audit, rename_history, trades, trade_items,
    battle_rounds, battle_rounds_default,
    clan_log, clan_log_default,
    fraud_flags, quest_history, instance_loot_log
FROM game_rw;

-- Статика — read-only для игры, правит только контент-роль/миграции
REVOKE INSERT, UPDATE ON
    currencies, item_templates, skill_templates, ability_templates,
    effect_templates, profession_templates, recipe_templates,
    achievement_templates, title_templates, collection_templates,
    gift_templates, medal_templates, pet_templates, quest_templates,
    npc_templates, instance_templates, locations, location_links
FROM game_rw;
