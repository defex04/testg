import { randomUUID } from 'crypto';
import { game, tx } from './db.js';
import { addCurrency, moneyBalanceCopper, CUR } from './economy.js';
import { addExp } from './characters.js';

const bad = (status, msg) => Object.assign(new Error(msg), { status });

const REPEAT_INTERVAL = {
  2: "now() + interval '1 day'",
  3: "now() + interval '7 days'",
};

const MONEY_LABEL = {
  copper: 'меди',
  silver: 'серебра',
  gold: 'золота',
  diamond: 'бриллиантов',
  valor: 'доблести',
};

const asInt = (v, fallback = 0) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
};

const asId = (v) => {
  const n = asInt(v, 0);
  return n > 0 ? n : null;
};

const toArray = (v) => Array.isArray(v) ? v : (v == null ? [] : [v]);

const objNpcId = (o = {}) => asId(o.npcId ?? o.npc_id ?? o.targetNpcId ?? o.target_npc_id);
const objTemplateId = (o = {}) => asId(o.templateId ?? o.template_id ?? o.itemId ?? o.item_id);
const objCurrency = (o = {}) => String(o.currency || o.code || 'copper');
const objNeed = (o = {}) => Math.max(1, asInt(o.count ?? o.amount ?? 1, 1));

function normalizeObjective(o = {}) {
  const kind = String(o.kind || o.type || 'talk');
  if (kind === 'hunt_wins') return { ...o, kind: 'kill', count: objNeed(o) };
  if (kind === 'money') return { ...o, kind, currency: objCurrency(o),
    amount: Math.max(1, asInt(o.amount ?? o.count, 1)) };
  if (kind === 'item' || kind === 'resource') return { ...o, kind: 'item',
    templateId: objTemplateId(o), count: objNeed(o), consume: o.consume !== false };
  if (kind === 'kill' || kind === 'talk') return { ...o, kind,
    npcId: objNpcId(o), count: objNeed(o) };
  return { ...o, kind, count: objNeed(o) };
}

function normalizeStage(s, i = 0) {
  const objectives = toArray(s.objectives ?? s.all ?? s).map(normalizeObjective);
  return {
    id: s.id ?? `stage-${i + 1}`,
    title: s.title || s.name || (objectives.length > 1 ? `Этап ${i + 1}` : ''),
    text: s.text || s.description || '',
    objectives,
  };
}

export function normalizeObjectives(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (src.kind === 'hunt_wins') {
    return { mode: 'all', stages: [normalizeStage({ objectives: [src] })] };
  }
  if (Array.isArray(raw)) {
    return { mode: 'all', stages: [normalizeStage({ objectives: raw })] };
  }
  if (Array.isArray(src.stages)) {
    return { mode: src.mode === 'all' ? 'all' : 'sequence',
      stages: src.stages.map(normalizeStage).filter((s) => s.objectives.length) };
  }
  if (Array.isArray(src.all) || Array.isArray(src.objectives)) {
    return { mode: 'all',
      stages: [normalizeStage({ title: src.title, objectives: src.all || src.objectives })] };
  }
  if (src.kind || src.type) {
    return { mode: 'all', stages: [normalizeStage({ objectives: [src] })] };
  }
  return { mode: 'all', stages: [] };
}

function objectiveKey(o, index) {
  if (o.id != null && String(o.id).trim()) return String(o.id);
  if (o.kind === 'kill' || o.kind === 'talk') return `${o.kind}:${o.npcId || 'any'}:${index}`;
  if (o.kind === 'item') return `item:${o.templateId || 'any'}:${index}`;
  if (o.kind === 'money') return `money:${o.currency || 'copper'}:${index}`;
  return `${o.kind}:${index}`;
}

function normalizeProgress(progress = {}) {
  const p = progress && typeof progress === 'object' ? progress : {};
  return {
    ...p,
    stage: Math.max(0, asInt(p.stage, 0)),
    counters: p.counters && typeof p.counters === 'object' ? { ...p.counters } : {},
  };
}

