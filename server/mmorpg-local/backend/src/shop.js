import { randomUUID } from 'crypto';
import { game, tx } from './db.js';
import { addCurrency, CUR, wallet } from './economy.js';
import { getInventory } from './inventory.js';
import { elixirParams } from './belt.js';

const SHOP_LOCATION_ID = 1;
const ITEM_REASON_SHOP = 12;

const err = (msg, status) => Object.assign(new Error(msg), { status });
const pct = (v) => Math.round((Number(v) || 0) * 100);

/** Описание товара по виду эффекта (для карточки в магазине). */
function describeElixir(baseStats) {
  const p = elixirParams(baseStats);
  if (!p) return 'Боевой расходник.';
  switch (p.kind) {
    case 'escape':   return 'Позволяет покинуть бой без обычного выхода.';
    case 'health':   return p.heal_pct != null
      ? `Восстанавливает ${pct(p.heal_pct)}% здоровья за ${p.secs} c (каждые ${p.tick} c).`
      : `Восстанавливает ${p.heal} HP в бою.`;
    case 'mana':     return `Восстанавливает ${pct(p.mana_pct)}% маны за ${p.secs} c (каждые ${p.tick} c).`;
    case 'power':    return `Урон +${pct(p.mult - 1)}% на ${p.turns} х.`;
    case 'blood':    return `Шанс крита +${pct(p.crit_add)}% на ${p.turns} х.`;
    case 'poison':   return `Отравляет цель: −${pct(p.dmg_pct)}% HP за ${p.secs} c (каждые ${p.tick} c, тайм-аут ${p.cooldown} c).`;
    case 'heal_scroll': return `Исцеляет цель: +${pct(p.heal_pct)}% HP за ${p.secs} c (каждые ${p.tick} c, тайм-аут ${p.cooldown} c).`;
    case 'cleanse':  return `Снимает отравление и исцеление с цели (тайм-аут ${p.cooldown} c).`;
    default:         return 'Боевой расходник.';
  }
}

// слот игры (item_templates.slot) → название (для описания вещи в магазине)
const SLOT_NAME = { 1: 'Доспех', 2: 'Шлем', 3: 'Поножи', 4: 'Ботинки', 5: 'Наручи',
  6: 'Плечи', 7: 'Оружие', 8: 'Щит', 9: 'Кольчуга', 10: 'Амулет' };
function describeGear(type, slot) {
  const where = SLOT_NAME[Number(slot)] || (type === 1 ? 'оружие' : 'броня');
  return `Экипировка · ${where}.`;
}

function product(row) {
  const type = Number(row.type);
  if (type === 1 || type === 2 || type === 5) {   // экипировка: оружие/броня/амулет
    return {
      templateId: Number(row.id), name: row.name, icon: row.icon,
      price: Number(row.price) || 0, quality: Number(row.quality) || 1,
      levelReq: Number(row.level_req) || 1,
      kind: type === 1 ? 'weapon' : type === 5 ? 'amulet' : 'armor',
      slot: row.slot != null ? Number(row.slot) : null,
      cls: row.base_stats ? row.base_stats.cls || null : null,   // класс вещи (natisk/uklon/oplot)
      stats: row.base_stats || null,              // характеристики предмета (модель) — для витрины
      description: describeGear(type, row.slot),
    };
  }
  const p = elixirParams(row.base_stats);
  return {
    templateId: Number(row.id),
    name: row.name,
    icon: row.icon,
    price: Number(row.price) || 0,
    quality: Number(row.quality) || 1,
    levelReq: Number(row.level_req) || 1,
    kind: p ? p.kind : 'elixir',
    description: describeElixir(row.base_stats),
  };
}

/** Проверяет, что персонаж в локации с магазином; возвращает его строку. */
async function shopCharacter(client, charId) {
  const ch = (await client.query(
    `SELECT id, level, location_id FROM characters WHERE id = $1 AND status = 1`,
    [charId])).rows[0];
  if (!ch) throw err('not_found', 404);
  if (Number(ch.location_id) !== SHOP_LOCATION_ID) throw err('shop_unavailable', 403);
  return ch;
}

/** Товары магазина: боевые расходники (type 4) + экипировка (type 1 оружие/2 броня). */
async function shopProducts(client = game) {
  const { rows } = await client.query(
    `SELECT id, name, icon, base_stats, price, quality, level_req, type, slot
       FROM item_templates
      WHERE type IN (1, 2, 4, 5) AND sellable = TRUE AND price > 0
      ORDER BY type, level_req, quality, id`);
  return rows.map(product);
}

export async function getShop(charId) {
  const ch = await shopCharacter(game, charId);
  return {
    locationId: SHOP_LOCATION_ID,
    charLevel: Number(ch.level) || 1,
    items: await shopProducts(game),
  };
}

export async function buyShopItem(charId, templateId, quantity) {
  const qty = Math.max(1, Math.min(99, Math.trunc(Number(quantity) || 1)));
  const tplId = Number(templateId);
  if (!Number.isInteger(tplId)) throw err('not_for_sale', 400);
  let bought;

  await tx(async (c) => {
    const ch = await shopCharacter(c, charId);
    const row = (await c.query(
      `SELECT id, name, icon, type, slot, stackable, base_stats, price, sellable,
              quality, level_req
         FROM item_templates WHERE id = $1`, [tplId])).rows[0];
    if (!row || ![1, 2, 4, 5].includes(Number(row.type)) || row.sellable === false) {
      throw err('not_for_sale', 404);
    }
    const price = Number(row.price) || 0;
    if (price <= 0) throw err('not_for_sale', 404);
    // уровневый доступ: купить можно только если уровень позволяет
    if ((Number(ch.level) || 1) < (Number(row.level_req) || 1)) {
      throw err('level_too_low', 403);
    }
    // нестопируемое (вещи) — всегда 1 шт.; берём плату ровно за выданное (не за qty)
    const buyQty = row.stackable === false ? 1 : qty;
    const cost = price * buyQty;

    await addCurrency(c, charId, CUR.copper, -cost, 4,
      { idempotencyKey: randomUUID(), type: null, id: null });

    const ins = await c.query(
      `INSERT INTO item_instances (template_id, owner_type, owner_id, quantity)
       VALUES ($1, 1, $2, $3) RETURNING id`,
      [tplId, charId, buyQty]);
    await c.query(
      `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id,
          quantity, from_owner_type, from_owner_id, to_owner_type, to_owner_id,
          reason, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, 8, 0, 1, $5, $6, NULL, NULL)`,
      [randomUUID(), ins.rows[0].id, tplId, buyQty, charId, ITEM_REASON_SHOP]);

    bought = { ...product(row), quantity: buyQty, cost };
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
