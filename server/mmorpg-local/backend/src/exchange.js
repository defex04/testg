import { game, tx, gameConfig } from './db.js';
import { addCurrency, CUR, wallet } from './economy.js';
import {
  OWNER, ITEM_REASON, CURR_REASON, REF, bad, moveQty, deliverMail, publishMailNotify,
} from './escrow.js';
import { displayMarketPrice, normalizeMarketPrice } from './marketCurrency.js';

/**
 * Биржа — доска ЗАЯВОК НА ПОКУПКУ. Игрок выставляет «хочу купить N штук товара
 * по цене P за штуку» на срок; деньги (P×N) сразу блокируются. Другие игроки,
 * у кого есть товар, продают в заявку частями (1..остаток). Продавец получает
 * выручку сразу в кошелёк. Купленный товар копится в escrow заявки и уезжает
 * покупателю письмом при закрытии (полное исполнение / снятие / истечение срока);
 * непокрытый остаток обычных денег возвращается покупателю письмом.
 *
 * Всё транзакционно: деньги — addCurrency (+ ledger), товар — moveQty (+ ledger),
 * доставка ценностей — deliverMail. Сериализация по заявке через FOR UPDATE.
 */
const SIDE_BUY = 1;
const PRICE_MAX = 1_000_000_000n;
const QTY_MAX = 1_000_000;
const toInt = (v) => Math.trunc(Number(v) || 0);

async function exchangeTariffs() {
  const dur = await gameConfig('exchange.durations');
  return {
    maxOrders: Math.max(1, toInt(await gameConfig('exchange.max_orders')) || 10),
    durations: Array.isArray(dur) && dur.length ? dur.map(toInt).filter((h) => h > 0) : [6, 12, 24, 48],
  };
}

async function syncExchangeInstruments(client = game) {
  await client.query(
    `INSERT INTO exchange_instruments (instrument_id, item_template_id, tick_size, lot_size, active)
       SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM exchange_instruments x
                   WHERE x.instrument_id = t.id AND x.item_template_id <> t.id
                ) THEN t.id + 100000
                ELSE t.id
              END,
              t.id, 1, 1, TRUE
         FROM item_templates t
        WHERE t.tradable = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM exchange_instruments i WHERE i.item_template_id = t.id
          )
       ON CONFLICT (instrument_id) DO NOTHING`);
  await client.query(
    `UPDATE exchange_instruments i
        SET active = t.tradable
       FROM item_templates t
      WHERE t.id = i.item_template_id AND i.active <> t.tradable`);
}

/** Список инструментов: последняя цена сделки, лучшие заявки по валютам, число заявок. */
export async function instruments(q = {}) {
  await syncExchangeInstruments();
  const where = ['i.active = TRUE', 't.tradable = TRUE'];
  const params = [];
  const search = String(q.q || '').trim().slice(0, 40);
  if (search) { params.push('%' + search.toLowerCase() + '%'); where.push(`lower(t.name) LIKE $${params.length}`); }
  const cat = q.cat ?? q.category;
  if (cat != null && cat !== '' && cat !== 'all') {
    params.push(toInt(cat)); where.push(`t.type = $${params.length}`);
  }
  if (q.quality != null && q.quality !== '' && q.quality !== 'all') {
    params.push(toInt(q.quality)); where.push(`t.quality = $${params.length}`);
  }
  if (q.levelMin != null && q.levelMin !== '') {
    params.push(toInt(q.levelMin)); where.push(`t.level_req >= $${params.length}`);
  }
  if (q.levelMax != null && q.levelMax !== '') {
    params.push(toInt(q.levelMax)); where.push(`t.level_req <= $${params.length}`);
  }

  const { rows } = await game.query(
    `SELECT i.instrument_id, i.item_template_id, i.tick_size, i.lot_size, i.active,
            t.name, t.icon, t.type, t.slot, t.base_stats, t.quality, t.level_req,
            (SELECT price FROM exchange_trades x WHERE x.instrument_id = i.instrument_id
               ORDER BY ts DESC LIMIT 1) AS last,
            (SELECT jsonb_object_agg(currency_id, best_bid) FROM (
               SELECT currency_id, max(price) AS best_bid
                 FROM exchange_orders o
                WHERE o.instrument_id = i.instrument_id
                  AND o.side = 1 AND o.status IN (1,2)
                GROUP BY currency_id
             ) b) AS best_bids,
            (SELECT count(*)::int FROM exchange_orders o WHERE o.instrument_id = i.instrument_id
               AND o.side = 1 AND o.status IN (1,2)) AS open_orders
       FROM exchange_instruments i JOIN item_templates t ON t.id = i.item_template_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.level_req, t.quality, t.name`, params);
  return rows.map((r) => ({
    instrumentId: Number(r.instrument_id), templateId: Number(r.item_template_id),
    name: r.name, icon: r.icon, type: Number(r.type), slot: r.slot != null ? Number(r.slot) : null,
    quality: Number(r.quality) || 1,
    stats: r.base_stats || null, level: Number(r.level_req) || 1,
    tickSize: Number(r.tick_size) || 1, lotSize: Number(r.lot_size) || 1,
    last: r.last != null ? Number(r.last) : null,
    bestBids: r.best_bids || {},
    openOrders: Number(r.open_orders) || 0,
  }));
}