function counter(progress, key) {
  const direct = asInt(progress.counters?.[key], NaN);
  if (Number.isFinite(direct)) return direct;
  if (key.startsWith('kill:') && progress.count != null) return asInt(progress.count, 0);
  return 0;
}

function setCounter(progress, key, value) {
  const p = normalizeProgress(progress);
  p.counters[key] = Math.max(0, asInt(value, 0));
  delete p.count;
  return p;
}

async function npcName(client, id) {
  if (!id) return 'любого противника';
  const r = (await client.query(`SELECT name FROM npc_templates WHERE id = $1`, [id])).rows[0];
  return r ? r.name : `NPC #${id}`;
}

async function itemName(client, id) {
  if (!id) return 'предмет';
  const r = (await client.query(`SELECT name FROM item_templates WHERE id = $1`, [id])).rows[0];
  return r ? r.name : `предмет #${id}`;
}

async function itemQuantity(client, charId, templateId) {
  if (!templateId) return 0;
  const { rows } = await client.query(
    `SELECT COALESCE(sum(quantity), 0)::int AS qty
       FROM item_instances
      WHERE owner_type = 1 AND owner_id = $1 AND status = 1 AND template_id = $2`,
    [charId, templateId]);
  return Number(rows[0]?.qty) || 0;
}

const moneyInCopper = (currency, amount) => {
  const n = BigInt(Math.max(0, asInt(amount, 0)));
  if (currency === 'copper') return n;
  if (currency === 'silver') return n * 1000n;
  if (currency === 'gold') return n * 1000n * 1000n;
  return null;
};

