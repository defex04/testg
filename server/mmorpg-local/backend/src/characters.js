import { game, tx, gameConfig, redis } from './db.js';
import { wallet } from './economy.js';
import { composeFromEquipment } from './battle/gear.js';

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
  // школа треугольника, очки распределения и модельные характеристики (экран «ПАРАМЕТРЫ»)
  const sr = (await game.query(
    `SELECT str, agi, vit, intel, wis, free_points FROM character_stats WHERE character_id = $1`,
    [ch.id])).rows[0] || null;
  ch.attrs = sr ? { str: Number(sr.str), agi: Number(sr.agi), vit: Number(sr.vit),
                    intel: Number(sr.intel), wis: Number(sr.wis) } : null;
  ch.freePoints = sr ? Number(sr.free_points) || 0 : 0;
  const model = await combatModelFor(ch.id, ch.level).catch(() => null);
  ch.school = model ? model.school : null;
  ch.params = model ? model.stats : null;
  ch.setBonus = model ? model.setBonus : 1;   // ×1.05 свой класс / ×0.85 разные / ×1 нейтр.
  ch.buff = await livingWaterStatus(ch.id).catch(() => ({ active: false }));
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
    bonus.hp     += Math.round((Number(s.hp ?? s.health) || 0) * k);
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

/** Школа треугольника из распределения атрибутов: str→Натиск, agi→Уклон, vit→Оплот.
 *  Нули/равенство → Натиск (нейтральный угол). См. battle/stats.js SCHOOLS. */
export function schoolFromStats(s) {
  const cand = [['natisk', Number(s?.str) || 0], ['uklon', Number(s?.agi) || 0], ['oplot', Number(s?.vit) || 0]];
  cand.sort((a, b) => b[1] - a[1]);              // стабильно: при равенстве Натиск раньше
  return cand[0][1] > 0 ? cand[0][0] : 'natisk';
}

/**
 * Боевой блок модели «Broken Sun» для ЖИВОГО боя (треугольник): школа из атрибутов
 * персонажа + сборка из РЕАЛЬНО надетой экипировки (composeFromEquipment). Сила очков
 * берётся автоматически по уровню (чтобы аллокация не ослабляла игрока — она задаёт
 * ШКОЛУ, см. schoolFromStats), а укомплектованность/качество — из надетых предметов.
 * Возвращает форму дефа бойца движка: { hp, stats, statNorm, school }.
 */
// «Живая вода»: бафф вне боя на 10 минут реального времени, +10% к HP и урону (Мощи).
// Хранится в Redis с TTL (сам истекает); применяется в combatModelFor — значит и в
// панели «Параметры», и в живом бою. Повторное «испить» сбрасывает таймер на 10 мин.
const LIVING_WATER_SEC = 600;
const LIVING_WATER_PCT = 10;            // +10%
const lwKey = (id) => `char:${id}:buff:livingwater`;

/** Испить живой воды: ставит/обновляет бафф на 10 минут. */
export async function drinkLivingWater(charId) {
  const expiresAt = Date.now() + LIVING_WATER_SEC * 1000;
  await redis.set(lwKey(charId), String(expiresAt), { EX: LIVING_WATER_SEC });
  return { ok: true, buff: { kind: 'livingWater', hpPct: LIVING_WATER_PCT,
    dmgPct: LIVING_WATER_PCT, secs: LIVING_WATER_SEC, expiresAt } };
}

/** Статус баффа: { active, remainSec } по TTL ключа в Redis. */
export async function livingWaterStatus(charId) {
  const ttl = await redis.ttl(lwKey(charId)).catch(() => -2);
  return ttl > 0
    ? { active: true, kind: 'livingWater', hpPct: LIVING_WATER_PCT, dmgPct: LIVING_WATER_PCT, remainSec: ttl }
    : { active: false };
}

/** Множитель активных вне-боевых баффов к HP/Мощи (сейчас только «живая вода»). */
async function buffMult(charId) {
  const s = await livingWaterStatus(charId);
  return s.active ? 1 + LIVING_WATER_PCT / 100 : 1;
}

