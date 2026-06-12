import { game, tx } from './db.js';
import { addCurrency, CUR } from './economy.js';
import { addExp } from './characters.js';
import { randomUUID } from 'crypto';

/**
 * Этап 1: задания отслеживаются автоматически (без принятия).
 * Цель в objectives: { "kind": "hunt_wins", "count": N }.
 * Награды в rewards: { "copper": n, "exp": n, "items": [templateId, ...] }.
 * repeatable: 1 once, 2 daily, 3 weekly. Создаются и правятся в админке.
 */
export async function onHuntVictory(charId, notify) {
  const ch = (await game.query(
    `SELECT level FROM characters WHERE id = $1`, [charId])).rows[0];
  if (!ch) return;
  const tpls = (await game.query(
    `SELECT * FROM quest_templates WHERE active AND level_req <= $1 ORDER BY id`,
    [ch.level])).rows;

  for (const t of tpls) {
    const obj = t.objectives || {};
    if (obj.kind !== 'hunt_wins') continue;
    const need = Math.max(1, Number(obj.count) || 1);

    const row = (await game.query(
      `SELECT * FROM character_quests WHERE character_id = $1 AND quest_id = $2`,
      [charId, t.id])).rows[0];
    if (row) {
      if (row.status === 2 && t.repeatable === 1) continue;             // once и сделан
      if (row.available_again_at && new Date(row.available_again_at) > new Date()) continue;
    }
    const prev = row && row.status === 1 ? Number((row.progress || {}).count || 0) : 0;
    const count = prev + 1;

    if (count < need) {
      await game.query(
        `INSERT INTO character_quests (character_id, quest_id, status, progress)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (character_id, quest_id)
         DO UPDATE SET status = 1, progress = $3, accepted_at = now(),
                       completed_at = NULL, available_again_at = NULL`,
        [charId, t.id, JSON.stringify({ count })]);
      notify(`Задание «${t.name}»: ${count}/${need}`);
      continue;
    }

    const r = t.rewards || {};
    const again = t.repeatable === 2 ? `now() + interval '1 day'`
                : t.repeatable === 3 ? `now() + interval '7 days'` : 'NULL';
    await tx(async (c) => {
      if (r.copper) await addCurrency(c, charId, CUR.copper, Number(r.copper), 1,
        { idempotencyKey: randomUUID(), type: 2, id: t.id });
      if (r.exp) await addExp(c, charId, Number(r.exp));
      for (const tplId of r.items || []) {
        const ins = await c.query(
          `INSERT INTO item_instances (template_id, owner_type, owner_id)
           VALUES ($1, 1, $2) RETURNING id`, [tplId, charId]);
        await c.query(
          `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id,
              quantity, to_owner_type, to_owner_id, reason, ref_type, ref_id)
           VALUES ($1, $2, $3, 1, 1, $4, 2, 2, $5)`,
          [randomUUID(), ins.rows[0].id, tplId, charId, t.id]);
      }
      await c.query(
        `INSERT INTO character_quests (character_id, quest_id, status, progress,
            completed_at, available_again_at)
         VALUES ($1, $2, 2, $3, now(), ${again})
         ON CONFLICT (character_id, quest_id)
         DO UPDATE SET status = 2, progress = $3, completed_at = now(),
                       available_again_at = ${again}`,
        [charId, t.id, JSON.stringify({ count })]);
    });
    const parts = [];
    if (r.copper) parts.push(`+${r.copper} меди`);
    if (r.exp) parts.push(`+${r.exp} опыта`);
    if ((r.items || []).length) parts.push(`предметы: ${r.items.length}`);
    notify(`Задание «${t.name}» выполнено! ${parts.join(', ')}`);
  }
}