async function currencyEnough(client, charId, currency, amount, lock = false) {
  const moneyNeed = moneyInCopper(currency, amount);
  if (moneyNeed != null) return (await moneyBalanceCopper(client, charId, lock)) >= moneyNeed;
  const currencyId = CUR[currency];
  if (!currencyId) return false;
  const row = (await client.query(
    `SELECT COALESCE(balance, 0)::bigint AS balance
       FROM character_currencies
      WHERE character_id = $1 AND currency_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [charId, currencyId])).rows[0];
  return BigInt(row?.balance || 0) >= BigInt(Math.max(0, asInt(amount, 0)));
}

async function objectiveView(client, charId, o, progress, index) {
  const key = objectiveKey(o, index);
  if (o.kind === 'kill') {
    const need = objNeed(o);
    const current = Math.min(need, counter(progress, key));
    const name = await npcName(client, o.npcId);
    return { key, kind: o.kind, current, need, done: current >= need,
      text: `Победить: ${name}`, consume: false };
  }
  if (o.kind === 'talk') {
    const need = objNeed(o);
    const current = Math.min(need, counter(progress, key));
    const name = await npcName(client, o.npcId);
    return { key, kind: o.kind, current, need, done: current >= need,
      text: `Поговорить: ${name}`, consume: false };
  }
  if (o.kind === 'item') {
    const need = objNeed(o);
    const current = Math.min(need, await itemQuantity(client, charId, o.templateId));
    const name = await itemName(client, o.templateId);
    return { key, kind: o.kind, templateId: o.templateId, current, need,
      done: current >= need, text: `Принести: ${name}`, consume: o.consume !== false };
  }
  if (o.kind === 'money') {
    const need = Math.max(1, asInt(o.amount ?? o.count, 1));
    const currency = objCurrency(o);
    const ok = await currencyEnough(client, charId, currency, need, false);
    return { key, kind: o.kind, currency, current: ok ? need : 0, need,
      done: ok, text: `Принести: ${need} ${MONEY_LABEL[currency] || currency}`,
      consume: o.consume !== false };
  }
  const need = objNeed(o);
  const current = Math.min(need, counter(progress, key));
  return { key, kind: o.kind, current, need, done: current >= need,
    text: o.label || o.name || o.kind, consume: false };
}

async function questProgressView(client, charId, q, row = null) {
  const norm = normalizeObjectives(q.objectives || {});
  const progress = normalizeProgress(row?.progress || {});
  const stageIndex = Math.min(progress.stage, Math.max(0, norm.stages.length - 1));
  const stage = norm.stages[stageIndex] || { title: '', objectives: [] };
  const objectives = [];
  for (let i = 0; i < stage.objectives.length; i++) {
    objectives.push(await objectiveView(client, charId, stage.objectives[i], progress, `${stageIndex}:${i}`));
  }
  const ready = objectives.length > 0 && objectives.every((o) => o.done);
  return {
    stage: stageIndex,
    stages: norm.stages.length,
    stageTitle: stage.title || '',
    stageText: stage.text || '',
    objectives,
    ready,
    finalReady: ready && stageIndex >= norm.stages.length - 1,
    progress,
    norm,
  };
}

function rewardText(rewards = {}) {
  const r = rewards || {};
  const parts = [];
  for (const [code, label] of Object.entries(MONEY_LABEL)) {
    const n = asInt((r.currencies || {})[code] ?? r[code], 0);
    if (n) parts.push(`+${n} ${label}`);
  }
  if (r.exp) parts.push(`+${r.exp} опыта`);
  const items = toArray(r.items).length;
  if (items) parts.push(`предметы: ${items}`);
  return parts.join(', ');
}

function rewardItemSpec(reward) {
  const templateId = asId(reward?.templateId ?? reward?.template_id ?? reward?.id ?? reward);
  if (!templateId) return null;
  return {
    templateId,
    count: Math.max(1, asInt(reward?.count ?? reward?.quantity ?? 1, 1)),
  };
}

function rewardItemKind(tpl) {
  const type = Number(tpl?.type);
  if (type === 1) return 'weapon';
  if (type === 2) return 'armor';
  if (type === 5) return 'amulet';
  if (type === 4) {
    const s = tpl.base_stats || {};
    if (s.escape) return 'escape';
    if (s.scroll === 'poison') return 'poison';
    if (s.scroll === 'heal') return 'heal_scroll';
    if (s.scroll === 'cleanse') return 'cleanse';
    if (s.kind === 'mana' || s.mana_pct != null) return 'mana';
    if (s.kind === 'blood' || s.crit_add != null) return 'blood';
    if (s.power_mult != null) return 'power';
    if (s.heal_pct != null || s.heal != null) return 'health';
    return 'elixir';
  }
  if (type === 3 || type === 6) return 'resource';
  return 'item';
}

async function rewardItemsView(client, rewards = {}) {
  const specs = toArray(rewards.items).map(rewardItemSpec).filter(Boolean);
  if (!specs.length) return [];
  const ids = [...new Set(specs.map((s) => s.templateId))];
  const { rows } = await client.query(
    `SELECT id, name, type, quality, level_req, slot, base_stats, icon, stackable
       FROM item_templates
      WHERE id = ANY($1::int[])`, [ids]);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return specs.map((spec) => {
    const tpl = byId.get(spec.templateId);
    if (!tpl) return null;
    return {
      templateId: Number(tpl.id),
      count: spec.count,
      name: tpl.name,
      icon: tpl.icon || null,
      type: Number(tpl.type) || 0,
      kind: rewardItemKind(tpl),
      quality: Number(tpl.quality) || 1,
      levelReq: Number(tpl.level_req) || 1,
      slot: tpl.slot != null ? Number(tpl.slot) : null,
      stats: tpl.base_stats || null,
      stackable: tpl.stackable === true,
    };
  }).filter(Boolean);
}

async function prereqOk(client, charId, q, level) {
  const p = q.prereq || {};
  const minLevel = Math.max(asInt(p.level ?? p.minLevel ?? 1, 1), asInt(q.level_req, 1));
  if (level < minLevel) return { ok: false, reason: 'level_too_low', minLevel };
  const quests = toArray(p.quests ?? p.quest ?? p.quest_id).map(asId).filter(Boolean);
  for (const questId of quests) {
    const done = (await client.query(
      `SELECT 1 FROM character_quests
        WHERE character_id = $1 AND quest_id = $2 AND status = 2
        LIMIT 1`, [charId, questId])).rows[0];
    if (!done) return { ok: false, reason: 'prereq_quest', questId };
  }
  return { ok: true };
}

async function questRow(client, charId, questId) {
  return (await client.query(
    `SELECT * FROM character_quests WHERE character_id = $1 AND quest_id = $2`,
    [charId, questId])).rows[0] || null;
}

async function questTemplate(client, questId) {
  const row = (await client.query(
    `SELECT * FROM quest_templates WHERE id = $1 AND active = TRUE`, [questId])).rows[0];
  if (!row) throw bad(404, 'quest_not_found');
  return row;
}

async function charLevelAndLocation(client, charId) {
  const row = (await client.query(
    `SELECT id, level, location_id FROM characters WHERE id = $1 AND status = 1`,
    [charId])).rows[0];
  if (!row) throw bad(404, 'character_not_found');
  return row;
}

async function validateNpcHere(client, charId, npcId) {
  if (!npcId) return null;
  const row = (await client.query(
    `SELECT t.id, t.name, t.image, t.description, t.kind
       FROM characters ch
       JOIN npc_spawns s ON s.location_id = ch.location_id
       JOIN npc_templates t ON t.id = s.npc_template_id
      WHERE ch.id = $1 AND t.id = $2 AND t.active = TRUE
        AND t.kind IN (2, 3)`,
    [charId, npcId])).rows[0];
  if (!row) throw bad(404, 'npc_not_here');
  return row;
}

function questNpcInvolved(q, npcId, view, row) {
  if (!npcId) return true;
  if (asId(q.giver_npc_id) === npcId || asId(q.turnin_npc_id) === npcId) return true;
  if (row?.status === 1) {
    const stage = view.norm.stages[view.stage] || { objectives: [] };
    return stage.objectives.some((o) => o.kind === 'talk' && objNpcId(o) === npcId);
  }
  return false;
}

function dialogueText(q, status, view) {
  const d = q.dialogue || {};
  if (status === 'ready') return d.ready || d.progress || q.description || '';
  if (status === 'active') return d.progress || q.description || '';
  if (status === 'completed') return d.done || d.completed || '';
  if (status === 'cooldown') return d.cooldown || d.done || d.completed || '';
  return d.greeting || d.start || q.description || '';
}

const textLines = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
};

function conversationFor(q, npcId, view) {
  const stage = view.norm.stages[view.stage] || { objectives: [] };
  const talkIndex = stage.objectives.findIndex((o) =>
    o.kind === 'talk' && objNpcId(o) === npcId);
  if (talkIndex < 0) return null;
  const activeTalk = view.objectives[talkIndex];
  if (!activeTalk || activeTalk.done) return null;

  const d = q.dialogue || {};
  const byNpc = d.talk?.[npcId] ?? d.talk?.[String(npcId)]
    ?? d.talkSteps?.[npcId] ?? d.talkSteps?.[String(npcId)]
    ?? d.steps?.[npcId] ?? d.steps?.[String(npcId)];
  let steps = textLines(byNpc);
  if (!steps.length) {
    steps = textLines(d.talk || d.talkSteps || d.conversation || d.steps);
  }
  if (!steps.length) {
    steps = [
      stage.text || d.progress || d.greeting || q.description || '',
      'Я рассказал всё, что знаю. Теперь можно возвращаться к поручению.',
    ].filter(Boolean);
  }
  if (steps.length === 1) steps.push('Разговор окончен. Запомни главное и передай дальше.');
  return {
    questId: q.id,
    npcId,
    title: stage.title || q.name,
    steps,
    finishLabel: d.finishLabel || 'Завершить разговор',
  };
}

async function dialogEntries(client, charId, npcId) {
  const ch = await charLevelAndLocation(client, charId);
  const { rows: quests } = await client.query(
    `SELECT q.*, cq.status AS cq_status, cq.progress AS cq_progress,
            cq.completed_at, cq.available_again_at
       FROM quest_templates q
       LEFT JOIN character_quests cq
         ON cq.quest_id = q.id AND cq.character_id = $1
      WHERE q.active = TRUE
      ORDER BY q.id`, [charId]);

  const entries = [];
  for (const q of quests) {
    const row = q.cq_status ? {
      status: q.cq_status,
      progress: q.cq_progress,
      completed_at: q.completed_at,
      available_again_at: q.available_again_at,
    } : null;
    const view = await questProgressView(client, charId, q, row);
    if (!questNpcInvolved(q, npcId, view, row)) continue;

    const prereq = await prereqOk(client, charId, q, Number(ch.level));
    let status = 'available';
    let canAccept = false;
    let canComplete = false;
    let canAdvance = false;
    let statusText = 'Доступно';

    if (!prereq.ok) {
      if (asId(q.giver_npc_id) !== npcId) continue;
      status = 'locked';
      statusText = prereq.reason === 'level_too_low'
        ? `Нужен уровень ${prereq.minLevel}`
        : `Нужно выполнить задание #${prereq.questId}`;
    } else if (!row) {
      if (asId(q.giver_npc_id) && asId(q.giver_npc_id) !== npcId) continue;
      canAccept = true;
    } else if (Number(row.status) === 1) {
      status = view.ready ? 'ready' : 'active';
      canComplete = view.finalReady && (!asId(q.turnin_npc_id) || asId(q.turnin_npc_id) === npcId);
      canAdvance = view.ready && !view.finalReady;
      if (canAdvance && asId(q.turnin_npc_id) && asId(q.turnin_npc_id) !== npcId) canAdvance = false;
      statusText = view.ready
        ? (view.finalReady ? 'Можно завершить' : 'Этап выполнен')
        : 'В процессе';
    } else if (Number(row.status) === 2) {
      const again = row.available_again_at && new Date(row.available_again_at) <= new Date();
      if (Number(q.repeatable) > 1 && again && asId(q.giver_npc_id) === npcId) {
        status = 'available';
        canAccept = true;
        statusText = 'Можно повторить';
      } else {
        status = row.available_again_at ? 'cooldown' : 'completed';
        statusText = row.available_again_at
          ? `Повтор после ${new Date(row.available_again_at).toLocaleString('ru-RU')}`
          : 'Завершено';
      }
    }
    const conversation = row && Number(row.status) === 1
      ? conversationFor(q, npcId, view) : null;

    entries.push({
      id: q.id,
      name: q.name,
      description: q.description,
      image: q.image,
      status,
      statusText,
      canAccept,
      canComplete,
      canAdvance,
      canTalk: !!conversation,
      conversation,
      dialogue: dialogueText(q, status, view),
      repeatable: q.repeatable,
      rewards: q.rewards || {},
      rewardText: rewardText(q.rewards || {}),
      rewardItems: await rewardItemsView(client, q.rewards || {}),
      progress: {
        stage: view.stage,
        stages: view.stages,
        stageTitle: view.stageTitle,
        stageText: view.stageText,
        ready: view.ready,
        finalReady: view.finalReady,
        objectives: view.objectives,
      },
    });
  }
  return entries;
}