export async function combatModelFor(charId, level) {
  const [statRow, eq, mult] = await Promise.all([
    game.query(`SELECT str, agi, vit FROM character_stats WHERE character_id = $1`, [charId])
      .then((q) => q.rows[0]),
    game.query(
      `SELECT t.slot, t.quality, t.base_stats, i.enchant_level FROM item_instances i
         JOIN item_templates t ON t.id = i.template_id
        WHERE i.owner_type = 2 AND i.owner_id = $1 AND i.status = 1 AND t.slot IS NOT NULL`,
      [charId]).then((q) => q.rows),
    buffMult(charId),
  ]);
  const school = schoolFromStats(statRow);
  // атрибуты усиливают «свои» статы: Сила→Мощь(урон), Ловкость→Уклон/Крит, Выносл→HP/Защита
  const attrs = statRow ? { str: Number(statRow.str) || 0, agi: Number(statRow.agi) || 0, vit: Number(statRow.vit) || 0 } : null;
  const built = composeFromEquipment(school, { level: Number(level) || 1, items: eq, attrs });
  // сет-бонус по КЛАССУ вещей: всё своего класса → +5%, разные классы → −15% ко ВСЕМ статам
  const set = setBonus(eq, school);
  if (set !== 1) for (const k of Object.keys(built.stats)) built.stats[k] = Math.max(1, Math.round(built.stats[k] * set));
  if (mult !== 1) {                     // «живая вода»: +10% к HP и Мощи (→ +10% урона)
    built.stats.health = Math.max(1, Math.round(built.stats.health * mult));
    built.stats.power = Math.max(1, Math.round(built.stats.power * mult));
  }
  return { hp: built.stats.health, stats: built.stats, statNorm: built.statNorm,
           school, setBonus: set, damage: [1, 1] };
}

/**
 * Сет-бонус по классам надетых вещей (классы — в base_stats.cls):
 *  - всё своего класса (= школа) → ×1.05 (+5%);
 *  - надеты вещи РАЗНЫХ классов → ×0.85 (−15%);
 *  - один класс, но не твой / нет классовых вещей → ×1.0.
 */
export function setBonus(equipItems, school) {
  const classes = (equipItems || []).map((it) => it.base_stats && it.base_stats.cls).filter(Boolean);
  if (!classes.length) return 1;
  const uniq = new Set(classes);
  if (uniq.size > 1) return 0.85;
  return [...uniq][0] === school ? 1.05 : 1;
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
  // очки распределения: +POINTS_PER_LEVEL за каждый набранный уровень (выбор школы/угла)
  if (level > oldLevel) {
    await client.query(
      `UPDATE character_stats SET free_points = free_points + $2 WHERE character_id = $1`,
      [charId, POINTS_PER_LEVEL * (level - oldLevel)]);
  }
  return { gained: Math.max(0, exp - oldExp), exp, level, oldLevel, leveledUp: level > oldLevel };
}

export const POINTS_PER_LEVEL = 10;
const ALLOC_ATTRS = ['str', 'agi', 'vit', 'intel', 'wis'];

/**
 * Распределить ОДНО очко в атрибут (str/agi/vit/intel/wis), списав 1 free_point.
 * Атрибуты задают ШКОЛУ треугольника (str→Натиск, agi→Уклон, vit→Оплот, см.
 * schoolFromStats). Возвращает обновлённые атрибуты + остаток очков.
 */
export async function allocateStat(charId, attr, amount = 1) {
  if (!ALLOC_ATTRS.includes(attr)) throw Object.assign(new Error('bad_attr'), { status: 400 });
  const n = Math.max(1, Math.min(1000, Math.trunc(Number(amount) || 1)));
  return tx(async (c) => {
    const row = (await c.query(
      `SELECT free_points FROM character_stats WHERE character_id = $1 FOR UPDATE`, [charId])).rows[0];
    if (!row) throw Object.assign(new Error('no_stats'), { status: 404 });
    if ((Number(row.free_points) || 0) < n) throw Object.assign(new Error('not_enough_points'), { status: 400 });
    const upd = (await c.query(
      `UPDATE character_stats SET ${attr} = ${attr} + $2, free_points = free_points - $2
        WHERE character_id = $1 RETURNING str, agi, vit, intel, wis, free_points`,
      [charId, n])).rows[0];
    return { str: Number(upd.str), agi: Number(upd.agi), vit: Number(upd.vit),
             intel: Number(upd.intel), wis: Number(upd.wis),
             freePoints: Number(upd.free_points), school: schoolFromStats(upd) };
  });
}

