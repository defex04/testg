import { randomUUID } from 'crypto';
import { redis } from './db.js';

/**
 * Низкоуровневые транзакционные примитивы рынка (аукцион + биржа).
 *
 * Деньги двигаются ТОЛЬКО через economy.addCurrency (баланс + ledger атомарно),
 * предметы — ТОЛЬКО через moveQty (смена владельца item_instances + item_ledger).
 * Любой вызов обязан идти внутри tx(): частичный успех невозможен.
 *
 * owner_type предметов (схема 30_game_schema.sql):
 *   1 рюкзак · 2 экипировка · 3 банк · 4 клан-склад · 5 почта ·
 *   6 аукцион (escrow лота) · 7 биржа/trade-escrow (escrow ордера) · 8 система
 */
export const OWNER = {
  inventory: 1, equipment: 2, bank: 3, clan: 4, mail: 5,
  auction: 6, exchange: 7, system: 8,
};

// reason в item_ledger: 3 trade, 4 auction, 5 mail (аудит причины перемещения)
export const ITEM_REASON = { auction: 4, exchange: 3, mail: 5 };
// reason в currency_ledger: 2 auction, 6 exchange
export const CURR_REASON = { auction: 2, exchange: 6 };
// ref_type для обоих ledger'ов — на что ссылается операция (нумерация модуля рынка)
export const REF = { auctionLot: 6, exchangeOrder: 7 };

export const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Append-only запись перемещения предмета. */
function ledgerItem(client, p) {
  return client.query(
    `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id, quantity,
        from_owner_type, from_owner_id, to_owner_type, to_owner_id, reason, ref_type, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), p.itemId, p.templateId, p.qty,
     p.fromType ?? null, p.fromId ?? null, p.toType, p.toId, p.reason,
     p.refType ?? null, p.refId ?? null]);
}

/**
 * Переместить qty единиц предмета в другое владение, с записью в ledger.
 * Источник блокируется FOR UPDATE и (если заданы expectType/expectId) обязан
 * принадлежать именно ожидаемому владельцу — это защита от гонок и подмены id.
 *   - вся стопка → реассайн владельца того же экземпляра (id сохраняется);
 *   - часть стопки → отщепление нового экземпляра в назначении.
 * Возвращает id экземпляра в назначении.
 */
export async function moveQty(client, {
  itemId, qty, toType, toId, reason, refType, refId, expectType, expectId,
}) {
  const it = (await client.query(
    `SELECT id, template_id, quantity, version, owner_type, owner_id
       FROM item_instances WHERE id = $1 AND status = 1 FOR UPDATE`, [itemId])).rows[0];
  if (!it) throw bad('item_not_found', 404);
  if (expectType != null && Number(it.owner_type) !== Number(expectType)) throw bad('item_conflict', 409);
  if (expectId != null && String(it.owner_id) !== String(expectId)) throw bad('item_conflict', 409);

  const have = Number(it.quantity);
  const move = Math.min(Math.max(1, Math.trunc(Number(qty) || 0)), have);

  if (move >= have) {
    const upd = await client.query(
      `UPDATE item_instances
          SET owner_type = $2, owner_id = $3, slot = NULL,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $4`,
      [itemId, toType, toId, it.version]);
    if (upd.rowCount === 0) throw bad('item_conflict', 409);
    await ledgerItem(client, { itemId, templateId: it.template_id, qty: move,
      fromType: it.owner_type, fromId: it.owner_id, toType, toId, reason, refType, refId });
    return Number(itemId);
  }

  const upd = await client.query(
    `UPDATE item_instances SET quantity = quantity - $2,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $3 AND quantity > $2`, [itemId, move, it.version]);
  if (upd.rowCount === 0) throw bad('item_conflict', 409);
  const dest = (await client.query(
    `INSERT INTO item_instances (template_id, owner_type, owner_id, quantity)
     VALUES ($1, $2, $3, $4) RETURNING id`, [it.template_id, toType, toId, move])).rows[0].id;
  await ledgerItem(client, { itemId: dest, templateId: it.template_id, qty: move,
    fromType: it.owner_type, fromId: it.owner_id, toType, toId, reason, refType, refId });
  return Number(dest);
}

/**
 * Заблокировать и проверить предмет рюкзака к выставлению/продаже:
 * принадлежит charId, лежит в рюкзаке (owner_type 1, не надет), торгуем,
 * не привязан, активен, и в нём хватает количества. Возвращает строку под
 * блокировкой. Вызывать ПЕРЕД moveQty (которая возьмёт свою FOR UPDATE — это
 * та же строка, повторная блокировка в одной транзакции безопасна).
 */
export async function lockSellableItem(client, charId, itemId, wantQty) {
  const it = (await client.query(
    `SELECT i.id, i.template_id, i.quantity, i.bind_type, i.enchant_level, i.props,
            t.name, t.icon, t.type, t.slot, t.quality, t.level_req, t.tradable, t.stackable
       FROM item_instances i JOIN item_templates t ON t.id = i.template_id
      WHERE i.id = $1 AND i.owner_id = $2 AND i.owner_type = $3 AND i.status = 1
      FOR UPDATE OF i`, [itemId, charId, OWNER.inventory])).rows[0];
  if (!it) throw bad('item_not_found', 404);
  if (it.tradable === false) throw bad('item_not_tradable');
  if (Number(it.bind_type) > 0) throw bad('item_bound');
  const want = Math.max(1, Math.trunc(Number(wantQty) || 1));
  if (want > Number(it.quantity)) throw bad('not_enough_quantity');
  return { ...it, want };
}

/**
 * Доставить ценности получателю системным письмом (sender_id = NULL). Деньги
 * кладутся как money_attached, предметы (уже лежащие в escrow рынка) переносятся
 * в почту (owner_type=5, owner_id=mail_id) и подвешиваются как вложения. Получатель
 * забирает их штатным «Забрать» (mail.takeAttachments). Единый канал доставки
 * выигрышей/возвратов/выплат аукциона и биржи. Вызывать ВНУТРИ tx().
 *
 * items: [{ itemId, qty, expectType, expectId, refType, refId }] — экземпляры в escrow.
 * type письма: 2 system, 3 auction.
 */
export async function deliverMail(client, recipientId, {
  subject = '', body = '', money = 0, items = [], type = 2, expireDays = 30,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const coins = Math.max(0, Math.trunc(Number(money) || 0));
  if (coins === 0 && list.length === 0) return null;     // нечего слать

  const mailId = (await client.query(
    `INSERT INTO mail_messages
        (recipient_id, sender_id, type, subject, body, money_attached, has_attachments, expires_at)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval)
     RETURNING id`,
    [recipientId, type, subject, body, coins, list.length > 0, String(expireDays)])).rows[0].id;

  for (const it of list) {
    const destId = await moveQty(client, {
      itemId: it.itemId, qty: it.qty, toType: OWNER.mail, toId: mailId,
      reason: ITEM_REASON.mail, refType: it.refType ?? null, refId: it.refId ?? mailId,
      expectType: it.expectType, expectId: it.expectId });
    await client.query(
      `INSERT INTO mail_attachments (mail_id, item_instance_id, quantity) VALUES ($1, $2, $3)`,
      [mailId, destId, it.qty]);
  }
  return Number(mailId);
}

/** Пинг получателям о новых письмах (счётчик «непрочитанных»). Вызывать ПОСЛЕ commit. */
export function publishMailNotify(ids) {
  for (const id of new Set([...(ids || [])].map(String))) {
    if (!id) continue;
    redis.publish(`mail.notify.${id}`, JSON.stringify({ to: Number(id) })).catch(() => {});
  }
}
