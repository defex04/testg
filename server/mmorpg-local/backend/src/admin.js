import express from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { game, auth, redis, tx, adminPg, clearConfigCache } from './db.js';
import { addCurrency, wallet, CUR } from './economy.js';
import { adminAbort } from './battle/manager.js';
import { cfg } from './config.js';

/**
 * Админ-API: /admin/api/*, заголовок x-admin-key.
 * Деньги/предметы — только через ledger'ы; каждое изменяющее действие —
 * строка в admin_audit. Статика (шаблоны, квесты) правится пулом adminPg.
 */
const bad = (status, msg) => Object.assign(new Error(msg), { status });

async function audit(action, targetType, targetId, details) {
  await game.query(
    `INSERT INTO admin_audit (admin_id, action, target_type, target_id, details)
     VALUES (0, $1, $2, $3, $4)`,
    [action, targetType, targetId, details ? JSON.stringify(details) : null]);
}

export function adminRoutes(app) {
  const guard = (req, res, next) => {
    if (!cfg.adminPassword) return res.status(503).json({ error: 'admin_disabled' });
    if (req.headers['x-admin-key'] !== cfg.adminPassword)
      return res.status(401).json({ error: 'unauthorized' });
    next();
  };

  app.post('/admin/api/login', (req, res) => {
    if (!cfg.adminPassword) return res.status(503).json({ error: 'admin_disabled' });
    if ((req.body || {}).password !== cfg.adminPassword)
      return res.status(401).json({ error: 'wrong_password' });
    res.json({ ok: true });
  });

  // ================= общая статистика =================
  app.get('/admin/api/stats', guard, async (req, res) => {
    const n = async (pool, sql) => Number((await pool.query(sql)).rows[0].n);
    const locs = (await game.query(`SELECT id, name FROM locations ORDER BY id`)).rows;
    const online = [];
    let onlineTotal = 0;
    for (const l of locs) {
      const c = await redis.hLen(`loc:${l.id}:players`);
      onlineTotal += c;
      online.push({ id: l.id, location: l.name, players: c });
    }
    const levels = (await game.query(
      `SELECT level, count(*)::int AS count FROM characters
        WHERE status = 1 GROUP BY level ORDER BY level`)).rows;
    const battlesByDay = (await game.query(
      `SELECT to_char(d, 'DD.MM') AS day,
              count(b.id)::int AS count
         FROM generate_series(current_date - 6, current_date, '1 day') d
         LEFT JOIN battles b ON b.created_at::date = d
        GROUP BY d ORDER BY d`)).rows;
    res.json({
      accounts:      await n(auth, `SELECT count(*) n FROM accounts`),
      characters:    await n(game, `SELECT count(*) n FROM characters WHERE status = 1`),
      battlesActive: await n(game, `SELECT count(*) n FROM battles WHERE status = 2`),
      battlesTotal:  await n(game, `SELECT count(*) n FROM battles`),
      chatToday:     await n(game, `SELECT count(*) n FROM chat_messages
                                     WHERE created_at > now() - interval '24 hours'`),
      itemsLive:     await n(game, `SELECT count(*) n FROM item_instances WHERE status = 1`),
      onlineTotal, online, levels, battlesByDay,
    });
  });

  // ================= персонажи =================
  app.get('/admin/api/characters', guard, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const { rows } = await game.query(
      `SELECT ch.id, ch.name, ch.level, ch.exp, l.name AS location,
              ch.account_id, ch.hp_cur, ch.online_at, ch.created_at
         FROM characters ch JOIN locations l ON l.id = ch.location_id
        WHERE ch.status = 1
          AND ($1 = '' OR ch.name ILIKE '%' || $1 || '%' OR ch.id::text = $1)
        ORDER BY ch.id DESC LIMIT 100`, [q]);
    res.json(rows);
  });

  app.get('/admin/api/characters/:id', guard, async (req, res) => {
    const id = Number(req.params.id);
    const ch = (await game.query(
      `SELECT ch.*, l.name AS location FROM characters ch
         JOIN locations l ON l.id = ch.location_id WHERE ch.id = $1`, [id])).rows[0];
    if (!ch) throw bad(404, 'not_found');
    const [stats, inv, injuries, battles, ledger, quests] = await Promise.all([
      game.query(`SELECT * FROM character_stats WHERE character_id = $1`, [id]),
      game.query(   // рюкзак целиком: инвентарь, экипировка, банк
        `SELECT i.id, i.template_id, t.name, t.icon, i.owner_type, i.slot,
                i.quantity, i.enchant_level, i.props, t.base_stats
           FROM item_instances i JOIN item_templates t ON t.id = i.template_id
          WHERE i.owner_id = $1 AND i.owner_type IN (1, 2, 3) AND i.status = 1
          ORDER BY i.owner_type, i.id`, [id]),
      game.query(
        `SELECT body_part, severity, status, inflicted_at, heals_at
           FROM character_injuries WHERE character_id = $1
          ORDER BY inflicted_at DESC LIMIT 10`, [id]),
      game.query(
        `SELECT b.id, b.type, b.status, bp.result, bp.damage_dealt, bp.exp_gained,
                b.started_at FROM battle_participants bp
           JOIN battles b ON b.id = bp.battle_id
          WHERE bp.character_id = $1 ORDER BY b.id DESC LIMIT 10`, [id]),
      game.query(
        `SELECT cl.created_at, cur.code, cl.amount, cl.balance_after, cl.reason
           FROM currency_ledger cl JOIN currencies cur ON cur.id = cl.currency_id
          WHERE cl.subject_type = 1 AND cl.subject_id = $1
          ORDER BY cl.id DESC LIMIT 15`, [id]),
      game.query(
        `SELECT q.name, cq.status, cq.progress, cq.completed_at
           FROM character_quests cq JOIN quest_templates q ON q.id = cq.quest_id
          WHERE cq.character_id = $1 ORDER BY cq.accepted_at DESC LIMIT 10`, [id]),
    ]);
    res.json({ character: ch, stats: stats.rows[0] || null,
      wallet: await wallet(game, id), inventory: inv.rows,
      injuries: injuries.rows, battles: battles.rows,
      ledger: ledger.rows, quests: quests.rows });
  });

  app.post('/admin/api/characters/:id/currency', guard, async (req, res) => {
    const id = Number(req.params.id);
    const { code, amount, note } = req.body || {};
    const currencyId = CUR[code];
    const sum = Math.trunc(Number(amount));
    if (!currencyId || !Number.isFinite(sum) || sum === 0) throw bad(400, 'bad_request');
    const balance = await tx((c) =>
      addCurrency(c, id, currencyId, sum, 8, { idempotencyKey: randomUUID() }));
    await audit('currency.adjust', 1, id, { code, amount: sum, note: note || null });
    res.json({ ok: true, balance: Number(balance) });
  });

  app.post('/admin/api/characters/:id/give-item', guard, async (req, res) => {
    const id = Number(req.params.id);
    const templateId = Number((req.body || {}).template_id);
    const qty = Math.max(1, Number((req.body || {}).quantity) || 1);
    const tpl = (await game.query(
      `SELECT id, name, stackable FROM item_templates WHERE id = $1`,
      [templateId])).rows[0];
    if (!tpl) throw bad(404, 'template_not_found');
    const itemId = await tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO item_instances (template_id, owner_type, owner_id, quantity)
         VALUES ($1, 1, $2, $3) RETURNING id`,
        [templateId, id, tpl.stackable ? qty : 1]);
      await c.query(
        `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id,
            quantity, to_owner_type, to_owner_id, reason)
         VALUES ($1, $2, $3, $4, 1, $5, 11)`,
        [randomUUID(), ins.rows[0].id, templateId, tpl.stackable ? qty : 1, id]);
      return ins.rows[0].id;
    });
    await audit('item.give', 1, id, { templateId, name: tpl.name, itemId, qty });
    res.json({ ok: true, itemId });
  });

  // правка персонажа: уровень, опыт, hp и базовые характеристики
  app.post('/admin/api/characters/:id/edit', guard, async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const chCols = ['level', 'exp', 'hp_cur', 'mp_cur', 'energy'];
    const stCols = ['str', 'agi', 'vit', 'intel', 'wis', 'free_points'];
    await tx(async (c) => {
      const sets = [], vals = [id];
      for (const col of chCols) if (col in b) {
        vals.push(Number(b[col])); sets.push(`${col} = $${vals.length}`);
      }
      if (sets.length) await c.query(
        `UPDATE characters SET ${sets.join(', ')} WHERE id = $1`, vals);
      if (b.stats) {
        const s = [], v = [id];
        for (const col of stCols) if (col in b.stats) {
          v.push(Number(b.stats[col])); s.push(`${col} = $${v.length}`);
        }
        if (s.length) await c.query(
          `UPDATE character_stats SET ${s.join(', ')} WHERE character_id = $1`, v);
      }
    });
    await audit('character.edit', 1, id, b);
    res.json({ ok: true });
  });

  app.post('/admin/api/characters/:id/teleport', guard, async (req, res) => {
    const id = Number(req.params.id);
    const to = Number((req.body || {}).location_id);
    if (!(await game.query(`SELECT 1 FROM locations WHERE id = $1`, [to])).rows[0])
      throw bad(404, 'location_not_found');
    const from = (await game.query(
      `SELECT location_id FROM characters WHERE id = $1`, [id])).rows[0];
    if (!from) throw bad(404, 'not_found');
    await game.query(`UPDATE characters SET location_id = $2 WHERE id = $1`, [id, to]);
    await redis.hDel(`loc:${from.location_id}:players`, String(id));
    await audit('character.teleport', 1, id, { from: from.location_id, to });
    res.json({ ok: true });
  });

  app.post('/admin/api/characters/:id/mute', guard, async (req, res) => {
    const id = Number(req.params.id);
    const hours = Number((req.body || {}).hours) || 1;
    const reason = (req.body || {}).reason || null;
    await game.query(
      `INSERT INTO chat_sanctions (character_id, channel_type, muted_until, reason, issued_by)
       VALUES ($1, 2, now() + ($2 || ' hours')::interval, $3, 0)
       ON CONFLICT (character_id, channel_type)
       DO UPDATE SET muted_until = EXCLUDED.muted_until, reason = EXCLUDED.reason`,
      [id, String(hours), reason]);
    await audit('chat.mute', 1, id, { hours, reason });
    res.json({ ok: true });
  });

  // ================= аккаунты =================
  app.get('/admin/api/accounts', guard, async (req, res) => {
    const { rows } = await auth.query(
      `SELECT a.id, a.status, a.created_at, i.provider, i.external_id, tp.username,
              EXISTS (SELECT 1 FROM account_sanctions s
                       WHERE s.account_id = a.id AND s.type = 1
                         AND s.revoked_at IS NULL
                         AND (s.ends_at IS NULL OR s.ends_at > now())) AS banned
         FROM accounts a
         LEFT JOIN account_identities i ON i.account_id = a.id
         LEFT JOIN telegram_profiles tp ON tp.account_id = a.id
        ORDER BY a.id DESC LIMIT 100`);
    const ids = rows.map((r) => r.id);
    const chars = ids.length ? (await game.query(
      `SELECT account_id, string_agg(name, ', ') AS names FROM characters
        WHERE account_id = ANY($1) GROUP BY account_id`, [ids])).rows : [];
    const byAcc = Object.fromEntries(chars.map((c) => [c.account_id, c.names]));
    res.json(rows.map((r) => ({ ...r, characters: byAcc[r.id] || '' })));
  });

  app.post('/admin/api/accounts/:id/ban', guard, async (req, res) => {
    const id = Number(req.params.id);
    const hours = Number((req.body || {}).hours) || 0;
    const reason = (req.body || {}).reason || null;
    await auth.query(
      `INSERT INTO account_sanctions (account_id, type, reason, issued_by, ends_at)
       VALUES ($1, 1, $2, 0,
               CASE WHEN $3::int > 0 THEN now() + ($3::text || ' hours')::interval END)`,
      [id, reason, hours]);
    await audit('account.ban', 2, id, { hours: hours || 'forever', reason });
    res.json({ ok: true });
  });

  app.post('/admin/api/accounts/:id/unban', guard, async (req, res) => {
    const id = Number(req.params.id);
    await auth.query(
      `UPDATE account_sanctions SET revoked_at = now(), revoked_by = 0
        WHERE account_id = $1 AND type = 1 AND revoked_at IS NULL`, [id]);
    await audit('account.unban', 2, id, null);
    res.json({ ok: true });
  });

  // ================= бои: поиск по нику, фильтры, прерывание =================
  app.get('/admin/api/battles', guard, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const status = Number(req.query.status) || null;
    const type = Number(req.query.type) || null;
    const { rows } = await game.query(
      `SELECT DISTINCT b.id, b.type, b.status, b.winner_side, b.meta,
              l.name AS location, b.started_at, b.ended_at,
              (SELECT count(*) FROM battle_participants x
                WHERE x.battle_id = b.id) AS members,
              (SELECT string_agg(ch.name, ', ')
                 FROM battle_participants x JOIN characters ch ON ch.id = x.character_id
                WHERE x.battle_id = b.id) AS fighters
         FROM battles b
         JOIN locations l ON l.id = b.location_id
         LEFT JOIN battle_participants bp ON bp.battle_id = b.id
         LEFT JOIN characters c ON c.id = bp.character_id
        WHERE ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR b.id::text = $1)
          AND ($2::int IS NULL OR b.status = $2)
          AND ($3::int IS NULL OR b.type = $3)
        ORDER BY b.id DESC LIMIT 100`, [q, status, type]);
    res.json(rows);
  });

  app.get('/admin/api/battles/:id', guard, async (req, res) => {
    const id = Number(req.params.id);
    const battle = (await game.query(`SELECT * FROM battles WHERE id = $1`, [id])).rows[0];
    if (!battle) throw bad(404, 'not_found');
    const participants = (await game.query(
      `SELECT bp.*, ch.name FROM battle_participants bp
         JOIN characters ch ON ch.id = bp.character_id
        WHERE bp.battle_id = $1 ORDER BY bp.side`, [id])).rows;
    const rounds = (await game.query(
      `SELECT round_no, action_seq, actor_id, action_type, target_id, value, effects, ts
         FROM battle_rounds WHERE battle_id = $1
        ORDER BY round_no, action_seq LIMIT 500`, [id])).rows;
    res.json({ battle, participants, rounds });
  });

  app.post('/admin/api/battles/:id/abort', guard, async (req, res) => {
    const id = Number(req.params.id);
    const done = await adminAbort(id);
    if (!done) throw bad(400, 'battle_not_active');
    await audit('battle.abort', 4, id, null);
    res.json({ ok: true });
  });

  // ================= гроссбухи =================
  app.get('/admin/api/ledger', guard, async (req, res) => {
    const charId = Number(req.query.character_id) || null;
    const { rows } = await game.query(
      `SELECT cl.id, cl.created_at, cl.subject_type, cl.subject_id, ch.name,
              cur.code, cl.amount, cl.balance_after, cl.reason, cl.ref_id
         FROM currency_ledger cl
         JOIN currencies cur ON cur.id = cl.currency_id
         LEFT JOIN characters ch ON ch.id = cl.subject_id AND cl.subject_type = 1
        WHERE ($1::bigint IS NULL OR (cl.subject_type = 1 AND cl.subject_id = $1))
        ORDER BY cl.id DESC LIMIT 200`, [charId]);
    res.json(rows);
  });

  app.get('/admin/api/item-ledger', guard, async (req, res) => {
    const { rows } = await game.query(
      `SELECT il.id, il.created_at, t.name, il.item_instance_id, il.quantity,
              il.from_owner_type, il.from_owner_id, il.to_owner_type, il.to_owner_id,
              il.reason
         FROM item_ledger il JOIN item_templates t ON t.id = il.template_id
        ORDER BY il.id DESC LIMIT 200`);
    res.json(rows);
  });

  // ================= предметы: шаблоны и экземпляры =================
  app.get('/admin/api/item-templates', guard, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const type = Number(req.query.type) || null;
    const { rows } = await game.query(
      `SELECT t.*, (SELECT count(*) FROM item_instances i
                     WHERE i.template_id = t.id AND i.status = 1) AS instances
         FROM item_templates t
        WHERE ($1 = '' OR t.name ILIKE '%' || $1 || '%' OR t.id::text = $1)
          AND ($2::int IS NULL OR t.type = $2)
        ORDER BY t.id`, [q, type]);
    res.json(rows);
  });

  const ITEM_COLS = ['name', 'type', 'subtype', 'quality', 'level_req', 'slot',
    'base_stats', 'requirements', 'stackable', 'max_stack', 'tradable',
    'sellable', 'droppable', 'repairable', 'icon'];
  const JSON_COLS = new Set(['base_stats', 'requirements']);

  app.post('/admin/api/item-templates', guard, async (req, res) => {
    const b = req.body || {};
    const id = Number(b.id);
    if (!id || !b.name) throw bad(400, 'id_and_name_required');
    const exists = (await adminPg().query(
      `SELECT 1 FROM item_templates WHERE id = $1`, [id])).rows[0];
    const sets = [], vals = [id];
    for (const col of ITEM_COLS) if (col in b) {
      vals.push(JSON_COLS.has(col) ? JSON.stringify(b[col] ?? {}) : b[col]);
      sets.push(col);
    }
    if (exists) {
      await adminPg().query(
        `UPDATE item_templates SET ${sets.map((c, i) => `${c} = $${i + 2}`).join(', ')},
            version = version + 1 WHERE id = $1`, vals);
    } else {
      await adminPg().query(
        `INSERT INTO item_templates (id, ${sets.join(', ')})
         VALUES ($1, ${sets.map((c, i) => `$${i + 2}`).join(', ')})`, vals);
    }
    await audit('item_template.save', 3, id, b);
    res.json({ ok: true });
  });

  app.get('/admin/api/item-instances', guard, async (req, res) => {
    const templateId = Number(req.query.template_id) || null;
    const charId = Number(req.query.character_id) || null;
    const { rows } = await game.query(
      `SELECT i.id, i.template_id, t.name, i.owner_type, i.owner_id, ch.name AS owner_name,
              i.slot, i.quantity, i.enchant_level, i.props, i.status, i.created_at
         FROM item_instances i
         JOIN item_templates t ON t.id = i.template_id
         LEFT JOIN characters ch ON ch.id = i.owner_id AND i.owner_type IN (1, 2, 3)
        WHERE i.status = 1
          AND ($1::int IS NULL OR i.template_id = $1)
          AND ($2::bigint IS NULL OR (i.owner_id = $2 AND i.owner_type IN (1, 2, 3)))
        ORDER BY i.id DESC LIMIT 200`, [templateId, charId]);
    res.json(rows);
  });

  // изъять предмет у владельца (уходит «системе», след — в item_ledger)
  app.post('/admin/api/item-instances/:id/confiscate', guard, async (req, res) => {
    const id = Number(req.params.id);
    const note = (req.body || {}).note || null;
    await tx(async (c) => {
      const it = (await c.query(
        `SELECT * FROM item_instances WHERE id = $1 AND status = 1 FOR UPDATE`,
        [id])).rows[0];
      if (!it) throw bad(404, 'not_found');
      await c.query(
        `UPDATE item_instances SET owner_type = 8, owner_id = 0, slot = NULL,
            version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await c.query(
        `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id,
            quantity, from_owner_type, from_owner_id, to_owner_type, to_owner_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, 8, 0, 11)`,
        [randomUUID(), it.id, it.template_id, it.quantity, it.owner_type, it.owner_id]);
    });
    await audit('item.confiscate', 5, id, { note });
    res.json({ ok: true });
  });

  // правка экземпляра: заточка и props (всё остальное — у шаблона)
  app.post('/admin/api/item-instances/:id/edit', guard, async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    await game.query(
      `UPDATE item_instances SET
          enchant_level = COALESCE($2, enchant_level),
          props = COALESCE($3, props),
          version = version + 1, updated_at = now()
        WHERE id = $1 AND status = 1`,
      [id, b.enchant_level ?? null, b.props ? JSON.stringify(b.props) : null]);
    await audit('item.edit', 5, id, b);
    res.json({ ok: true });
  });

  // ================= квесты =================
  app.get('/admin/api/quests', guard, async (req, res) => {
    const { rows } = await game.query(
      `SELECT q.*, (SELECT count(*) FROM character_quests cq
                     WHERE cq.quest_id = q.id AND cq.status = 2) AS completed_by
         FROM quest_templates q ORDER BY q.id`);
    res.json(rows);
  });

  app.post('/admin/api/quests', guard, async (req, res) => {
    const b = req.body || {};
    const id = Number(b.id);
    if (!id || !b.name) throw bad(400, 'id_and_name_required');
    await adminPg().query(
      `INSERT INTO quest_templates (id, type, repeatable, name, description, image,
          level_req, active, objectives, rewards, prereq)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, '{}')
       ON CONFLICT (id) DO UPDATE SET
          repeatable = $2, name = $3, description = $4, image = $5,
          level_req = $6, active = $7, objectives = $8, rewards = $9,
          version = quest_templates.version + 1`,
      [id, Number(b.repeatable) || 1, b.name, b.description || null, b.image || null,
       Number(b.level_req) || 1, b.active !== false,
       JSON.stringify(b.objectives || {}), JSON.stringify(b.rewards || {})]);
    await audit('quest.save', 6, id, b);
    res.json({ ok: true });
  });

  // загрузка картинки квеста: тело запроса = файл, ?name=исходное_имя
  app.post('/admin/api/upload', guard,
    express.raw({ type: () => true, limit: '8mb' }),
    async (req, res) => {
      const raw = String(req.query.name || 'image.png');
      const safe = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(-60);
      const file = randomUUID().slice(0, 8) + '-' + safe;
      const dir = process.env.UPLOADS_DIR || '/app/uploads';
      fs.writeFileSync(dir + '/' + file, req.body);
      await audit('upload', null, null, { file, bytes: req.body.length });
      res.json({ ok: true, url: '/uploads/' + file });
    });

  // ================= аукцион и почта (просмотр) =================
  app.get('/admin/api/auction', guard, async (req, res) => {
    const { rows } = await game.query(
      `SELECT a.id, t.name AS item, a.quantity, s.name AS seller,
              a.start_price, a.buyout_price, a.current_bid, b.name AS bidder,
              a.status, a.created_at, a.ends_at
         FROM auction_lots a
         JOIN item_instances i ON i.id = a.item_instance_id
         JOIN item_templates t ON t.id = i.template_id
         JOIN characters s ON s.id = a.seller_id
         LEFT JOIN characters b ON b.id = a.current_bidder_id
        ORDER BY a.id DESC LIMIT 100`);
    res.json(rows);
  });

  app.get('/admin/api/mail', guard, async (req, res) => {
    const { rows } = await game.query(
      `SELECT m.id, m.type, r.name AS recipient, s.name AS sender, m.subject,
              m.money_attached, m.has_attachments, m.attachments_taken,
              m.is_read, m.created_at
         FROM mail_messages m
         JOIN characters r ON r.id = m.recipient_id
         LEFT JOIN characters s ON s.id = m.sender_id
        ORDER BY m.id DESC LIMIT 100`);
    res.json(rows);
  });

  // ================= чат, конфиг, справочники, аудит =================
  app.get('/admin/api/chat', guard, async (req, res) => {
    const { rows } = await game.query(
      `SELECT m.created_at, c.type, c.ref_id, m.sender_id, m.sender_name, m.body
         FROM chat_messages m JOIN chat_channels c ON c.id = m.channel_id
        ORDER BY m.created_at DESC LIMIT 100`);
    res.json(rows);
  });

  app.get('/admin/api/config', guard, async (req, res) => {
    const { rows } = await game.query(
      `SELECT key, value, version, updated_at FROM game_config ORDER BY key`);
    res.json(rows);
  });

  app.post('/admin/api/config', guard, async (req, res) => {
    const { key, value } = req.body || {};
    if (!key) throw bad(400, 'bad_request');
    await game.query(
      `INSERT INTO game_config (key, value, updated_by) VALUES ($1, $2, 0)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
          version = game_config.version + 1, updated_by = 0, updated_at = now()`,
      [key, JSON.stringify(value)]);
    clearConfigCache();
    await audit('config.set', null, null, { key, value });
    res.json({ ok: true });
  });

  app.get('/admin/api/locations', guard, async (req, res) => {
    res.json((await game.query(
      `SELECT id, name, type, min_level FROM locations ORDER BY id`)).rows);
  });

  app.get('/admin/api/audit', guard, async (req, res) => {
    res.json((await game.query(
      `SELECT id, action, target_type, target_id, details, ts
         FROM admin_audit ORDER BY id DESC LIMIT 200`)).rows);
  });
}
