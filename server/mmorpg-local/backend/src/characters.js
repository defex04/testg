import { game, tx, gameConfig } from './db.js';
import { wallet } from './economy.js';

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
  ch.wallet = await wallet(game, ch.id);
  ch.xp = Number(ch.exp); ch.xpMax = start.xp_max;
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
  await client.query(
    `UPDATE characters SET exp = exp + $2 WHERE id = $1`, [charId, amount]);
}

export function characterRoutes(app, authed) {
  app.get('/api/me', authed, async (req, res) => {
    res.json(await getCharacter(req.session.character_id));
  });
}
