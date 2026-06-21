import { randomUUID } from 'crypto';
import { game, tx, gameConfig } from './db.js';
import { addCurrency, CUR, moneyBalanceCopper } from './economy.js';
import { getCharacter } from './characters.js';

// owner_type предметов: 1 рюкзак, 5 почта. reason в ledger'ах: 3/5 = mail.
const OWNER_INV = 1, OWNER_MAIL = 5;
const ITEM_REASON_MAIL = 5, CURR_REASON_MAIL = 3;
const SUBJECT_MAX = 80, BODY_MAX = 1000;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Тарифы почты из game_config (с безопасными значениями по умолчанию). */
async function mailTariffs() {
  const taxSend = Number(await gameConfig('mail.tax_send'));
  const itemPct = Number(await gameConfig('mail.tax_item_pct'));
  const maxAtt  = Number(await gameConfig('mail.max_attachments'));
  const expDays = Number(await gameConfig('mail.expire_days'));
  return {
    taxSend: Number.isFinite(taxSend) ? taxSend : 100,
    itemPct: Number.isFinite(itemPct) ? itemPct : 0.1,
    maxAtt:  Number.isFinite(maxAtt) && maxAtt > 0 ? maxAtt : 8,
    expDays: Number.isFinite(expDays) && expDays > 0 ? expDays : 30,
  };
}

/** Налог за вложение одной позиции: 10% номинала × количество, округление вверх. */
function itemTax(price, qty, pct) {
  return Math.ceil((Number(price) || 0) * qty * pct);
}

export async function unreadCount(charId) {
  const { rows } = await game.query(
    `SELECT count(*)::int AS n FROM mail_messages
      WHERE recipient_id = $1 AND is_read = FALSE AND deleted_by_recipient = FALSE`,
    [charId]);
  return rows[0].n;
}

/** Входящие: шапки писем + число вложений (без тел). */
export async function inbox(charId) {
  const { rows } = await game.query(
    `SELECT m.id, m.sender_id, m.subject, m.is_read, m.type,
            m.money_attached, m.has_attachments, m.attachments_taken, m.created_at,
            s.name AS sender_name,
            (SELECT count(*)::int FROM mail_attachments a WHERE a.mail_id = m.id) AS att_count
       FROM mail_messages m
       LEFT JOIN characters s ON s.id = m.sender_id
      WHERE m.recipient_id = $1 AND m.deleted_by_recipient = FALSE
      ORDER BY m.created_at DESC
      LIMIT 100`, [charId]);
  return rows.map(r => ({
    id: r.id,
    senderId: r.sender_id ? Number(r.sender_id) : null,
    senderName: r.sender_id ? r.sender_name : 'Система',
    subject: r.subject || '',
    isRead: r.is_read,
    money: Number(r.money_attached) || 0,
    hasAttachments: r.has_attachments,
    attachmentsTaken: r.attachments_taken,
    attCount: r.att_count,
    canClaim: r.has_attachments && !r.attachments_taken,
    ts: new Date(r.created_at).getTime(),
  }));
}

/** Полный текст письма + список вложений; помечает прочитанным. */
export async function readMail(charId, mailId) {
  const { rows } = await game.query(
    `SELECT m.*, s.name AS sender_name
       FROM mail_messages m LEFT JOIN characters s ON s.id = m.sender_id
      WHERE m.id = $1 AND m.recipient_id = $2 AND m.deleted_by_recipient = FALSE`,
    [mailId, charId]);
  const m = rows[0];
  if (!m) throw bad('not_found', 404);

  if (!m.is_read) {
    await game.query(`UPDATE mail_messages SET is_read = TRUE WHERE id = $1`, [mailId]);
  }
  const att = await game.query(
    `SELECT a.item_instance_id, a.quantity, t.name, t.icon, t.type, t.price
       FROM mail_attachments a
       JOIN item_instances i ON i.id = a.item_instance_id
       JOIN item_templates t ON t.id = i.template_id
      WHERE a.mail_id = $1
      ORDER BY a.item_instance_id`, [mailId]);
  return {
    id: m.id,
    senderId: m.sender_id ? Number(m.sender_id) : null,
    senderName: m.sender_id ? m.sender_name : 'Система',
    subject: m.subject || '',
    body: m.body || '',
    money: Number(m.money_attached) || 0,
    hasAttachments: m.has_attachments,
    attachmentsTaken: m.attachments_taken,
    canClaim: m.has_attachments && !m.attachments_taken,
    ts: new Date(m.created_at).getTime(),
    attachments: att.rows.map(a => ({
      itemId: Number(a.item_instance_id), quantity: a.quantity,
      name: a.name, icon: a.icon, type: a.type, price: Number(a.price) || 0,
    })),
  };
}