async function addRewardItem(client, charId, questId, reward) {
  const templateId = asId(reward.templateId ?? reward.template_id ?? reward.id ?? reward);
  if (!templateId) return;
  const count = Math.max(1, asInt(reward.count ?? reward.quantity ?? 1, 1));
  const tpl = (await client.query(
    `SELECT id, stackable FROM item_templates WHERE id = $1`, [templateId])).rows[0];
  if (!tpl) throw bad(404, `reward_item_not_found:${templateId}`);
  const qty = tpl.stackable ? count : 1;
  const times = tpl.stackable ? 1 : count;
  for (let i = 0; i < times; i++) {
    const ins = await client.query(
      `INSERT INTO item_instances (template_id, owner_type, owner_id, quantity)
       VALUES ($1, 1, $2, $3) RETURNING id`, [templateId, charId, qty]);
    await client.query(
      `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id,
          quantity, to_owner_type, to_owner_id, reason, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, 1, $5, 2, 2, $6)`,
      [randomUUID(), ins.rows[0].id, templateId, qty, charId, questId]);
  }
}

async function grantRewards(client, charId, questId, rewards = {}) {
  const currencies = { ...(rewards.currencies || {}) };
  for (const code of Object.keys(MONEY_LABEL)) {
    if (rewards[code] != null) currencies[code] = rewards[code];
  }
  for (const [code, amount] of Object.entries(currencies)) {
    const currencyId = CUR[code];
    const n = asInt(amount, 0);
    if (currencyId && n) {
      await addCurrency(client, charId, currencyId, n, 1,
        { idempotencyKey: randomUUID(), type: 2, id: questId });
    }
  }
  if (rewards.exp) await addExp(client, charId, asInt(rewards.exp, 0));
  for (const reward of toArray(rewards.items)) await addRewardItem(client, charId, questId, reward);
}

