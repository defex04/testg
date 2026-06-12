import { game, redis } from './db.js';

/** Присутствие — только Redis: hash loc:{id}:players, как в архитектуре. */
const key = (locId) => `loc:${locId}:players`;

export async function enterLocation(ch) {
  await redis.hSet(key(ch.location_id), String(ch.id),
    JSON.stringify({ id: ch.id, name: ch.name, level: ch.level }));
}
export async function leavePresence(ch) {
  await redis.hDel(key(ch.location_id), String(ch.id));
}

export async function playersIn(locId) {
  const all = await redis.hGetAll(key(locId));
  return Object.values(all).map((s) => JSON.parse(s));
}

export async function moveCharacter(charId, toId) {
  const { rows } = await game.query(
    `SELECT location_id FROM characters WHERE id = $1`, [charId]);
  const from = rows[0].location_id;
  const link = await game.query(
    `SELECT 1 FROM location_links WHERE from_id = $1 AND to_id = $2`, [from, toId]);
  if (!link.rows[0]) throw Object.assign(new Error('no_path'), { status: 400 });

  await game.query(`UPDATE characters SET location_id = $2 WHERE id = $1`, [charId, toId]);
  const me = (await game.query(
    `SELECT id, name, level FROM characters WHERE id = $1`, [charId])).rows[0];
  await redis.hDel(key(from), String(charId));
  await redis.hSet(key(toId), String(charId),
    JSON.stringify({ id: me.id, name: me.name, level: me.level }));
  return { from, to: toId };
}

export async function locationsList() {
  const locs = await game.query(`SELECT id, name, type FROM locations ORDER BY id`);
  const links = await game.query(`SELECT from_id, to_id FROM location_links`);
  const hunts = await game.query(`SELECT DISTINCT location_id FROM npc_spawns`);
  const huntSet = new Set(hunts.rows.map(r => r.location_id));
  return locs.rows.map(l => ({
    ...l,
    hunt: huntSet.has(l.id),
    exits: links.rows.filter(x => x.from_id === l.id).map(x => x.to_id),
  }));
}

export function locationRoutes(app, authed, hub) {
  app.get('/api/locations', authed, async (req, res) => res.json(await locationsList()));

  app.get('/api/locations/players', authed, async (req, res) => {
    const { rows } = await game.query(
      `SELECT location_id FROM characters WHERE id = $1`, [req.session.character_id]);
    res.json(await playersIn(rows[0].location_id));
  });

  app.post('/api/locations/move', authed, async (req, res) => {
    const r = await moveCharacter(req.session.character_id, Number(req.body.to));
    hub.onMoved(req.session.character_id, r.from, r.to);
    res.json({ ok: true, location_id: r.to });
  });
}