/** Пояс не должен «резервировать» больше эликсиров, чем осталось в рюкзаке. */
async function clampBelt(client, charId, templateIds) {
  for (const tpl of templateIds) {
    const owned = Number((await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS q FROM item_instances
        WHERE owner_id = $1 AND owner_type = $2 AND status = 1 AND template_id = $3`,
      [charId, OWNER_INV, tpl])).rows[0].q);
    const slots = (await client.query(
      `SELECT slot, quantity FROM character_belt
        WHERE character_id = $1 AND template_id = $2 ORDER BY slot`,
      [charId, tpl])).rows;
    let reserved = slots.reduce((n, s) => n + Number(s.quantity), 0);
    for (const s of slots) {
      if (reserved <= owned) break;
      const over = reserved - owned;
      const cut = Math.min(over, Number(s.quantity));
      if (cut >= Number(s.quantity)) {
        await client.query(
          `DELETE FROM character_belt WHERE character_id = $1 AND slot = $2`,
          [charId, s.slot]);
      } else {
        await client.query(
          `UPDATE character_belt SET quantity = quantity - $3
            WHERE character_id = $1 AND slot = $2`, [charId, s.slot, cut]);
      }
      reserved -= cut;
    }
  }
}

/** Перенести (или отщепить) часть стопки предмета в другое владение, с записью в ledger. */
async function ledgerMove(client, { itemId, templateId, qty, fromType, fromId, toType, toId }) {
  await client.query(
    `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id, quantity,
        from_owner_type, from_owner_id, to_owner_type, to_owner_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), itemId, templateId, qty, fromType, fromId, toType, toId, ITEM_REASON_MAIL]);
}

/**
 * Отправить письмо. Всё — в одной транзакции: списываем налог, переносим вложения
 * в почту (owner_type=5, owner_id=mail_id), пишем строки ledger. Любая ошибка —
 * полный откат: деньги и вещи не теряются.
 */
