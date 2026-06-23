import { game } from './db.js';

/**
 * Пояс боевых эликсиров. Сервер ПОМНИТ состав пояса персонажа (character_belt:
 * slot -> эликсир) и отдаёт его клиенту вместе с остатком каждого эликсира в
 * инвентаре. Параметры эффекта (kind/potency/turns) берутся из шаблона эликсира
 * (item_templates.base_stats.elixir) — клиент на них не влияет (анти-чит).
 * Расход заряда при использовании в бою — в manager.useElixir (FOR UPDATE + ledger).
 */
export const BELT_SLOTS = 6;
const err = (msg, status) => Object.assign(new Error(msg), { status });

// Сколько зарядов ОДНОГО расходника помещается в ОДНУ ячейку пояса (#1).
// Точное значение задаёт шаблон через base_stats.belt_max; здесь — лишь дефолты
// по виду. ДОЛЖНО совпадать с клиентом (content.js ELIXIR_BELT_CAP / beltCapFor).
const BELT_CAP = { health: 1, power: 10, mana: 1, blood: 3,
  escape: 1, poison: 1, heal_scroll: 1, cleanse: 1 };
function beltCapFor(kind, baseStats) {
  const s = baseStats || {};
  if (s.belt_max != null) return Math.max(1, Number(s.belt_max) || 1);
  return BELT_CAP[kind] ?? 1;
}

/**
 * Параметры боевого расходника из шаблона (base_stats), или null, если это не
 * боевой эликсир/свиток. Возвращает унифицированный {kind, ...параметры эффекта}.
 * Виды: escape · health(HoT) · power · mana · blood(крит) · poison(DoT) ·
 * heal_scroll(HoT) · cleanse(снятие). Старый формат {heal:N} (мгновенный) —
 * поддержан для совместимости.
 */
// Период дискретного тика эффекта по времени (сек): сколько ждать между
// порциями HoT/DoT/маны. Берётся из шаблона (base_stats.tick), иначе 5 c —
// эффект «как часы» (ТЗ #3). Длительность делит его на целое число шагов.
const DEFAULT_TICK = 5;
export function elixirParams(baseStats) {
  const s = baseStats || {};
  const num = (v, d) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
  const beltMax = s.belt_max != null ? Math.max(1, Number(s.belt_max) || 1) : null;
  const tick = Math.max(1, num(s.tick, DEFAULT_TICK));    // период тика, секунды
  if (s.escape) return { kind: 'escape', belt_max: beltMax };
  if (s.scroll === 'poison') return { kind: 'poison', dmg_pct: num(s.dmg_pct, 0.15),
    secs: num(s.secs, 120), cooldown: num(s.cooldown, 120), tick, belt_max: beltMax };
  if (s.scroll === 'heal') return { kind: 'heal_scroll', heal_pct: num(s.heal_pct, 0.15),
    secs: num(s.secs, 120), cooldown: num(s.cooldown, 120), tick, belt_max: beltMax };
  if (s.scroll === 'cleanse') return { kind: 'cleanse',
    removes: Array.isArray(s.removes) ? s.removes : ['poison', 'heal_scroll'],
    cooldown: num(s.cooldown, 90), belt_max: beltMax };
  if (s.kind === 'mana' || s.mana_pct != null) return { kind: 'mana',
    mana_pct: num(s.mana_pct, 0.2), secs: num(s.secs, 60), tick, belt_max: beltMax };
  if (s.kind === 'blood' || s.crit_add != null) return { kind: 'blood',
    crit_add: num(s.crit_add, 0.2), turns: num(s.turns, 1), belt_max: beltMax };
  if (s.heal_pct != null) return { kind: 'health', heal_pct: num(s.heal_pct, 0.2),
    secs: num(s.secs, 60), tick, belt_max: beltMax };
  if (s.heal != null) return { kind: 'health', heal: Number(s.heal) || 0, belt_max: beltMax };
  if (s.power_mult != null) return { kind: 'power',
    mult: num(s.power_mult, 1.3), turns: num(s.power_turns, 3), belt_max: beltMax };
  return null;
}

/** Сколько эликсиров шаблона есть в рюкзаке персонажа (для лимита надевания). */
async function ownedQty(charId, templateId) {
  return Number((await game.query(
    `SELECT COALESCE(SUM(quantity), 0) AS qty FROM item_instances
      WHERE owner_id = $1 AND owner_type = 1 AND status = 1 AND template_id = $2`,
    [charId, templateId])).rows[0].qty);
}