/** Публичная информация об игроке (для карточки «Информация» из чата/почты).
 *  Кроме базовых полей отдаёт надетые вещи, характеристики и статистику боёв (#B2). */
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
  const charId = Number(r.id);
  // присутствие — из Redis (поддерживается при входе/выходе сокета)
  const online = await redis.hExists(`loc:${r.location_id}:players`, String(charId))
    .catch(() => false);

  const start = await gameConfig('character.start');
  // надетые вещи, базовые характеристики, боевой профиль, МОДЕЛЬНЫЕ статы и сводка — параллельно
  const [equipRows, statRow, combat, modelRow, recRow] = await Promise.all([
    game.query(
      `SELECT t.name, t.icon, t.slot AS equip_slot, t.type, t.base_stats,
              i.enchant_level
         FROM item_instances i JOIN item_templates t ON t.id = i.template_id
        WHERE i.owner_type = 2 AND i.owner_id = $1 AND i.status = 1
        ORDER BY t.slot`, [charId]).then((q) => q.rows),
    game.query(
      `SELECT str, agi, vit, intel, wis, free_points FROM character_stats WHERE character_id = $1`,
      [charId]).then((q) => q.rows[0] || null),
    combatProfileFor(charId, start).catch(() => null),
    combatModelFor(charId, r.level).catch(() => null),
    game.query(
      `SELECT count(*) AS battles,
              count(*) FILTER (WHERE result = 1) AS wins,
              count(*) FILTER (WHERE result = 2) AS losses,
              count(*) FILTER (WHERE result = 3) AS draws,
              coalesce(sum(kills), 0)  AS kills,
              coalesce(sum(deaths), 0) AS deaths
         FROM battle_participants WHERE character_id = $1`, [charId])
      .then((q) => q.rows[0]),
  ]);

  const equipment = equipRows.map((e) => ({
    slot: e.equip_slot, name: e.name, icon: e.icon, type: e.type,
    enchant: Number(e.enchant_level) || 0,
  }));
  const stats = statRow ? {
    str: Number(statRow.str), agi: Number(statRow.agi), vit: Number(statRow.vit),
    intel: Number(statRow.intel), wis: Number(statRow.wis),
  } : null;
  const record = {
    battles: Number(recRow.battles) || 0, wins: Number(recRow.wins) || 0,
    losses: Number(recRow.losses) || 0, draws: Number(recRow.draws) || 0,
    kills: Number(recRow.kills) || 0, deaths: Number(recRow.deaths) || 0,
  };
  return {
    id: charId, name: r.name, level: r.level, faction: r.faction,
    location: r.location_name, about: r.about || '', online,
    stats, equipment, record,
    combat: combat ? {
      hp: combat.hp, dmgMin: combat.damage?.[0] ?? 0, dmgMax: combat.damage?.[1] ?? 0,
      crit: combat.crit, dodge: combat.dodge,
    } : null,
    // модельные характеристики (экран «ПАРАМЕТРЫ»): школа треугольника + 14 статов
    school: modelRow ? modelRow.school : null,
    params: modelRow ? modelRow.stats : null,
    freePoints: statRow ? Number(statRow.free_points) || 0 : 0,
  };
}

export function characterRoutes(app, authed) {
  app.get('/api/me', authed, async (req, res) => {
    res.json(await getCharacter(req.session.character_id));
  });

  // распределить очки в атрибут (str/agi/vit/intel/wis) — задаёт школу треугольника
  app.post('/api/character/allocate', authed, async (req, res) => {
    try {
      const out = await allocateStat(req.session.character_id,
        String(req.body.attr), Number(req.body.amount) || 1);
      res.json(out);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'error' });
    }
  });

  // испить живой воды: бафф +10% HP/урона на 10 минут (вне боя, действие локации)
  app.post('/api/character/drink', authed, async (req, res) => {
    try {
      res.json(await drinkLivingWater(req.session.character_id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'error' });
    }
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
