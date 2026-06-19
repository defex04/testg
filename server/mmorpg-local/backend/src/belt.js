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

/**
 * Параметры боевого эликсира из шаблона (base_stats), или null, если это не
 * боевой бафф/хил (напр. Эликсир побега {escape:true} — в пояс не кладётся).
 * Формат как в сидах: здоровье {heal:N} (абсолютное лечение), мощь
 * {power_mult:M, power_turns:T} (множитель урона на T ударов).
 */
export function elixirParams(baseStats) {
  const s = baseStats || {};
  if (s.heal != null) return { kind: 'health', heal: Number(s.heal) || 0 };
  if (s.power_mult != null) return { kind: 'power',
    mult: Number(s.power_mult) || 1.3, turns: Number(s.power_turns) || 3 };
  return null;
}

/** Состав пояса персонажа + остаток каждого эликсира в инвентаре (массив ячеек). */
export async function getBelt(charId) {
  const { rows } = await game.query(
    `SELECT b.slot, b.template_id, t.name, t.icon, t.base_stats,
            COALESCE((SELECT SUM(quantity) FROM item_instances i
                       WHERE i.owner_id = $1 AND i.owner_type = 1 AND i.status = 1
                         AND i.template_id = b.template_id), 0) AS qty
       FROM character_belt b JOIN item_templates t ON t.id = b.template_id
      WHERE b.character_id = $1 ORDER BY b.slot`, [charId]);
  const out = new Array(BELT_SLOTS).fill(null);
  for (const r of rows) {
    const slot = Number(r.slot);
    if (slot < 0 || slot >= BELT_SLOTS) continue;
    const el = elixirParams(r.base_stats) || { kind: 'health' };
    out[slot] = { slot, templateId: r.template_id, name: r.name, icon: r.icon,
      kind: el.kind, qty: Number(r.qty) };
  }
  return out;
}

/** Положить эликсир в ячейку пояса (валидируем владение и тип). */
export async function setBeltSlot(charId, slot, templateId) {
  slot = Number(slot); templateId = Number(templateId);
  if (!(slot >= 0 && slot < BELT_SLOTS)) throw err('bad_slot', 400);
  const t = (await game.query(
    `SELECT type, base_stats FROM item_templates WHERE id = $1`, [templateId])).rows[0];
  if (!t || t.type !== 4 || !elixirParams(t.base_stats)) throw err('not_an_elixir', 400);
  const owned = (await game.query(
    `SELECT 1 FROM item_instances WHERE owner_id = $1 AND owner_type = 1
        AND status = 1 AND template_id = $2 LIMIT 1`, [charId, templateId])).rows[0];
  if (!owned) throw err('not_owned', 400);
  await game.query(
    `INSERT INTO character_belt (character_id, slot, template_id) VALUES ($1, $2, $3)
     ON CONFLICT (character_id, slot) DO UPDATE SET template_id = EXCLUDED.template_id`,
    [charId, slot, templateId]);
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
    res.json(await setBeltSlot(req.session.character_id, req.body.slot, req.body.templateId)));
  app.post('/api/belt/unequip', authed, async (req, res) =>
    res.json(await clearBeltSlot(req.session.character_id, req.body.slot)));
}