/** Состав пояса персонажа: для каждой ячейки — шаблон, вид, заряды и вместимость. */
export async function getBelt(charId) {
  const { rows } = await game.query(
    `SELECT b.slot, b.template_id, b.quantity, t.name, t.icon, t.base_stats, t.quality
       FROM character_belt b JOIN item_templates t ON t.id = b.template_id
      WHERE b.character_id = $1 ORDER BY b.slot`, [charId]);
  const out = new Array(BELT_SLOTS).fill(null);
  for (const r of rows) {
    const slot = Number(r.slot);
    if (slot < 0 || slot >= BELT_SLOTS) continue;
    const el = elixirParams(r.base_stats) || { kind: 'health' };
    out[slot] = { slot, templateId: r.template_id, name: r.name, icon: r.icon,
      kind: el.kind, qty: Number(r.quantity),
      cap: beltCapFor(el.kind, r.base_stats), quality: Number(r.quality) || 1 };
  }
  return out;
}

/**
 * Надеть один заряд эликсира в пояс. Один заряд за вызов.
 *  - вместимость ячейки ограничена (#1): мощь стопкой до beltCapFor, жизнь — по 1;
 *  - targetSlot задан (#4): кладём ИМЕННО в эту ячейку (пустую — занять; со
 *    своим эликсиром ниже лимита — долить; иначе slot_occupied);
 *  - targetSlot не задан: доливаем первую недозаполненную свою ячейку, иначе
 *    занимаем первую свободную;
 *  - нельзя надеть больше, чем лежит в рюкзаке (SUM(quantity по шаблону) ≤ есть).
 */
export async function addToBelt(charId, templateId, targetSlot = null) {
  templateId = Number(templateId);
  const t = (await game.query(
    `SELECT type, base_stats FROM item_templates WHERE id = $1`, [templateId])).rows[0];
  if (!t || t.type !== 4) throw err('not_an_elixir', 400);
  const el = elixirParams(t.base_stats);
  if (!el) throw err('not_an_elixir', 400);
  const cap = beltCapFor(el.kind, t.base_stats);

  const owned = await ownedQty(charId, templateId);
  if (owned <= 0) throw err('not_owned', 400);
  // полный состав пояса (все шаблоны) — для проверки занятости целевой ячейки
  const all = (await game.query(
    `SELECT slot, template_id, quantity FROM character_belt WHERE character_id = $1`,
    [charId])).rows.map((r) => ({ slot: Number(r.slot),
      templateId: Number(r.template_id), quantity: Number(r.quantity) }));
  const mine = all.filter((r) => r.templateId === templateId);
  const reserved = mine.reduce((n, r) => n + r.quantity, 0);
  if (reserved >= owned) throw err('not_enough', 400);          // надето уже всё, что есть

  // --- явная целевая ячейка (#4) ---
  if (targetSlot != null) {
    const slot = Number(targetSlot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= BELT_SLOTS) throw err('bad_slot', 400);
    const cur = all.find((r) => r.slot === slot);
    if (!cur) {
      await game.query(
        `INSERT INTO character_belt (character_id, slot, template_id, quantity)
         VALUES ($1, $2, $3, 1)`, [charId, slot, templateId]);
    } else if (cur.templateId === templateId && cur.quantity < cap) {
      await game.query(
        `UPDATE character_belt SET quantity = quantity + 1
          WHERE character_id = $1 AND slot = $2`, [charId, slot]);
    } else {
      throw err('slot_occupied', 400);
    }
    return getBelt(charId);
  }

  // --- авторазмещение: сначала долить свою недозаполненную ячейку ---
  const stackable = mine.find((r) => r.quantity < cap);
  if (stackable) {
    await game.query(
      `UPDATE character_belt SET quantity = quantity + 1
        WHERE character_id = $1 AND slot = $2`, [charId, stackable.slot]);
    return getBelt(charId);
  }
  // иначе — первая свободная ячейка
  const used = new Set(all.map((r) => r.slot));
  let slot = -1;
  for (let i = 0; i < BELT_SLOTS; i++) if (!used.has(i)) { slot = i; break; }
  if (slot === -1) throw err('belt_full', 400);
  await game.query(
    `INSERT INTO character_belt (character_id, slot, template_id, quantity)
     VALUES ($1, $2, $3, 1)`, [charId, slot, templateId]);
  return getBelt(charId);
}

/** Освободить ячейку пояса. */
export async function clearBeltSlot(charId, slot) {
  await game.query(`DELETE FROM character_belt WHERE character_id = $1 AND slot = $2`,
    [charId, Number(slot)]);
  return getBelt(charId);
}

export function beltRoutes(app, authed) {
  app.get('/api/belt', authed, async (req, res) =>
    res.json(await getBelt(req.session.character_id)));
  app.post('/api/belt/equip', authed, async (req, res) =>
    res.json(await addToBelt(req.session.character_id, req.body.templateId,
      req.body.slot != null ? req.body.slot : null)));
  app.post('/api/belt/unequip', authed, async (req, res) =>
    res.json(await clearBeltSlot(req.session.character_id, req.body.slot)));
}
