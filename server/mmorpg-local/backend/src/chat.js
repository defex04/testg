import { game, redis, redisSub, tx } from './db.js';

/** Канал чата локации: создаётся по требованию (type=2, ref=location_id). */
const channelCache = new Map();
async function locationChannel(locId) {
  if (channelCache.has(locId)) return channelCache.get(locId);
  const found = await game.query(
    `SELECT id FROM chat_channels WHERE type = 2 AND ref_id = $1`, [locId]);
  let id = found.rows[0] && found.rows[0].id;
  if (!id) {
    const ins = await game.query(
      `INSERT INTO chat_channels (type, ref_id) VALUES (2, $1)
       ON CONFLICT (type, ref_id) DO UPDATE SET ref_id = EXCLUDED.ref_id
       RETURNING id`, [locId]);
    id = ins.rows[0].id;
  }
  channelCache.set(locId, id);
  return id;
}

export async function sendChat(ch, text) {
  text = String(text || '').trim().slice(0, 500);
  if (!text) return;
  const muted = await game.query(
    `SELECT 1 FROM chat_sanctions
      WHERE character_id = $1 AND channel_type = 2 AND muted_until > now()`, [ch.id]);
  if (muted.rows[0]) throw Object.assign(new Error('muted'), { status: 403 });

  const channelId = await locationChannel(ch.location_id);
  const msg = { channelId, locId: ch.location_id, senderId: ch.id,
    senderName: ch.name, body: text, ts: Date.now() };
  await game.query(
    `INSERT INTO chat_messages (channel_id, message_id, sender_id, sender_name, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [channelId, msg.ts, ch.id, ch.name, text]);
  await redis.publish(`chat.loc.${ch.location_id}`, JSON.stringify(msg));
}

const MUTE_PRIVATE = 6;   // channel_type для мьюта лички

async function ensureNotMuted(charId, channelType) {
  const muted = await game.query(
    `SELECT 1 FROM chat_sanctions
      WHERE character_id = $1 AND channel_type = $2 AND muted_until > now()`,
    [charId, channelType]);
  if (muted.rows[0]) throw Object.assign(new Error('muted'), { status: 403 });
}

/** Найти адресата по имени (активного персонажа). */
async function resolveRecipient(name) {
  const r = (await game.query(
    `SELECT id, name FROM characters WHERE name = $1 AND status = 1`,
    [String(name || '').trim()])).rows[0];
  if (!r) throw Object.assign(new Error('recipient_not_found'), { status: 404 });
  return r;
}

/**
 * Личное сообщение В ОБЩЕМ чате локации: видно всем в локации, помечено адресатом
 * («Игрок → Цель»). Хранится в том же канале локации, остаётся в общем чате.
 */
export async function sendPersonal(ch, toName, text) {
  text = String(text || '').trim().slice(0, 500);
  if (!text) return null;
  await ensureNotMuted(ch.id, 2);
  const rcpt = await resolveRecipient(toName);

  const channelId = await locationChannel(ch.location_id);
  const ts = Date.now();
  const msg = { channelId, locId: ch.location_id, senderId: ch.id, senderName: ch.name,
    toId: Number(rcpt.id), toName: rcpt.name, body: text, ts };
  await game.query(
    `INSERT INTO chat_messages (channel_id, message_id, sender_id, sender_name, body, flags, target_name)
     VALUES ($1, $2, $3, $4, $5, 1, $6)`,   // flags=1: личное в общем
    [channelId, ts, ch.id, ch.name, text, rcpt.name]);
  await redis.publish(`chat.loc.${ch.location_id}`, JSON.stringify(msg));
  return msg;
}

/**
 * Стабильный канал лички на упорядоченную пару (lo,hi). Под advisory-локом, чтобы
 * параллельная первая переписка не создала два канала на одну пару.
 */
async function dmChannel(a, b) {
  const lo = Math.min(Number(a), Number(b));
  const hi = Math.max(Number(a), Number(b));
  const found = await game.query(
    `SELECT channel_id FROM dm_pairs WHERE lo = $1 AND hi = $2`, [lo, hi]);
  if (found.rows[0]) return Number(found.rows[0].channel_id);
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(($1 % 2000000000)::int, ($2 % 2000000000)::int)`,
      [lo, hi]);
    const again = await c.query(
      `SELECT channel_id FROM dm_pairs WHERE lo = $1 AND hi = $2`, [lo, hi]);
    if (again.rows[0]) return Number(again.rows[0].channel_id);
    const ch = await c.query(
      `INSERT INTO chat_channels (type, ref_id) VALUES (6, NULL) RETURNING id`);
    const channelId = Number(ch.rows[0].id);
    await c.query(
      `INSERT INTO dm_pairs (lo, hi, channel_id) VALUES ($1, $2, $3)`, [lo, hi, channelId]);
    return channelId;
  });
}