async function consumeItemObjective(client, charId, questId, o) {
  if (o.consume === false) return;
  const templateId = objTemplateId(o);
  const need = objNeed(o);
  const { rows } = await client.query(
    `SELECT id, template_id, owner_type, owner_id, quantity
       FROM item_instances
      WHERE owner_type = 1 AND owner_id = $1 AND status = 1 AND template_id = $2
      ORDER BY id FOR UPDATE`, [charId, templateId]);
  let left = need;
  for (const item of rows) {
    if (left <= 0) break;
    const take = Math.min(left, Number(item.quantity) || 0);
    if (take <= 0) continue;
    left -= take;
    if (take >= Number(item.quantity)) {
      await client.query(
        `UPDATE item_instances SET status = 2, deleted_at = now(),
            version = version + 1, updated_at = now()
          WHERE id = $1`, [item.id]);
    } else {
      await client.query(
        `UPDATE item_instances SET quantity = quantity - $2,
            version = version + 1, updated_at = now()
          WHERE id = $1`, [item.id, take]);
    }
    await client.query(
      `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id,
          quantity, from_owner_type, from_owner_id, reason, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, 2, 2, $7)`,
      [randomUUID(), item.id, item.template_id, take, item.owner_type, item.owner_id, questId]);
  }
  if (left > 0) throw bad(400, 'not_enough_items');
}

