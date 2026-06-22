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

// Сколько зарядов ОДНОГО эликсира помещается в ОДНУ ячейку пояса (#1).
// Жизнь и побег — по одному, мощь — стопкой до 10. Шаблон может переопределить через
// base_stats.belt_max. ДОЛЖНО совпадать с клиентом (content.js ELIXIR_BELT_CAP).
const BELT_CAP = { health: 1, power: 10, escape: 1 };
function beltCapFor(kind, baseStats) {
  const s = baseStats || {};
  if (s.belt_max != null) return Math.max(1, Number(s.belt_max) || 1);
  return BELT_CAP[kind] ?? 1;
}

/**
 * Параметры боевого эликсира из шаблона (base_stats), или null, если это не
 * боевой бафф/хил/побег.
 * Формат как в сидах: здоровье {heal:N} (абсолютное лечение), мощь
 * {power_mult:M, power_turns:T} (множитель урона на T ударов).
 */
export function elixirParams(baseStats) {
  const s = baseStats || {};
  if (s.escape) return { kind: 'escape' };
  if (s.heal != null) return { kind: 'health', heal: Number(s.heal) || 0 };
  if (s.power_mult != null) return { kind: 'power',
    mult: Number(s.power_mult) || 1.3, turns: Number(s.power_turns) || 3 };
  return null;
}

/** Сколько эликсиров шаблона есть в рюкзаке персонажа (для лимита надевания). */
async function ownedQty(charId, templateId) {
  return Number((await game.query(
    `SELECT COALESCE(SUM(quantity), 0) AS qty FROM item_instances
      WHERE owner_id = $1 AND owner_type = 1 AND status = 1 AND template_id = $2`,
    [charId, templateId])).rows[0].qty);
}

/** Состав пояса персонажа: для каждой ячейки — шаблон, вид и заряды (quantity). */
export async function getBelt(charId) {
  const { rows } = await game.query(
    `SELECT b.slot, b.template_id, b.quantity, t.name, t.icon, t.base_stats
       FROM character_belt b JOIN item_templates t ON t.id = b.template_id
      WHERE b.character_id = $1 ORDER BY b.slot`, [charId]);
  const out = new Array(BELT_SLOTS).fill(null);
  for (const r of rows) {
    const slot = Number(r.slot);
    if (slot < 0 || slot >= BELT_SLOTS) continue;
    const el = elixirParams(r.base_stats) || { kind: 'health' };
    out[slot] = { slot, templateId: r.template_id, name: r.name, icon: r.icon,
      kind: el.kind, qty: Number(r.quantity) };
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
