import { game, redis, redisSub, gameConfig } from './db.js';

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
  const limit = Number(await gameConfig('chat.history_limit')) || 50;
  const channelId = await locationChannel(locId);
  const { rows } = await game.query(
    `SELECT sender_name, body, created_at FROM chat_messages
      WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2`, [channelId, limit]);
  return rows.reverse();
}

/** Подписка процессом на все локационные каналы; hub раздаёт по сокетам. */
export async function subscribeChat(onMessage) {
  await redisSub.pSubscribe('chat.loc.*', (raw) => {
    try { onMessage(JSON.parse(raw)); } catch { /* мусор в канале игнорируем */ }
  });
}

export function chatRoutes(app, authed) {
  app.get('/api/chat/history', authed, async (req, res) => {
    const { rows } = await game.query(
      `SELECT location_id FROM characters WHERE id = $1`, [req.session.character_id]);
    res.json(await history(rows[0].location_id));
  });
}
