import { game, tx, gameConfig } from './db.js';
import { addCurrency, CUR, wallet } from './economy.js';
import { product as itemCard } from './shop.js';
import {
  OWNER, ITEM_REASON, CURR_REASON, REF, bad, moveQty, lockSellableItem,
  deliverMail, publishMailNotify,
} from './escrow.js';

const WORLD = 1;
const PRICE_MAX = 1_000_000_000n;   // потолок цены (анти-переполнение и анти-троллинг)

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const toInt = (v) => Math.trunc(Number(v) || 0);

/** Тарифы аукциона из game_config (с безопасными значениями по умолчанию). */
export async function auctionTariffs() {
  const dur = await gameConfig('auction.durations');
  return {
    listingPct: num(await gameConfig('auction.listing_fee_pct'), 0.05),
    salePct:    num(await gameConfig('auction.sale_tax_pct'), 0.15),
    maxLots:    Math.max(1, toInt(await gameConfig('auction.max_lots')) || 3),
    minIncPct:  num(await gameConfig('auction.min_bid_increment_pct'), 0.05),
    featuredFee: Math.max(0, toInt(await gameConfig('auction.featured_fee')) || 0),
    antiSnipeMin: Math.max(0, toInt(await gameConfig('auction.anti_snipe_min')) || 5),
    durations: Array.isArray(dur) && dur.length ? dur.map(toInt).filter((h) => h > 0) : [2, 6, 12, 24, 48],
  };
}

const listingFee = (startPrice, t) => Math.max(1, Math.ceil(startPrice * t.listingPct));
const saleTax    = (finalPrice, t) => Math.max(0, Math.ceil(finalPrice * t.salePct));

/** Минимально допустимая следующая ставка по лоту. */
function minNextBid(lot, t) {
  const cur = lot.current_bid != null ? Number(lot.current_bid) : null;
  if (cur == null) return Number(lot.start_price);
  return cur + Math.max(1, Math.ceil(cur * t.minIncPct));
}

/** Публичный вид лота для клиента (с учётом анонимности и зрителя). */
function lotPublic(r, viewerId, t) {
  const info = itemCard({
    id: r.template_id, name: r.name, icon: r.icon, base_stats: r.base_stats,
    price: r.base_price, quality: r.quality, level_req: r.level_req,
    type: r.type, slot: r.slot,
  });
  const isMine = String(r.seller_id) === String(viewerId);
  const iAmBidder = r.current_bidder_id != null && String(r.current_bidder_id) === String(viewerId);
  return {
    id: Number(r.id),
    templateId: Number(r.template_id),
    name: r.name,
    icon: info.icon,
    kind: info.kind,
    type: Number(r.type),
    quality: Number(r.quality) || 1,
    level: Number(r.level_req) || 1,
    slot: r.slot != null ? Number(r.slot) : null,
    stats: r.base_stats || null,
    description: info.description,
    quantity: Number(r.quantity) || 1,
    startPrice: Number(r.start_price),
    buyoutPrice: r.buyout_price != null ? Number(r.buyout_price) : null,
    currentBid: r.current_bid != null ? Number(r.current_bid) : null,
    bidCount: Number(r.bid_count) || 0,
    minNextBid: minNextBid(r, t),
    sellerId: r.anonymous && !isMine ? null : (r.seller_id != null ? Number(r.seller_id) : null),
    sellerName: r.anonymous && !isMine ? 'Аноним' : (r.seller_name || '—'),
    anonymous: !!r.anonymous,
    featured: !!r.featured,
    autoExtend: !!r.auto_extend,
    isMine,
    iAmHighBidder: iAmBidder,
    endsAt: new Date(r.ends_at).getTime(),
    status: Number(r.status),
  };
}

const LOT_SELECT = `
  SELECT l.id, l.seller_id, l.template_id, l.quantity, l.start_price, l.buyout_price,
         l.current_bid, l.current_bidder_id, l.bid_count, l.anonymous, l.featured,
         l.auto_extend, l.ends_at, l.status,
         t.name, t.icon, t.base_stats, t.price AS base_price, t.quality, t.level_req,
         t.type, t.slot,
         s.name AS seller_name
    FROM auction_lots l
    JOIN item_templates t ON t.id = l.template_id
    LEFT JOIN characters s ON s.id = l.seller_id`;