async function consumeObjective(client, charId, questId, o) {
  if (o.kind === 'item') return consumeItemObjective(client, charId, questId, o);
  if (o.kind === 'money' && o.consume !== false) {
    const currency = objCurrency(o);
    const currencyId = CUR[currency];
    if (!currencyId) throw bad(400, 'bad_currency');
    await addCurrency(client, charId, currencyId, -Math.max(1, asInt(o.amount ?? o.count, 1)),
      1, { idempotencyKey: randomUUID(), type: 2, id: questId });
  }
}

function repeatSql(repeatable) {
  return REPEAT_INTERVAL[Number(repeatable)] || 'NULL';
}

async function acceptQuestInternal(client, charId, questId, npcId = null) {
  const q = await questTemplate(client, questId);
  const ch = await charLevelAndLocation(client, charId);
  if (asId(q.giver_npc_id) && asId(q.giver_npc_id) !== npcId) throw bad(400, 'wrong_npc');
  if (npcId) await validateNpcHere(client, charId, npcId);
  const prereq = await prereqOk(client, charId, q, Number(ch.level));
  if (!prereq.ok) throw bad(400, prereq.reason);
  const row = await questRow(client, charId, questId);
  if (row?.status === 1) return { ok: true, already: true };
  if (row?.status === 2) {
    if (Number(q.repeatable) <= 1) throw bad(400, 'quest_already_done');
    if (row.available_again_at && new Date(row.available_again_at) > new Date())
      throw bad(400, 'quest_on_cooldown');
  }
  await client.query(
    `INSERT INTO character_quests (character_id, quest_id, status, progress,
        accepted_at, completed_at, available_again_at)
     VALUES ($1, $2, 1, $3, now(), NULL, NULL)
     ON CONFLICT (character_id, quest_id) DO UPDATE SET
        status = 1, progress = EXCLUDED.progress, accepted_at = now(),
        completed_at = NULL, available_again_at = NULL`,
    [charId, questId, JSON.stringify({ stage: 0, counters: {} })]);
  return { ok: true };
}