function orderPublic(r, viewerId) {
  const quantity = Number(r.quantity), filled = Number(r.filled);
  const priceInfo = displayMarketPrice(r.currency_id, r.price);
  return {
    id: Number(r.id),
    buyerId: r.buyer_anon ? null : Number(r.character_id),
    buyerName: r.buyer_name || '—',
    currencyId: priceInfo.currencyId,
    currency: priceInfo.currency,
    money: priceInfo.money || null,
    price: priceInfo.price,
    quantity, filled, remaining: quantity - filled,
    status: Number(r.status),
    endsAt: r.ends_at ? new Date(r.ends_at).getTime() : null,
    isMine: String(r.character_id) === String(viewerId),
  };
}

/** Доска одного инструмента: открытые заявки, мои заявки, мой запас товара, сделки. */
export async function board(charId, instrumentId) {
  await syncExchangeInstruments();
  instrumentId = toInt(instrumentId);
  const t = await exchangeTariffs();
  const instr = (await game.query(
    `SELECT i.instrument_id, i.item_template_id, i.tick_size, i.lot_size, i.active,
            tt.name, tt.icon, tt.type, tt.slot, tt.base_stats, tt.quality, tt.level_req, tt.tradable
       FROM exchange_instruments i JOIN item_templates tt ON tt.id = i.item_template_id
      WHERE i.instrument_id = $1`, [instrumentId])).rows[0];
  if (!instr) throw bad('instrument_not_found', 404);
  if (!instr.active || instr.tradable === false) throw bad('instrument_inactive');

  const orders = (await game.query(
    `SELECT o.id, o.character_id, o.currency_id, o.price, o.quantity, o.filled, o.status, o.ends_at,
            c.name AS buyer_name
       FROM exchange_orders o LEFT JOIN characters c ON c.id = o.character_id
      WHERE o.instrument_id = $1 AND o.side = 1 AND o.status IN (1,2)
      ORDER BY o.currency_id ASC, o.price DESC, o.created_at ASC LIMIT 60`, [instrumentId])).rows
    .map((r) => orderPublic({ ...r, buyer_anon: false }, charId));

  const trades = (await game.query(
    `SELECT currency_id, price, quantity, ts FROM exchange_trades
      WHERE instrument_id = $1 ORDER BY ts DESC LIMIT 30`, [instrumentId])).rows
    .map((r) => ({ ...displayMarketPrice(r.currency_id, r.price),
      qty: Number(r.quantity), ts: new Date(r.ts).getTime() }));

  const owned = Number((await game.query(
    `SELECT COALESCE(SUM(quantity),0)::bigint AS q FROM item_instances
      WHERE owner_id = $1 AND owner_type = $2 AND status = 1 AND template_id = $3 AND bind_type = 0`,
    [charId, OWNER.inventory, instr.item_template_id])).rows[0].q);

  const myOpen = Number((await game.query(
    `SELECT count(*)::int AS n FROM exchange_orders
      WHERE character_id = $1 AND side = 1 AND status IN (1,2)`, [charId])).rows[0].n);

  return {
    tariffs: t,
    instrument: {
      instrumentId: Number(instr.instrument_id), templateId: Number(instr.item_template_id),
      name: instr.name, icon: instr.icon, type: Number(instr.type),
      slot: instr.slot != null ? Number(instr.slot) : null, stats: instr.base_stats || null,
      quality: Number(instr.quality) || 1, level: Number(instr.level_req) || 1,
      tickSize: Number(instr.tick_size) || 1, lotSize: Number(instr.lot_size) || 1, active: !!instr.active,
    },
    orders, trades, owned, myOpenOrders: myOpen, maxOrders: t.maxOrders,
  };
}

