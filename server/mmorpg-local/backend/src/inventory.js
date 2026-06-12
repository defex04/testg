import { randomUUID } from 'crypto';
import { game, tx } from './db.js';

const OWNER = { inventory: 1, equipment: 2 };
const REASON = { admin: 11 };

export async function getInventory(charId) {
  const { rows } = await game.query(
    `SELECT i.id, i.template_id, i.owner_type, i.slot, i.quantity, i.enchant_level,
            t.name, t.icon, t.slot AS equip_slot, t.type, t.base_stats
       FROM item_instances i JOIN item_templates t ON t.id = i.template_id
      WHERE i.owner_id = $1 AND i.owner_type IN (1, 2) AND i.status = 1
      ORDER BY i.id`, [charId]);
  return rows.map(r => ({
    id: r.id, templateId: r.template_id, name: r.name, icon: r.icon,
    type: r.type, slot: r.equip_slot, quantity: r.quantity,
    enchant: r.enchant_level, stats: r.base_stats,
    equipped: r.owner_type === OWNER.equipment,
  }));
}

async function moveItem(c, item, toType, toSlot, reason, refId) {
  const upd = await c.query(
    `UPDATE item_instances
        SET owner_type = $2, slot = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $4`,
    [item.id, toType, toSlot, item.version]);
  if (upd.rowCount === 0) throw Object.assign(new Error('conflict'), { status: 409 });
  await c.query(
    `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id, quantity,
        from_owner_type, from_owner_id, to_owner_type, to_owner_id, reason, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $8, $9)`,
    [randomUUID(), item.id, item.template_id, item.quantity,
     item.owner_type, item.owner_id, toType, reason, refId ?? null]);
}

export async function equip(charId, itemId) {
  await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT i.*, t.slot AS equip_slot FROM item_instances i
         JOIN item_templates t ON t.id = i.template_id
        WHERE i.id = $1 AND i.owner_id = $2 AND i.status = 1 FOR UPDATE OF i`,
      [itemId, charId]);
    const item = rows[0];
    if (!item) throw Object.assign(new Error('not_found'), { status: 404 });
    if (item.equip_slot == null) throw Object.assign(new Error('not_equippable'), { status: 400 });
    if (item.owner_type === 2 && item.slot === item.equip_slot) return;  // уже надето

    // требования шаблона (уровень и т.п.)
    const req = (await c.query(
      `SELECT t.requirements, t.level_req, ch.level
         FROM item_templates t, characters ch
        WHERE t.id = $1 AND ch.id = $2`, [item.template_id, charId])).rows[0];
    const minLevel = Math.max(Number(req.level_req) || 1,
      Number((req.requirements || {}).level) || 1);
    if (req.level < minLevel) {
      throw Object.assign(new Error('level_too_low'), { status: 400 });
    }

    // активная травма на часть тела запрещает надеть вещь (правило из схемы)
    const injured = await c.query(
      `SELECT 1 FROM character_injuries
        WHERE character_id = $1 AND body_part = $2 AND status = 1`,
      [charId, item.equip_slot]);
    if (injured.rows[0]) throw Object.assign(new Error('injured'), { status: 400 });

    // снять то, что в слоте
    const worn = await c.query(
      `SELECT * FROM item_instances
        WHERE owner_type = 2 AND owner_id = $1 AND slot = $2 AND status = 1
          AND id <> $3 FOR UPDATE`,
      [charId, item.equip_slot, item.id]);
    if (worn.rows[0]) await moveItem(c, worn.rows[0], OWNER.inventory, null, REASON.admin);

    if (item.owner_type !== OWNER.equipment) {
      await moveItem(c, item, OWNER.equipment, item.equip_slot, REASON.admin);
    }
  });
  return getInventory(charId);   // читаем уже закоммиченное состояние
}

export async function unequip(charId, slot) {
  await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM item_instances
        WHERE owner_type = 2 AND owner_id = $1 AND slot = $2 AND status = 1 FOR UPDATE`,
      [charId, slot]);
    if (rows[0]) await moveItem(c, rows[0], OWNER.inventory, null, REASON.admin);
  });
  return getInventory(charId);
}

/** Выдать стартовый предмет (бронзовый доспех), если у персонажа пусто. */
export async function grantStarterItems(charId) {
  const has = await game.query(
    `SELECT 1 FROM item_instances WHERE owner_id = $1 AND owner_type IN (1,2) LIMIT 1`,
    [charId]);
  if (has.rows[0]) return;
  await tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO item_instances (template_id, owner_type, owner_id)
       VALUES (101, 1, $1) RETURNING id`, [charId]);
    await c.query(
      `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id, quantity,
          to_owner_type, to_owner_id, reason)
       VALUES ($1, $2, 101, 1, 1, $3, 2)`, [randomUUID(), ins.rows[0].id, charId]);
  });
}

export function inventoryRoutes(app, authed) {
  app.get('/api/inventory', authed, async (req, res) =>
    res.json(await getInventory(req.session.character_id)));
  app.post('/api/inventory/equip', authed, async (req, res) =>
    res.json(await equip(req.session.character_id, Number(req.body.itemId))));
  app.post('/api/inventory/unequip', authed, async (req, res) =>
    res.json(await unequip(req.session.character_id, Number(req.body.slot))));
}
