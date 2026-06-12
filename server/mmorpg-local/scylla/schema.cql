-- Применяется при переходе на профиль full:
-- docker exec -it mmo-scylla cqlsh -f /schema/schema.cql
CREATE KEYSPACE IF NOT EXISTS mmo
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

-- Лог ходов боя (партиция ограничена длиной боя)
CREATE TABLE IF NOT EXISTS mmo.battle_rounds (
    battle_id   bigint,
    round_no    int,
    action_seq  int,
    actor_id    bigint,
    action_type smallint,
    target_id   bigint,
    value       bigint,
    effects     text,
    ts          timestamp,
    PRIMARY KEY ((battle_id), round_no, action_seq)
);

-- История чата (бакет по дням, чтобы партиции не разрастались)
CREATE TABLE IF NOT EXISTS mmo.chat_messages (
    channel_key text,
    day_bucket  int,
    created_at  timestamp,
    message_id  bigint,
    sender_id   bigint,
    sender_name text,
    body        text,
    flags       smallint,
    PRIMARY KEY ((channel_key, day_bucket), created_at, message_id)
) WITH CLUSTERING ORDER BY (created_at DESC, message_id DESC);