/**
 * Приватное сообщение (личка): отдельный канал на пару. Доставляется адресату и
 * отправителю по личным redis-каналам chat.dm.{id} — независимо от их локаций.
 */
export async function sendPrivate(ch, toName, text) {
  text = String(text || '').trim().slice(0, 500);
  if (!text) return null;
  await ensureNotMuted(ch.id, MUTE_PRIVATE);
  const rcpt = await resolveRecipient(toName);
  if (String(rcpt.id) === String(ch.id)) {
    throw Object.assign(new Error('cannot_dm_self'), { status: 400 });
  }
  const channelId = await dmChannel(ch.id, rcpt.id);
  const ts = Date.now();
  await game.query(
    `INSERT INTO chat_messages (channel_id, message_id, sender_id, sender_name, body)
     VALUES ($1, $2, $3, $4, $5)`, [channelId, ts, ch.id, ch.name, text]);
  const base = { fromId: Number(ch.id), fromName: ch.name,
    toId: Number(rcpt.id), toName: rcpt.name, body: text, ts };
  // адресату и себе (эхо) — каждому со своей точкой зрения (viewerId)
  await redis.publish(`chat.dm.${rcpt.id}`, JSON.stringify({ ...base, viewerId: Number(rcpt.id) }));
  await redis.publish(`chat.dm.${ch.id}`, JSON.stringify({ ...base, viewerId: Number(ch.id) }));
  return base;
}

/** История лички с конкретным собеседником. */
export async function privateHistory(charId, peerId) {
  const lo = Math.min(Number(charId), Number(peerId));
  const hi = Math.max(Number(charId), Number(peerId));
  const found = await game.query(
    `SELECT channel_id FROM dm_pairs WHERE lo = $1 AND hi = $2`, [lo, hi]);
  if (!found.rows[0]) return [];
  const { rows } = await game.query(
    `SELECT sender_id, sender_name, body, created_at FROM chat_messages
      WHERE channel_id = $1 AND created_at >= now() - interval '24 hours'
      ORDER BY created_at ASC`,
    [found.rows[0].channel_id]);
  return rows.map(r => ({
    fromId: Number(r.sender_id), fromName: r.sender_name, body: r.body,
    mine: String(r.sender_id) === String(charId),
    ts: new Date(r.created_at).getTime(),
  }));
}

/** Системное сообщение в чат локации (объявления боёв и т.п.). */
export async function sendSystemChat(locId, text) {
  const channelId = await locationChannel(locId);
  const msg = { channelId, locId, senderId: null,
    senderName: 'Система', body: text, ts: Date.now() };
  await game.query(
    `INSERT INTO chat_messages (channel_id, message_id, sender_id, sender_name, body)
     VALUES ($1, $2, NULL, $3, $4)`, [channelId, msg.ts, msg.senderName, text]);
  await redis.publish(`chat.loc.${locId}`, JSON.stringify(msg));
}

export async function history(locId) {
  const channelId = await locationChannel(locId);
  const { rows } = await game.query(
    `SELECT sender_id, sender_name, body, target_name, created_at FROM chat_messages
      WHERE channel_id = $1 AND created_at >= now() - interval '24 hours'
      ORDER BY created_at ASC`, [channelId]);
  return rows;
}

/** Подписка процессом на все локационные каналы; hub раздаёт по сокетам. */
export async function subscribeChat(onMessage) {
  await redisSub.pSubscribe('chat.loc.*', (raw) => {
    try { onMessage(JSON.parse(raw)); } catch { /* мусор в канале игнорируем */ }
  });
}

/** Подписка на личные каналы chat.dm.{id}: hub шлёт сообщение зрителю viewerId. */
export async function subscribePrivate(onMessage) {
  await redisSub.pSubscribe('chat.dm.*', (raw) => {
    try { onMessage(JSON.parse(raw)); } catch { /* мусор игнорируем */ }
  });
}

export function chatRoutes(app, authed) {
  app.get('/api/chat/history', authed, async (req, res) => {
    const { rows } = await game.query(
      `SELECT location_id FROM characters WHERE id = $1`, [req.session.character_id]);
    res.json(await history(rows[0].location_id));
  });

  app.get('/api/chat/private/:peerId', authed, async (req, res) =>
    res.json(await privateHistory(req.session.character_id, Number(req.params.peerId))));
}