/** Записать сделку (для «последней цены»; sell_order_id у заявочной модели нет). */
function recordTrade(c, instrumentId, buyOrderId, currencyId, price, qty) {
  return c.query(
    `INSERT INTO exchange_trades (instrument_id, buy_order_id, sell_order_id, currency_id, price, quantity)
     VALUES ($1, $2, NULL, $3, $4, $5)`, [instrumentId, buyOrderId, currencyId, price, qty]);
}

/** Создать заявку на покупку: блокируем деньги P×N, ставим срок. */
export async function createBuyOrder(buyer, raw) {
  const instrumentId = toInt(raw.instrumentId);
  const normalized = normalizeMarketPrice({
    priceMode: raw.priceMode, money: raw.money,
    diamond: raw.diamond, price: raw.price, currencyId: raw.currencyId ?? raw.currency,
  });
  const quantity = toInt(raw.quantity);
  const durationHours = toInt(raw.durationHours);
  const t = await exchangeTariffs();

  if (!normalized) throw bad('bad_price');
  const price = normalized.price;
  const currencyId = normalized.currencyId;
  if (!(price >= 1) || BigInt(price) > PRICE_MAX) throw bad('bad_price');
  if (!(quantity >= 1) || quantity > QTY_MAX) throw bad('bad_quantity');
  const hours = t.durations.includes(durationHours) ? durationHours : t.durations[0];
  await syncExchangeInstruments();

  let orderId;
  await tx(async (c) => {
    const instr = (await c.query(
      `SELECT i.*, tt.tradable FROM exchange_instruments i
         JOIN item_templates tt ON tt.id = i.item_template_id
        WHERE i.instrument_id = $1`, [instrumentId])).rows[0];
    if (!instr || !instr.active) throw bad('instrument_inactive');
    if (instr.tradable === false) throw bad('item_not_tradable');
    if (price % Number(instr.tick_size || 1) !== 0) throw bad('bad_tick');
    if (quantity % Number(instr.lot_size || 1) !== 0) throw bad('bad_lot');

    const open = Number((await c.query(
      `SELECT count(*)::int AS n FROM exchange_orders
        WHERE character_id = $1 AND side = 1 AND status IN (1,2)`, [buyer.id])).rows[0].n);
    if (open >= t.maxOrders) throw bad('order_limit_reached');

    const order = (await c.query(
      `INSERT INTO exchange_orders (character_id, instrument_id, side, currency_id, price, quantity, status, ends_at)
       VALUES ($1, $2, 1, $3, $4, $5, 1, now() + ($6 || ' hours')::interval) RETURNING id`,
      [buyer.id, instrumentId, currencyId, price, quantity, String(hours)])).rows[0];
    orderId = Number(order.id);

    // блокируем всю сумму заявки (insufficient_funds откатит создание)
    await addCurrency(c, buyer.id, currencyId, -(price * quantity), CURR_REASON.exchange,
      { type: REF.exchangeOrder, id: orderId });
  });
  return { ok: true, orderId, wallet: await wallet(game, buyer.id), board: await board(buyer.id, instrumentId) };
}