export async function sendMail(sender, { to, subject, body, items }) {
  subject = String(subject || '').trim().slice(0, SUBJECT_MAX);
  body = String(body || '').trim().slice(0, BODY_MAX);
  const toName = String(to || '').trim();
  if (!toName) throw bad('recipient_required');
  items = Array.isArray(items) ? items : [];

  const t = await mailTariffs();
  if (items.length > t.maxAtt) throw bad('too_many_attachments');

  // адресат: существует, активен, не сам себе
  const rcpt = (await game.query(
    `SELECT id, name FROM characters WHERE name = $1 AND status = 1`, [toName])).rows[0];
  if (!rcpt) throw bad('recipient_not_found', 404);
  if (String(rcpt.id) === String(sender.id)) throw bad('cannot_mail_self');

  return tx(async (c) => {
    // вложения: блокируем и проверяем владение/торгуемость/количество
    const att = [];           // { itemId, templateId, qty, price, whole }
    const affectedTemplates = new Set();
    let itemsTax = 0;
    for (const raw of items) {
      const itemId = Number(raw.id);
      const wantQty = Math.max(1, Number(raw.qty) || 1);
      if (!itemId) throw bad('bad_attachment');
      if (att.some(a => a.itemId === itemId)) throw bad('duplicate_attachment');
      const it = (await c.query(
        `SELECT i.id, i.template_id, i.quantity, i.version, t.price, t.tradable
           FROM item_instances i JOIN item_templates t ON t.id = i.template_id
          WHERE i.id = $1 AND i.owner_id = $2 AND i.owner_type = $3 AND i.status = 1
          FOR UPDATE OF i`, [itemId, sender.id, OWNER_INV])).rows[0];
      if (!it) throw bad('attachment_not_found', 404);
      if (it.tradable === false) throw bad('item_not_tradable');
      const take = Math.min(wantQty, it.quantity);
      itemsTax += itemTax(it.price, take, t.itemPct);
      att.push({ itemId, templateId: it.template_id, qty: take,
                 whole: take >= it.quantity, version: it.version });
      affectedTemplates.add(it.template_id);
    }

    const tax = t.taxSend + itemsTax;

    // деньги: понятная ошибка до списания, атомарность гарантирует addCurrency
    const bal = await moneyBalanceCopper(c, sender.id, true);
    if (bal < BigInt(tax)) throw bad('insufficient_funds');

    const expiresAt = `now() + interval '${t.expDays} days'`;
    const mailId = (await c.query(
      `INSERT INTO mail_messages
         (recipient_id, sender_id, type, subject, body, has_attachments, expires_at)
       VALUES ($1, $2, 1, $3, $4, $5, ${expiresAt}) RETURNING id`,
      [rcpt.id, sender.id, subject, body, att.length > 0])).rows[0].id;

    // налог списываем после создания письма — в ref_id кладём mail_id
    await addCurrency(c, sender.id, CUR.copper, -tax, CURR_REASON_MAIL,
      { type: 5, id: mailId });   // ref_type 5 = mail

    // переносим вложения в почту
    for (const a of att) {
      let mailItemId = a.itemId;
      if (a.whole) {
        const upd = await c.query(
          `UPDATE item_instances
              SET owner_type = $2, owner_id = $3, slot = NULL,
                  version = version + 1, updated_at = now()
            WHERE id = $1 AND version = $4`,
          [a.itemId, OWNER_MAIL, mailId, a.version]);
        if (upd.rowCount === 0) throw bad('conflict', 409);
        await ledgerMove(c, { itemId: a.itemId, templateId: a.templateId, qty: a.qty,
          fromType: OWNER_INV, fromId: sender.id, toType: OWNER_MAIL, toId: mailId });
      } else {
        // отщепляем часть стопки: уменьшаем источник, создаём экземпляр в почте
        const upd = await c.query(
          `UPDATE item_instances SET quantity = quantity - $2,
                  version = version + 1, updated_at = now()
            WHERE id = $1 AND version = $3 AND quantity > $2`,
          [a.itemId, a.qty, a.version]);
        if (upd.rowCount === 0) throw bad('conflict', 409);
        mailItemId = (await c.query(
          `INSERT INTO item_instances (template_id, owner_type, owner_id, quantity)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [a.templateId, OWNER_MAIL, mailId, a.qty])).rows[0].id;
        await ledgerMove(c, { itemId: mailItemId, templateId: a.templateId, qty: a.qty,
          fromType: OWNER_INV, fromId: sender.id, toType: OWNER_MAIL, toId: mailId });
      }
      await c.query(
        `INSERT INTO mail_attachments (mail_id, item_instance_id, quantity)
         VALUES ($1, $2, $3)`, [mailId, mailItemId, a.qty]);
    }

    await clampBelt(c, sender.id, [...affectedTemplates]);

    return { mailId: Number(mailId), tax, recipientId: Number(rcpt.id),
             recipientName: rcpt.name, attachments: att.length };
  });
}

/** Забрать вложения письма в рюкзак (owner_type 5 -> 1). Идемпотентно по флагу. */
export async function takeAttachments(charId, mailId) {
  return tx(async (c) => {
    const m = (await c.query(
      `SELECT id, has_attachments, attachments_taken, money_attached
         FROM mail_messages
        WHERE id = $1 AND recipient_id = $2 AND deleted_by_recipient = FALSE
        FOR UPDATE`, [mailId, charId])).rows[0];
    if (!m) throw bad('not_found', 404);
    if (!m.has_attachments || m.attachments_taken) return { taken: 0 };

    const att = (await c.query(
      `SELECT a.item_instance_id, a.quantity, i.template_id, i.version
         FROM mail_attachments a JOIN item_instances i ON i.id = a.item_instance_id
        WHERE a.mail_id = $1 FOR UPDATE OF i`, [mailId])).rows;
    for (const a of att) {
      const upd = await c.query(
        `UPDATE item_instances
            SET owner_type = $2, owner_id = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $4 AND owner_type = $5`,
        [a.item_instance_id, OWNER_INV, charId, a.version, OWNER_MAIL]);
      if (upd.rowCount === 0) throw bad('conflict', 409);
      await ledgerMove(c, { itemId: a.item_instance_id, templateId: a.template_id,
        qty: a.quantity, fromType: OWNER_MAIL, fromId: mailId,
        toType: OWNER_INV, toId: charId });
    }
    const money = Number(m.money_attached) || 0;
    if (money > 0) {
      await addCurrency(c, charId, CUR.copper, money, CURR_REASON_MAIL,
        { type: 5, id: mailId });
    }
    await c.query(
      `UPDATE mail_messages SET attachments_taken = TRUE, is_read = TRUE WHERE id = $1`,
      [mailId]);
    return { taken: att.length, money };
  });
}

/** Удалить письмо у получателя; невзятые вложения сначала падают в рюкзак. */
export async function deleteMail(charId, mailId) {
  const pre = (await game.query(
    `SELECT has_attachments, attachments_taken FROM mail_messages
      WHERE id = $1 AND recipient_id = $2 AND deleted_by_recipient = FALSE`,
    [mailId, charId])).rows[0];
  if (!pre) throw bad('not_found', 404);
  if (pre.has_attachments && !pre.attachments_taken) {
    await takeAttachments(charId, mailId);
  }
  await game.query(
    `UPDATE mail_messages SET deleted_by_recipient = TRUE
      WHERE id = $1 AND recipient_id = $2`, [mailId, charId]);
  return { ok: true };
}

export function mailRoutes(app, authed, hub) {
  const me = (req) => req.session.character_id;

  app.get('/api/mail', authed, async (req, res) => {
    const t = await mailTariffs();
    res.json({ unread: await unreadCount(me(req)), items: await inbox(me(req)),
      tariffs: { taxSend: t.taxSend, itemPct: t.itemPct, maxAtt: t.maxAtt } });
  });

  app.get('/api/mail/unread', authed, async (req, res) =>
    res.json({ unread: await unreadCount(me(req)) }));

  app.get('/api/mail/:id', authed, async (req, res) =>
    res.json(await readMail(me(req), Number(req.params.id))));

  app.post('/api/mail/send', authed, async (req, res) => {
    const sender = await getCharacter(me(req));
    const r = await sendMail(sender, req.body || {});
    if (hub) hub.notifyMail(r.recipientId);   // живое обновление счётчика у адресата
    res.json({ ok: true, ...r });
  });

  app.post('/api/mail/:id/take', authed, async (req, res) =>
    res.json(await takeAttachments(me(req), Number(req.params.id))));

  app.post('/api/mail/:id/delete', authed, async (req, res) =>
    res.json(await deleteMail(me(req), Number(req.params.id))));
}