/** Сколько активных лотов уже выставил продавец. */
async function activeLotCount(client, sellerId) {
  return Number((await client.query(
    `SELECT count(*)::int AS n FROM auction_lots
      WHERE seller_id = $1 AND status = 1`, [sellerId])).rows[0].n);
}

async function myBidsCount(charId) {
  return Number((await game.query(
    `SELECT count(*)::int AS n FROM auction_lots
      WHERE status = 1 AND current_bidder_id = $1`, [charId])).rows[0].n);
}

/** Обзор аукциона: фильтры (поиск/категория/уровень), сортировка, страницы. */
export async function browse(charId, q = {}) {
  const t = await auctionTariffs();
  const where = ['l.status = 1', 'l.world_id = $1'];
  const params = [WORLD];
  const search = String(q.q || '').trim().slice(0, 40);
  if (search) { params.push('%' + search.toLowerCase() + '%'); where.push(`lower(t.name) LIKE $${params.length}`); }
  if (q.cat != null && q.cat !== '' && q.cat !== 'all') {
    params.push(toInt(q.cat)); where.push(`l.category = $${params.length}`);
  }
  if (q.levelMin) { params.push(toInt(q.levelMin)); where.push(`l.level >= $${params.length}`); }
  if (q.levelMax) { params.push(toInt(q.levelMax)); where.push(`l.level <= $${params.length}`); }

  const SORTS = {
    ends:      'l.featured DESC, l.ends_at ASC',
    price:     'l.featured DESC, l.start_price ASC',
    priceDesc: 'l.featured DESC, l.start_price DESC',
    level:     'l.featured DESC, l.level ASC, l.ends_at ASC',
    name:      'l.featured DESC, t.name ASC',
  };
  const order = SORTS[q.sort] || SORTS.ends;
  const page = Math.max(0, toInt(q.page));
  const limit = Math.min(60, Math.max(10, toInt(q.limit) || 40));
  params.push(limit, page * limit);

  const { rows } = await game.query(
    `${LOT_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  return {
    tariffs: t,
    lots: rows.map((r) => lotPublic(r, charId, t)),
    page, limit, hasMore: rows.length === limit,
    activeLotsMine: await activeLotCount(game, charId),
    maxLots: t.maxLots,
    myBidsCount: await myBidsCount(charId),
  };
}

/** Мои лоты (активные сверху, затем недавно закрытые). */
export async function myLots(charId) {
  const t = await auctionTariffs();
  const { rows } = await game.query(
    `${LOT_SELECT} WHERE l.seller_id = $1
      ORDER BY (l.status = 1) DESC, l.ends_at DESC LIMIT 60`, [charId]);
  return { tariffs: t, lots: rows.map((r) => lotPublic(r, charId, t)) };
}

/** Лоты, где я текущий лидер ставок. */
export async function myBids(charId) {
  const t = await auctionTariffs();
  const { rows } = await game.query(
    `${LOT_SELECT} WHERE l.current_bidder_id = $1 AND l.status = 1
      ORDER BY l.ends_at ASC LIMIT 60`, [charId]);
  return { tariffs: t, lots: rows.map((r) => lotPublic(r, charId, t)) };
}

/**
 * Выставить лот. В одной транзакции: проверяем и блокируем вещь, списываем
 * сбор за выставление, переносим вещь в escrow аукциона (owner_type 6),
 * создаём лот. Любая ошибка — полный откат.
 */
export async function createLot(seller, raw) {
  const t = await auctionTariffs();
  const itemId = toInt(raw.itemId);
  const wantQty = Math.max(1, toInt(raw.qty) || 1);
  const startPrice = toInt(raw.startPrice);
  const buyoutPrice = raw.buyoutPrice == null || raw.buyoutPrice === '' ? null : toInt(raw.buyoutPrice);
  const durationHours = toInt(raw.durationHours) || t.durations[0];
  const anonymous = !!raw.anonymous;
  const featured = !!raw.featured;
  const autoExtend = !!raw.autoExtend;

  if (!itemId) throw bad('item_required');
  if (!(startPrice >= 1)) throw bad('bad_start_price');
  if (BigInt(startPrice) > PRICE_MAX) throw bad('price_too_high');
  if (buyoutPrice != null) {
    if (!(buyoutPrice >= startPrice)) throw bad('buyout_below_start');
    if (BigInt(buyoutPrice) > PRICE_MAX) throw bad('price_too_high');
  }
  if (!t.durations.includes(durationHours)) throw bad('bad_duration');

  return tx(async (c) => {
    if (await activeLotCount(c, seller.id) >= t.maxLots) throw bad('lot_limit_reached');

    const it = await lockSellableItem(c, seller.id, itemId, wantQty);
    const fee = listingFee(startPrice, t) + (featured ? t.featuredFee : 0);

    // сбор за выставление — только медь; чёткая ошибка до любых перемещений
    await addCurrency(c, seller.id, CUR.copper, -fee, CURR_REASON.auction, { type: REF.auctionLot, id: null });

    const lot = (await c.query(
      `INSERT INTO auction_lots
         (world_id, seller_id, item_instance_id, template_id, quantity, category,
          subcategory, level, start_price, buyout_price, deposit, anonymous, featured,
          auto_extend, ends_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() + ($15 || ' hours')::interval, 1)
       RETURNING id`,
      [WORLD, seller.id, itemId, it.template_id, it.want, Number(it.type),
       it.slot != null ? Number(it.slot) : null, Number(it.level_req) || 1,
       startPrice, buyoutPrice, fee, anonymous, featured, autoExtend,
       String(durationHours)])).rows[0];

    // вещь в escrow аукциона; для частичной стопки moveQty отщепит новый экземпляр
    const escrowId = await moveQty(c, {
      itemId, qty: it.want, toType: OWNER.auction, toId: lot.id,
      reason: ITEM_REASON.auction, refType: REF.auctionLot, refId: lot.id,
      expectType: OWNER.inventory, expectId: seller.id });
    // lot.item_instance_id всегда указывает на экземпляр в escrow (важно при split)
    if (Number(escrowId) !== Number(itemId)) {
      await c.query(`UPDATE auction_lots SET item_instance_id = $2 WHERE id = $1`, [lot.id, escrowId]);
    }

    return { lotId: Number(lot.id), fee };
  });
}

/** Поставить/повысить ставку. Деньги предыдущего лидера возвращаются. */
export async function placeBid(bidder, lotId, amount) {
  lotId = toInt(lotId);
  amount = toInt(amount);
  const t = await auctionTariffs();
  const notify = new Set();

  const result = await tx(async (c) => {
    const lot = (await c.query(
      `SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE`, [lotId])).rows[0];
    if (!lot) throw bad('lot_not_found', 404);
    if (lot.status !== 1) throw bad('lot_closed');
    if (new Date(lot.ends_at).getTime() <= Date.now()) throw bad('lot_ended');
    if (String(lot.seller_id) === String(bidder.id)) throw bad('cannot_bid_own');
    if (lot.current_bidder_id != null && String(lot.current_bidder_id) === String(bidder.id)) {
      throw bad('already_high_bidder');
    }
    const minBid = minNextBid(lot, t);
    if (amount < minBid) throw bad('bid_too_low');
    if (lot.buyout_price != null && amount >= Number(lot.buyout_price)) throw bad('use_buyout');
    if (BigInt(amount) > PRICE_MAX) throw bad('price_too_high');

    // 1) списываем у нового претендента (insufficient_funds откатит всё)
    await addCurrency(c, bidder.id, CUR.copper, -amount, CURR_REASON.auction,
      { type: REF.auctionLot, id: lotId });
    // 2) возвращаем прежнему лидеру его деньги — письмом на почту
    if (lot.current_bidder_id != null) {
      await deliverMail(c, lot.current_bidder_id, { type: 3, subject: 'Ставка перебита',
        body: 'Вашу ставку на аукционе перебили — медь возвращена во вложении.',
        money: Number(lot.current_bid) });
      notify.add(String(lot.current_bidder_id));
      await c.query(`UPDATE auction_bids SET status = 2 WHERE lot_id = $1 AND status = 1`, [lotId]);
    }
    // 3) фиксируем новую ставку
    await c.query(
      `INSERT INTO auction_bids (lot_id, bidder_id, amount, status) VALUES ($1,$2,$3,1)`,
      [lotId, bidder.id, amount]);

    // 4) анти-снайпинг: продлеваем торги, если до конца меньше порога
    let endsClause = '';
    if (lot.auto_extend && t.antiSnipeMin > 0) {
      const left = new Date(lot.ends_at).getTime() - Date.now();
      if (left < t.antiSnipeMin * 60_000) endsClause = `, ends_at = now() + interval '${t.antiSnipeMin} minutes'`;
    }
    const upd = await c.query(
      `UPDATE auction_lots SET current_bid = $2, current_bidder_id = $3,
              bid_count = bid_count + 1, version = version + 1 ${endsClause}
        WHERE id = $1 AND version = $4`, [lotId, amount, bidder.id, lot.version]);
    if (upd.rowCount === 0) throw bad('conflict', 409);
    return { ok: true, lotId, amount };
  });
  publishMailNotify(notify);
  return result;
}

/** Выкупить лот по «Цене выкупа». Вещь сразу попадает в рюкзак покупателю. */
export async function buyout(buyer, lotId) {
  lotId = toInt(lotId);
  const t = await auctionTariffs();
  const notify = new Set();

  await tx(async (c) => {
    const lot = (await c.query(
      `SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE`, [lotId])).rows[0];
    if (!lot) throw bad('lot_not_found', 404);
    if (lot.status !== 1) throw bad('lot_closed');
    if (new Date(lot.ends_at).getTime() <= Date.now()) throw bad('lot_ended');
    if (lot.buyout_price == null) throw bad('no_buyout');
    if (String(lot.seller_id) === String(buyer.id)) throw bad('cannot_buy_own');

    const price = Number(lot.buyout_price);
    // вернуть деньги текущему лидеру ставок (если есть) — письмом
    if (lot.current_bidder_id != null) {
      await deliverMail(c, lot.current_bidder_id, { type: 3, subject: 'Ставка перебита',
        body: 'Лот выкупили — ваша медь возвращена во вложении.', money: Number(lot.current_bid) });
      notify.add(String(lot.current_bidder_id));
      await c.query(`UPDATE auction_bids SET status = 4 WHERE lot_id = $1 AND status = 1`, [lotId]);
    }
    // списать с покупателя (это оплата, не доставка — снимаем сразу)
    await addCurrency(c, buyer.id, CUR.copper, -price, CURR_REASON.auction, { type: REF.auctionLot, id: lotId });
    // выдать вещь покупателю — письмом
    await deliverMail(c, buyer.id, { type: 3, subject: 'Покупка на аукционе',
      body: 'Вы выкупили лот — вещь во вложении.',
      items: [{ itemId: lot.item_instance_id, qty: lot.quantity,
        expectType: OWNER.auction, expectId: lotId, refType: REF.auctionLot, refId: lotId }] });
    notify.add(String(buyer.id));
    // выплатить продавцу за вычетом налога — письмом
    const tax = saleTax(price, t);
    await deliverMail(c, lot.seller_id, { type: 3, subject: 'Лот продан',
      body: 'Ваш лот выкупили — выручка во вложении (за вычетом налога).', money: price - tax });
    notify.add(String(lot.seller_id));

    const upd = await c.query(
      `UPDATE auction_lots SET status = 3, current_bid = $2, current_bidder_id = $3,
              version = version + 1 WHERE id = $1 AND version = $4`,
      [lotId, price, buyer.id, lot.version]);
    if (upd.rowCount === 0) throw bad('conflict', 409);
    await recordPrice(c, lot.template_id, price, lot.quantity);
  });

  publishMailNotify(notify);
  return { ok: true, wallet: await wallet(game, buyer.id) };
}

/** Снять свой лот (только если ставок ещё не было). Вещь возвращается в рюкзак. */
export async function cancelLot(seller, lotId) {
  lotId = toInt(lotId);
  const notify = new Set();
  const result = await tx(async (c) => {
    const lot = (await c.query(
      `SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE`, [lotId])).rows[0];
    if (!lot) throw bad('lot_not_found', 404);
    if (String(lot.seller_id) !== String(seller.id)) throw bad('not_owner', 403);
    if (lot.status !== 1) throw bad('lot_closed');
    if (lot.bid_count > 0) throw bad('has_bids');
    // вещь возвращается продавцу письмом
    await deliverMail(c, seller.id, { type: 3, subject: 'Лот снят с аукциона',
      body: 'Вы сняли лот — вещь возвращена во вложении.',
      items: [{ itemId: lot.item_instance_id, qty: lot.quantity,
        expectType: OWNER.auction, expectId: lotId, refType: REF.auctionLot, refId: lotId }] });
    notify.add(String(seller.id));
    const upd = await c.query(
      `UPDATE auction_lots SET status = 5, version = version + 1 WHERE id = $1 AND version = $2`,
      [lotId, lot.version]);
    if (upd.rowCount === 0) throw bad('conflict', 409);
    return { ok: true };
  });
  publishMailNotify(notify);
  return result;
}

/** Изменить цены лота (пока нет ставок). */
export async function editLot(seller, lotId, raw) {
  lotId = toInt(lotId);
  const startPrice = toInt(raw.startPrice);
  const buyoutPrice = raw.buyoutPrice == null || raw.buyoutPrice === '' ? null : toInt(raw.buyoutPrice);
  if (!(startPrice >= 1)) throw bad('bad_start_price');
  if (buyoutPrice != null && !(buyoutPrice >= startPrice)) throw bad('buyout_below_start');
  if (BigInt(startPrice) > PRICE_MAX || (buyoutPrice != null && BigInt(buyoutPrice) > PRICE_MAX)) {
    throw bad('price_too_high');
  }
  return tx(async (c) => {
    const lot = (await c.query(
      `SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE`, [lotId])).rows[0];
    if (!lot) throw bad('lot_not_found', 404);
    if (String(lot.seller_id) !== String(seller.id)) throw bad('not_owner', 403);
    if (lot.status !== 1) throw bad('lot_closed');
    if (lot.bid_count > 0) throw bad('has_bids');
    const upd = await c.query(
      `UPDATE auction_lots SET start_price = $2, buyout_price = $3, version = version + 1
        WHERE id = $1 AND version = $4`, [lotId, startPrice, buyoutPrice, lot.version]);
    if (upd.rowCount === 0) throw bad('conflict', 409);
    return { ok: true };
  });
}

/** Статистика цен: средняя/мин/макс за единицу за день (для подсказки цены). */
async function recordPrice(client, templateId, totalPrice, qty) {
  const unit = Math.max(1, Math.round(Number(totalPrice) / Math.max(1, Number(qty))));
  await client.query(
    `INSERT INTO auction_price_history (template_id, day, deals, min_price, avg_price, max_price, volume)
     VALUES ($1, CURRENT_DATE, 1, $2, $2, $2, $3)
     ON CONFLICT (template_id, day) DO UPDATE SET
       deals = auction_price_history.deals + 1,
       min_price = LEAST(auction_price_history.min_price, EXCLUDED.min_price),
       max_price = GREATEST(auction_price_history.max_price, EXCLUDED.max_price),
       avg_price = (auction_price_history.avg_price * auction_price_history.deals + EXCLUDED.min_price)
                   / (auction_price_history.deals + 1),
       volume = auction_price_history.volume + EXCLUDED.volume`,
    [templateId, unit, Number(totalPrice)]);
}

/**
 * Завершение истёкших лотов. Лот с лидером ставок: вещь → победителю, деньги
 * (минус налог) → продавцу. Без ставок: вещь возвращается продавцу. Батчами,
 * SKIP LOCKED — несколько процессов/тиков не подерутся за один лот.
 */
export async function processExpiredLots() {
  const t = await auctionTariffs();
  const notify = new Set();
  let processed = 0;
  for (;;) {
    const did = await tx(async (c) => {
      const lots = (await c.query(
        `SELECT * FROM auction_lots
          WHERE status = 1 AND ends_at <= now()
          ORDER BY ends_at ASC LIMIT 20 FOR UPDATE SKIP LOCKED`)).rows;
      if (!lots.length) return 0;
      for (const lot of lots) {
        if (lot.current_bidder_id != null) {
          // продано лидеру ставок: вещь — победителю, выручка — продавцу (письмами)
          await deliverMail(c, lot.current_bidder_id, { type: 3, subject: 'Вы выиграли торги',
            body: 'Поздравляем! Лот ваш — вещь во вложении.',
            items: [{ itemId: lot.item_instance_id, qty: lot.quantity,
              expectType: OWNER.auction, expectId: lot.id, refType: REF.auctionLot, refId: lot.id }] });
          notify.add(String(lot.current_bidder_id));
          const tax = saleTax(Number(lot.current_bid), t);
          await deliverMail(c, lot.seller_id, { type: 3, subject: 'Лот продан',
            body: 'Ваш лот продан на торгах — выручка во вложении (за вычетом налога).',
            money: Number(lot.current_bid) - tax });
          notify.add(String(lot.seller_id));
          await c.query(`UPDATE auction_bids SET status = 3 WHERE lot_id = $1 AND status = 1`, [lot.id]);
          await c.query(
            `UPDATE auction_lots SET status = 2, version = version + 1 WHERE id = $1`, [lot.id]);
          await recordPrice(c, lot.template_id, Number(lot.current_bid), lot.quantity);
        } else {
          // не продано — вещь обратно продавцу письмом
          await deliverMail(c, lot.seller_id, { type: 3, subject: 'Лот не продан',
            body: 'Срок торгов истёк — вещь возвращена во вложении.',
            items: [{ itemId: lot.item_instance_id, qty: lot.quantity,
              expectType: OWNER.auction, expectId: lot.id, refType: REF.auctionLot, refId: lot.id }] });
          notify.add(String(lot.seller_id));
          await c.query(
            `UPDATE auction_lots SET status = 4, version = version + 1 WHERE id = $1`, [lot.id]);
        }
        processed++;
      }
      return lots.length;
    });
    if (!did) break;
  }
  publishMailNotify(notify);
  return processed;
}

let workerTimer = null;
export function startAuctionWorker(intervalMs = 20_000) {
  if (workerTimer) return;
  const tick = () => processExpiredLots().catch((e) => console.error('Аукцион: завершение лотов', e));
  workerTimer = setInterval(tick, intervalMs);
  if (workerTimer.unref) workerTimer.unref();
  tick();
}

export function auctionRoutes(app, authed, getCharacter) {
  const me = (req) => req.session.character_id;

  app.get('/api/auction', authed, async (req, res) => res.json(await browse(me(req), req.query || {})));
  app.get('/api/auction/mylots', authed, async (req, res) => res.json(await myLots(me(req))));
  app.get('/api/auction/mybids', authed, async (req, res) => res.json(await myBids(me(req))));

  app.post('/api/auction/lot', authed, async (req, res) => {
    const seller = await getCharacter(me(req));
    const r = await createLot(seller, req.body || {});
    res.json({ ok: true, ...r, wallet: await wallet(game, seller.id) });
  });
  app.post('/api/auction/bid', authed, async (req, res) => {
    const bidder = await getCharacter(me(req));
    const r = await placeBid(bidder, req.body?.lotId, req.body?.amount);
    res.json({ ...r, wallet: await wallet(game, bidder.id) });
  });
  app.post('/api/auction/buyout', authed, async (req, res) => {
    const buyer = await getCharacter(me(req));
    res.json(await buyout(buyer, req.body?.lotId));
  });
  app.post('/api/auction/cancel', authed, async (req, res) => {
    const seller = await getCharacter(me(req));
    res.json(await cancelLot(seller, req.body?.lotId));
  });
  app.post('/api/auction/edit', authed, async (req, res) => {
    const seller = await getCharacter(me(req));
    res.json(await editLot(seller, req.body?.lotId, req.body || {}));
  });
}