/** Перенести qty товара из рюкзака продавца в escrow заявки (по нескольким стопкам). */
async function escrowSell(c, sellerId, templateId, qty, orderId) {
  const insts = (await c.query(
    `SELECT id, quantity FROM item_instances
      WHERE owner_id = $1 AND owner_type = $2 AND status = 1 AND template_id = $3 AND bind_type = 0
      ORDER BY id FOR UPDATE`, [sellerId, OWNER.inventory, templateId])).rows;
  const have = insts.reduce((n, r) => n + Number(r.quantity), 0);
  if (have < qty) throw bad('not_enough_items');
  let need = qty;
  for (const inst of insts) {
    if (need <= 0) break;
    const take = Math.min(need, Number(inst.quantity));
    await moveQty(c, { itemId: inst.id, qty: take, toType: OWNER.exchange, toId: orderId,
      reason: ITEM_REASON.exchange, refType: REF.exchangeOrder, refId: orderId,
      expectType: OWNER.inventory, expectId: sellerId });
    need -= take;
  }
}

/** Доставить покупателю всё, что в escrow заявки, письмом (товар + остаток средств). */
async function deliverOrderToBuyer(c, order, { subject, body, money = 0, diamond = 0 }) {
  const escrow = (await c.query(
    `SELECT id, quantity FROM item_instances
      WHERE owner_type = $1 AND owner_id = $2 AND status = 1 ORDER BY id`,
    [OWNER.exchange, order.id])).rows;
  const items = escrow.map((r) => ({ itemId: r.id, qty: Number(r.quantity),
    expectType: OWNER.exchange, expectId: Number(order.id),
    refType: REF.exchangeOrder, refId: Number(order.id) }));
  return deliverMail(c, order.character_id, { type: 2, subject, body,
    money: Number(order.refundMailMoney ?? money) || 0,
    diamond: Number(order.refundMailDiamond ?? diamond) || 0, items });
}

/** Непокрытый остаток заблокированных средств заявки → поля письма (медь/бриллианты). */
function orderRefundFields(order) {
  const refund = Number(order.price) * (Number(order.quantity) - Number(order.filled));
  const isDiamond = (Number(order.currency_id) || CUR.copper) === CUR.diamond;
  return { refundMailMoney: isDiamond ? 0 : refund, refundMailDiamond: isDiamond ? refund : 0 };
}

