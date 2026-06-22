import { game, tx, gameConfig, redis } from './db.js';
import { wallet } from './economy.js';

const DEFAULT_MAX_LEVEL = 15;
export const DEFAULT_LEVEL_THRESHOLDS = Object.freeze([
  0, 200, 500, 1000, 1800, 3200, 5500, 9000,
  14000, 21000, 31000, 45000, 64000, 90000, 125000,
]);

export function normalizeLeveling(raw = {}) {
  const max = Math.trunc(Number(raw?.maxLevel ?? raw?.max_level ?? DEFAULT_MAX_LEVEL));
  const maxLevel = Math.max(1, Math.min(100, max || DEFAULT_MAX_LEVEL));
  const source = Array.isArray(raw?.thresholds) ? raw.thresholds : DEFAULT_LEVEL_THRESHOLDS;
  const thresholds = [];
  for (let i = 0; i < maxLevel; i++) {
    const fallback = DEFAULT_LEVEL_THRESHOLDS[i]
      ?? ((thresholds[i - 1] ?? 0) + 1);
    const n = Math.trunc(Number(source[i]));
    if (i === 0) thresholds.push(0);
    else thresholds.push(Math.max(Number.isFinite(n) ? n : fallback, thresholds[i - 1] + 1));
  }
  return { maxLevel, thresholds };
}

export async function levelingConfig() {
  return normalizeLeveling(await gameConfig('character.leveling'));
}

export function levelForExp(exp, leveling = normalizeLeveling()) {
  const cfg = normalizeLeveling(leveling);
  const total = Math.max(0, Math.trunc(Number(exp) || 0));
  let level = 1;
  for (let i = 0; i < cfg.thresholds.length; i++) {
    if (total >= cfg.thresholds[i]) level = i + 1;
    else break;
  }
  return Math.min(cfg.maxLevel, level);
}

export function levelProgress(exp, level, leveling = normalizeLeveling()) {
  const cfg = normalizeLeveling(leveling);
  const total = Math.max(0, Math.trunc(Number(exp) || 0));
  const fallbackLevel = levelForExp(total, cfg);
  const safeLevel = Math.max(1,
    Math.min(cfg.maxLevel, Math.trunc(Number(level) || fallbackLevel)));
  const currentThreshold = cfg.thresholds[safeLevel - 1] ?? 0;
  const nextThreshold = safeLevel >= cfg.maxLevel ? null : cfg.thresholds[safeLevel];
  if (nextThreshold == null) {
    return { xp: 0, xpMax: 0, currentThreshold, nextThreshold, maxed: true };
  }
  const xpMax = Math.max(1, nextThreshold - currentThreshold);
  const xp = Math.max(0, Math.min(xpMax, total - currentThreshold));
  return { xp, xpMax, currentThreshold, nextThreshold, maxed: false };
}

const START_LOCATION = 1; // Деревня

export async function ensureCharacter(accountId, wantedName) {
  const have = await game.query(
    `SELECT id FROM characters WHERE account_id = $1 AND status = 1 LIMIT 1`, [accountId]);
  if (have.rows[0]) return getCharacter(have.rows[0].id);

  const start = await gameConfig('character.start');
  // getCharacter читает через пул и не видит строку до COMMIT —
  // поэтому из транзакции возвращаем только id
  const id = await tx(async (c) => {
    let name = wantedName, n = 1;
    for (;;) {
      const black = await c.query(`SELECT 1 FROM name_blacklist WHERE name = $1`, [name]);
      const taken = await c.query(
        `SELECT 1 FROM characters WHERE world_id = 1 AND name = $1`, [name]);
      if (!black.rows[0] && !taken.rows[0]) break;
      name = `${wantedName}${++n}`;
    }
    const ins = await c.query(
      `INSERT INTO characters (account_id, name, faction, level, location_id, hp_cur)
       VALUES ($1, $2, 1, $3, $4, $5) RETURNING id`,
      [accountId, name, start.level, START_LOCATION, start.hp]);
    await c.query(`INSERT INTO character_stats (character_id) VALUES ($1)`,
      [ins.rows[0].id]);
    return ins.rows[0].id;
  });
  return getCharacter(id);
}

export async function getCharacter(id) {
  const { rows } = await game.query(
    `SELECT ch.id, ch.name, ch.level, ch.exp, ch.location_id, ch.hp_cur,
            l.name AS location_name
       FROM characters ch JOIN locations l ON l.id = ch.location_id
      WHERE ch.id = $1`, [id]);
  if (!rows[0]) return null;
  const ch = rows[0];
  const start = await gameConfig('character.start');
  const leveling = await levelingConfig();
  const progress = levelProgress(ch.exp, ch.level, leveling);
  ch.wallet = await wallet(game, ch.id);
  ch.exp = Number(ch.exp);
  ch.maxLevel = leveling.maxLevel;
  ch.xpTotal = ch.exp;
  ch.xp = progress.xp; ch.xpMax = progress.xpMax;
  ch.xpLevelStart = progress.currentThreshold;
  ch.xpNextTotal = progress.nextThreshold;
  ch.xpMaxed = progress.maxed;
  ch.pvpXp = ch.wallet.valor || 0; ch.pvpXpMax = start.pvp_xp_max;
  ch.combat = await combatProfileFor(ch.id, start);
  return ch;
}

