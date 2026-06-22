import { randomUUID } from 'crypto';
import { game, tx } from './db.js';
import { addCurrency, CUR, wallet } from './economy.js';
import { getInventory } from './inventory.js';

const SHOP_LOCATION_ID = 1;
const SHOP_ELIXIRS = [201, 202, 203];
const ITEM_REASON_SHOP = 12;

const err = (msg, status) => Object.assign(new Error(msg), { status });

function elixirKind(baseStats) {
  const s = baseStats || {};
  if (s.escape) return 'escape';
  if (s.power_mult != null) return 'power';
  if (s.heal != null) return 'health';
  return 'elixir';
}

function describeElixir(row) {
  const s = row.base_stats || {};
  if (s.escape) return 'Позволяет покинуть бой без обычного выхода.';
  if (s.power_mult != null) {
    const pct = Math.round((Number(s.power_mult) - 1) * 100);
    const turns = Number(s.power_turns) || 3;
    return `Урон +${pct}% на ${turns} хода.`;
  }
  if (s.heal != null) return `Восстанавливает ${Number(s.heal) || 0} HP в бою.`;
  return 'Боевой расходник.';
}

function product(row) {
  return {
    templateId: Number(row.id),
    name: row.name,
    icon: row.icon,
    price: Number(row.price) || 0,
    kind: elixirKind(row.base_stats),
    description: describeElixir(row),
  };
}

async function assertInShopLocation(client, charId) {
  const ch = (await client.query(
    `SELECT location_id FROM characters WHERE id = $1 AND status = 1`, [charId])).rows[0];
  if (!ch) throw err('not_found', 404);
  if (Number(ch.location_id) !== SHOP_LOCATION_ID) throw err('shop_unavailable', 403);
}

async function shopProducts(client = game) {
  const { rows } = await client.query(
    `SELECT id, name, icon, base_stats, price
       FROM item_templates
      WHERE id = ANY($1::int[]) AND type = 4 AND sellable = TRUE
      ORDER BY id`, [SHOP_ELIXIRS]);
  return rows.map(product);
}

export async function getShop(charId) {
  await assertInShopLocation(game, charId);
  return { locationId: SHOP_LOCATION_ID, items: await shopProducts(game) };
}

export async function buyShopItem(charId, templateId, quantity) {
  const qty = Math.max(1, Math.min(99, Math.trunc(Number(quantity) || 1)));
  const tplId = Number(templateId);
  if (!Number.isInteger(tplId)) throw err('not_for_sale', 400);
  let bought;

  await tx(async (c) => {
    await assertInShopLocation(c, charId);
    const row = (await c.query(
      `SELECT id, name, icon, type, stackable, base_stats, price, sellable
         FROM item_templates
        WHERE id = $1 AND id = ANY($2::int[])`,
      [tplId, SHOP_ELIXIRS])).rows[0];
    if (!row || row.type !== 4 || row.sellable === false) throw err('not_for_sale', 404);
    const price = Number(row.price) || 0;
    if (price <= 0) throw err('not_for_sale', 404);
    const cost = price * qty;

    await addCurrency(c, charId, CUR.copper, -cost, 4,
      { idempotencyKey: randomUUID(), type: null, id: null });

    const ins = await c.query(
      `INSERT INTO item_instances (template_id, owner_type, owner_id, quantity)
       VALUES ($1, 1, $2, $3) RETURNING id`,
      [tplId, charId, row.stackable === false ? 1 : qty]);
    await c.query(
      `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id,
          quantity, from_owner_type, from_owner_id, to_owner_type, to_owner_id,
          reason, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, 8, 0, 1, $5, $6, NULL, NULL)`,
      [randomUUID(), ins.rows[0].id, tplId, row.stackable === false ? 1 : qty,
       charId, ITEM_REASON_SHOP]);

    bought = { ...product(row), quantity: row.stackable === false ? 1 : qty, cost };
  });

  return {
    ok: true,
    bought,
    wallet: await wallet(game, charId),
    inventory: await getInventory(charId),
  };
}

export function shopRoutes(app, authed) {
  app.get('/api/shop', authed, async (req, res) =>
    res.json(await getShop(req.session.character_id)));
  app.post('/api/shop/buy', authed, async (req, res) =>
    res.json(await buyShopItem(req.session.character_id,
      req.body?.templateId, req.body?.quantity)));
}