/** Продать в чужую заявку (1..остаток, не больше своего запаса). */
export async function sellIntoOrder(seller, raw) {
  const orderId = toInt(raw.orderId);
  const wantQty = toInt(raw.quantity);
  const notify = new Set();

  const result = await tx(async (c) => {
    const order = (await c.query(
      `SELECT * FROM exchange_orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw bad('order_not_found', 404);
    if (Number(order.side) !== SIDE_BUY) throw bad('not_a_buy_order');
    if (![1, 2].includes(Number(order.status))) throw bad('order_closed');
    if (order.ends_at && new Date(order.ends_at).getTime() <= Date.now()) throw bad('order_expired');
    if (String(order.character_id) === String(seller.id)) throw bad('cannot_sell_own');

    const instr = (await c.query(
      `SELECT item_template_id FROM exchange_instruments WHERE instrument_id = $1`,
      [order.instrument_id])).rows[0];
    const templateId = instr.item_template_id;

    const remaining = Number(order.quantity) - Number(order.filled);
    const owned = Number((await c.query(
      `SELECT COALESCE(SUM(quantity),0)::bigint AS q FROM item_instances
        WHERE owner_id = $1 AND owner_type = $2 AND status = 1 AND template_id = $3 AND bind_type = 0`,
      [seller.id, OWNER.inventory, templateId])).rows[0].q);
    const sellQty = Math.min(wantQty > 0 ? wantQty : remaining, remaining, owned);
    if (sellQty <= 0) throw bad(owned <= 0 ? 'not_enough_items' : 'order_filled');

    const price = Number(order.price);
    // товар продавца → escrow заявки
    await escrowSell(c, seller.id, templateId, sellQty, orderId);
    // выручка продавцу сразу в валюте заявки
    await addCurrency(c, seller.id, Number(order.currency_id) || CUR.copper,
      price * sellQty, CURR_REASON.exchange, { type: REF.exchangeOrder, id: orderId });
    await recordTrade(c, order.instrument_id, orderId, Number(order.currency_id) || CUR.copper, price, sellQty);

    const newFilled = Number(order.filled) + sellQty;
    if (newFilled >= Number(order.quantity)) {
      // заявка полностью исполнена — весь товар покупателю письмом, заявка закрыта
      await deliverOrderToBuyer(c, order, { subject: 'Заявка исполнена',
        body: 'Ваша заявка на бирже полностью исполнена — товар во вложении.' });
      notify.add(String(order.character_id));
      await c.query(`UPDATE exchange_orders SET filled = $2, status = 3 WHERE id = $1`,
        [orderId, newFilled]);
    } else {
      await c.query(`UPDATE exchange_orders SET filled = $2, status = 2 WHERE id = $1`,
        [orderId, newFilled]);
    }
    return { ok: true, sold: sellQty, instrumentId: Number(order.instrument_id) };
  });

  publishMailNotify(notify);
  return { ...result, wallet: await wallet(game, seller.id),
    board: await board(seller.id, result.instrumentId) };
}

/** Снять свою заявку: купленный товар и непокрытые обычные деньги — письмом. */
export async function cancelBuyOrder(buyer, orderId) {
  orderId = toInt(orderId);
  const notify = new Set();
  let instrumentId;
  await tx(async (c) => {
    const order = (await c.query(
      `SELECT * FROM exchange_orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!order) throw bad('order_not_found', 404);
    if (String(order.character_id) !== String(buyer.id)) throw bad('not_owner', 403);
    if (![1, 2].includes(Number(order.status))) throw bad('order_closed');
    instrumentId = Number(order.instrument_id);
    Object.assign(order, orderRefundFields(order));
    await deliverOrderToBuyer(c, order, { subject: 'Заявка снята',
      body: 'Вы сняли заявку с биржи — купленный товар и остаток средств во вложении.' });
    notify.add(String(order.character_id));
    await c.query(`UPDATE exchange_orders SET status = 4 WHERE id = $1`, [orderId]);
  });
  publishMailNotify(notify);
  return { ok: true, wallet: await wallet(game, buyer.id), board: await board(buyer.id, instrumentId) };
}

/** Завершение истёкших заявок: товар и непокрытые обычные деньги — письмом. */
export async function processExpiredOrders() {
  const notify = new Set();
  let processed = 0;
  for (;;) {
    const did = await tx(async (c) => {
      const orders = (await c.query(
        `SELECT * FROM exchange_orders
          WHERE side = 1 AND status IN (1,2) AND ends_at IS NOT NULL AND ends_at <= now()
          ORDER BY ends_at ASC LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
      if (!orders.length) return 0;
      for (const order of orders) {
        Object.assign(order, orderRefundFields(order));
        await deliverOrderToBuyer(c, order, { subject: 'Срок заявки истёк',
          body: 'Заявка на бирже закрыта по времени — купленный товар и остаток средств во вложении.' });
        notify.add(String(order.character_id));
        await c.query(`UPDATE exchange_orders SET status = 5 WHERE id = $1`, [order.id]);
        processed++;
      }
      return orders.length;
    });
    if (!did) break;
  }
  publishMailNotify(notify);
  return processed;
}

let workerTimer = null;
export function startExchangeWorker(intervalMs = 20_000) {
  if (workerTimer) return;
  const tick = () => processExpiredOrders().catch((e) => console.error('Биржа: завершение заявок', e));
  workerTimer = setInterval(tick, intervalMs);
  if (workerTimer.unref) workerTimer.unref();
  tick();
}

export function exchangeRoutes(app, authed, getCharacter) {
  const me = (req) => req.session.character_id;
  app.get('/api/exchange', authed, async (req, res) =>
    res.json({ instruments: await instruments(req.query || {}) }));
  app.get('/api/exchange/board/:id', authed, async (req, res) =>
    res.json(await board(me(req), req.params.id)));
  app.post('/api/exchange/order', authed, async (req, res) => {
    const buyer = await getCharacter(me(req));
    res.json(await createBuyOrder(buyer, req.body || {}));
  });
  app.post('/api/exchange/sell', authed, async (req, res) => {
    const seller = await getCharacter(me(req));
    res.json(await sellIntoOrder(seller, req.body || {}));
  });
  app.post('/api/exchange/cancel', authed, async (req, res) => {
    const buyer = await getCharacter(me(req));
    res.json(await cancelBuyOrder(buyer, req.body?.orderId));
  });
}