/** Базовый боевой профиль из конфига character.start. */
export function combatProfile(start) {
  return { hp: start.hp, damage: start.damage, crit: start.crit,
           dodge: start.dodge, height: start.height };
}

/** Шанс (крит/уворот): доля 0..1; значения больше 1 считаем процентами. */
const asChance = (v) => {
  const n = Number(v) || 0;
  return n > 1 ? n / 100 : n;
};

/** Сумма base_stats надетых вещей (+10% за уровень заточки). */
async function equipmentBonus(charId) {
  const { rows } = await game.query(
    `SELECT t.base_stats, i.enchant_level FROM item_instances i
       JOIN item_templates t ON t.id = i.template_id
      WHERE i.owner_type = 2 AND i.owner_id = $1 AND i.status = 1`, [charId]);
  const bonus = { hp: 0, dmgMin: 0, dmgMax: 0, crit: 0, dodge: 0 };
  for (const r of rows) {
    const s = r.base_stats || {};
    const k = 1 + 0.1 * (r.enchant_level || 0);
    bonus.hp     += Math.round((Number(s.hp) || 0) * k);
    bonus.crit   += asChance(s.crit);
    bonus.dodge  += asChance(s.dodge);
    if (Array.isArray(s.damage)) {
      bonus.dmgMin += Math.round((Number(s.damage[0]) || 0) * k);
      bonus.dmgMax += Math.round((Number(s.damage[1]) || 0) * k);
    }
  }
  return bonus;
}

/** Итоговый боевой профиль: база + бонусы экипировки. С ним идёт бой. */
export async function combatProfileFor(charId, start) {
  const base = combatProfile(start);
  const b = await equipmentBonus(charId);
  return { ...base,
    hp: base.hp + b.hp,
    damage: [base.damage[0] + b.dmgMin, base.damage[1] + b.dmgMax],
    crit: Math.min(0.95, base.crit + b.crit),
    dodge: Math.min(0.75, base.dodge + b.dodge) };
}

export async function addExp(client, charId, amount) {
  const gain = Math.max(0, Math.trunc(Number(amount) || 0));
  const leveling = await levelingConfig();
  const capExp = leveling.thresholds[leveling.maxLevel - 1] ?? 0;
  const row = (await client.query(
    `SELECT level, exp FROM characters WHERE id = $1 FOR UPDATE`, [charId])).rows[0];
  if (!row || gain <= 0) {
    return { gained: 0, level: row ? Number(row.level) : null, leveledUp: false };
  }
  const oldLevel = Math.max(1, Math.min(leveling.maxLevel, Number(row.level) || 1));
  const oldExp = Math.max(0, Number(row.exp) || 0);
  const exp = Math.min(capExp, oldExp + gain);
  const level = levelForExp(exp, leveling);
  await client.query(
    `UPDATE characters SET exp = $2, level = $3 WHERE id = $1`, [charId, exp, level]);
  return { gained: Math.max(0, exp - oldExp), exp, level, oldLevel, leveledUp: level > oldLevel };
}

/** Публичная информация об игроке (для карточки «Информация» из чата/почты). */
export async function publicInfo({ id, name }) {
  const where = id ? `ch.id = $1` : `ch.name = $1`;
  const { rows } = await game.query(
    `SELECT ch.id, ch.name, ch.level, ch.faction, ch.location_id,
            l.name AS location_name, p.about
       FROM characters ch
       JOIN locations l ON l.id = ch.location_id
       LEFT JOIN character_profile p ON p.character_id = ch.id
      WHERE ${where} AND ch.status = 1`, [id || name]);
  const r = rows[0];
  if (!r) return null;
  // присутствие — из Redis (поддерживается при входе/выходе сокета)
  const online = await redis.hExists(`loc:${r.location_id}:players`, String(r.id))
    .catch(() => false);
  return {
    id: Number(r.id), name: r.name, level: r.level, faction: r.faction,
    location: r.location_name, about: r.about || '', online,
  };
}

export function characterRoutes(app, authed) {
  app.get('/api/me', authed, async (req, res) => {
    res.json(await getCharacter(req.session.character_id));
  });

  // публичная карточка игрока: по id (?id=) или по нику (?name=)
  app.get('/api/players/info', authed, async (req, res) => {
    const info = await publicInfo({
      id: Number(req.query.id) || null,
      name: req.query.name ? String(req.query.name) : null,
    });
    if (!info) return res.status(404).json({ error: 'not_found' });
    res.json(info);
  });
}