export async function acceptQuest(charId, questId, npcId = null) {
  return tx((client) => acceptQuestInternal(client, charId, questId, npcId));
}

async function completeQuestInternal(client, charId, questId, npcId = null) {
  const q = await questTemplate(client, questId);
  const row = await questRow(client, charId, questId);
  if (!row || Number(row.status) !== 1) throw bad(400, 'quest_not_active');
  if (npcId) await validateNpcHere(client, charId, npcId);
  const finishNpc = asId(q.turnin_npc_id) || asId(q.giver_npc_id);
  if (finishNpc && finishNpc !== npcId) throw bad(400, 'wrong_npc');

  const view = await questProgressView(client, charId, q, row);
  if (!view.ready) throw bad(400, 'quest_not_ready');
  const stage = view.norm.stages[view.stage] || { objectives: [] };
  for (const o of stage.objectives) await consumeObjective(client, charId, q.id, o);

  if (!view.finalReady) {
    const next = normalizeProgress(row.progress);
    next.stage = view.stage + 1;
    await client.query(
      `UPDATE character_quests SET progress = $3, accepted_at = accepted_at
        WHERE character_id = $1 AND quest_id = $2`,
      [charId, questId, JSON.stringify(next)]);
    return { ok: true, advanced: true, stage: next.stage };
  }

  await grantRewards(client, charId, q.id, q.rewards || {});
  const again = repeatSql(q.repeatable);
  await client.query(
    `UPDATE character_quests
        SET status = 2, progress = $3, completed_at = now(),
            available_again_at = ${again}
      WHERE character_id = $1 AND quest_id = $2`,
    [charId, questId, JSON.stringify(view.progress)]);
  await client.query(
    `INSERT INTO quest_history (character_id, quest_id, completed_at)
     VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
    [charId, questId]);
  return { ok: true, completed: true, rewards: q.rewards || {} };
}

export async function completeQuest(charId, questId, npcId = null) {
  return tx((client) => completeQuestInternal(client, charId, questId, npcId));
}

async function incrementActiveObjective(charId, kind, match, notify, questId = null) {
  const { rows } = await game.query(
    `SELECT q.*, cq.progress
       FROM character_quests cq
       JOIN quest_templates q ON q.id = cq.quest_id
      WHERE cq.character_id = $1 AND cq.status = 1 AND q.active = TRUE
        AND ($2::int IS NULL OR q.id = $2)
      ORDER BY q.id`, [charId, questId]);
  let updated = 0;
  for (const q of rows) {
    const view = await questProgressView(game, charId, q, { progress: q.progress });
    const stage = view.norm.stages[view.stage] || { objectives: [] };
    let progress = normalizeProgress(q.progress);
    let changed = false;
    for (let i = 0; i < stage.objectives.length; i++) {
      const o = stage.objectives[i];
      if (o.kind !== kind || !match(o)) continue;
      const key = objectiveKey(o, `${view.stage}:${i}`);
      const need = objNeed(o);
      const cur = counter(progress, key);
      if (cur < need) {
        progress = setCounter(progress, key, cur + 1);
        changed = true;
      }
    }
    if (!changed) continue;
    updated++;
    await game.query(
      `UPDATE character_quests SET progress = $3
        WHERE character_id = $1 AND quest_id = $2`,
      [charId, q.id, JSON.stringify(progress)]);
    const after = await questProgressView(game, charId, q, { progress });
    const line = after.objectives.map((o) => `${o.text}: ${o.current}/${o.need}`).join('; ');
    notify?.(`Задание «${q.name}»: ${line}`);
    if (after.ready) {
      if (!asId(q.giver_npc_id) && !asId(q.turnin_npc_id)) {
        const done = await completeQuest(charId, q.id, null).catch((e) => {
          console.error('Автозавершение задания:', e);
          return null;
        });
        if (done?.completed) {
          notify?.(`Задание «${q.name}» выполнено! ${rewardText(q.rewards || {})}`);
        } else if (done?.advanced) {
          notify?.(`Задание «${q.name}»: открыт следующий этап.`);
        }
      } else {
        notify?.(`Задание «${q.name}»: этап выполнен, вернитесь к NPC.`);
      }
    }
  }
  return { ok: true, updated };
}

export async function onNpcTalk(charId, npcId, notify = null, questId = null) {
  return incrementActiveObjective(charId, 'talk',
    (o) => objNpcId(o) === Number(npcId), notify, questId);
}

export async function onHuntVictory(charId, event = {}, notify = () => {}) {
  if (typeof event === 'function') {
    notify = event;
    event = {};
  }
  const npcId = asId(event.npcId ?? event.npc ?? event.targetNpcId);

  // Старые админские задания без NPC-выдающего были авто-квестами.
  // Сохраняем этот сценарий: если нет записи и цель старая hunt_wins/kill,
  // прогресс создаётся и награда может прийти без диалогового окна.
  const ch = (await game.query(
    `SELECT level FROM characters WHERE id = $1`, [charId])).rows[0];
  if (!ch) return;
  const { rows } = await game.query(
    `SELECT q.*
       FROM quest_templates q
      WHERE q.active = TRUE AND q.level_req <= $1
        AND q.giver_npc_id IS NULL AND q.turnin_npc_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM character_quests cq
           WHERE cq.character_id = $2 AND cq.quest_id = q.id AND cq.status IN (1, 2)
        )
      ORDER BY q.id`, [ch.level, charId]);
  for (const q of rows) {
    const norm = normalizeObjectives(q.objectives || {});
    const first = norm.stages[0]?.objectives || [];
    if (!first.some((o) => o.kind === 'kill')) continue;
    await acceptQuest(charId, q.id, null);
  }

  await incrementActiveObjective(charId, 'kill',
    (o) => !objNpcId(o) || !npcId || objNpcId(o) === npcId, notify);
}

export function questRoutes(app, authed) {
  app.get('/api/npcs/location', authed, async (req, res) => {
    const { rows } = await game.query(
      `SELECT t.id, t.name, t.level, t.kind, t.image, t.description,
              COALESCE((s.config->>'order')::int, t.id) AS sort_order
         FROM characters ch
         JOIN npc_spawns s ON s.location_id = ch.location_id
         JOIN npc_templates t ON t.id = s.npc_template_id
        WHERE ch.id = $1 AND t.active = TRUE AND t.kind IN (2, 3)
        ORDER BY sort_order, t.id`,
      [req.session.character_id]);
    res.json(rows);
  });

  app.get('/api/npcs/:id/dialog', authed, async (req, res) => {
    const npcId = Number(req.params.id);
    const npc = await validateNpcHere(game, req.session.character_id, npcId);
    res.json({ npc, dialogs: await dialogEntries(game, req.session.character_id, npcId) });
  });

  app.post('/api/npcs/:id/talk', authed, async (req, res) => {
    const npcId = Number(req.params.id);
    const questId = asId(req.body?.questId ?? req.body?.quest_id);
    if (!questId) throw bad(400, 'quest_required');
    const npc = await validateNpcHere(game, req.session.character_id, npcId);
    const result = await onNpcTalk(req.session.character_id, npcId, null, questId);
    res.json({ ...result, npc, dialogs: await dialogEntries(game, req.session.character_id, npcId) });
  });

  app.post('/api/quests/:id/accept', authed, async (req, res) => {
    const npcId = asId(req.body?.npcId ?? req.body?.npc_id);
    res.json(await acceptQuest(req.session.character_id, Number(req.params.id), npcId));
  });

  app.post('/api/quests/:id/complete', authed, async (req, res) => {
    const npcId = asId(req.body?.npcId ?? req.body?.npc_id);
    res.json(await completeQuest(req.session.character_id, Number(req.params.id), npcId));
  });
}
