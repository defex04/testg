import { randomUUID } from 'crypto';
import { game, tx, redis, gameConfig } from '../db.js';
import { Engine } from './engine.js';
import { addCurrency, CUR } from '../economy.js';
import { addExp, combatProfileFor } from '../characters.js';
import { onHuntVictory } from '../quests.js';
import { sendSystemChat } from '../chat.js';

/**
 * Бои живут в памяти процесса; снапшот хода — в Redis battle:{id}:state;
 * в PostgreSQL — battles/battle_participants (старт, итоги) и battle_rounds.
 *
 * Виды боя: охота (игрок против ИИ) и дуэль PvP (игрок против игрока).
 * Внутри движка стороны абсолютные (left = инициатор), но каждому игроку
 * события отправляются «зеркально» — клиент всегда видит себя слева.
 *
 * Правила выхода: обрыв связи и F5 бой НЕ прерывают (ходы игрока проходят
 * пропуском, при реконнекте бой возвращается). Покинуть идущий бой можно
 * только Эликсиром побега; админ может прервать бой из панели.
 */
const live = new Map();    // battleId(Number) -> b
const byChar = new Map();  // charId(String) -> battleId
const noop = () => {};
// BIGINT из pg приходит строкой, из сессии/роутов — числом; ключ всегда строка
const cid = (v) => String(v);

const snapKey = (id) => `battle:${id}:state`;
const err = (msg, status) => Object.assign(new Error(msg), { status });

// b.players: { left, right } — у охоты right = null (ИИ).
// Игрок: { charId, send, attached, totalDamage, turnDone }
const player = (charId, send) =>
  ({ charId: cid(charId), send: send || noop, attached: true,
     totalDamage: 0, turnDone: false });

const other = (s) => (s === 'left' ? 'right' : 'left');
const humanSides = (b) => ['left', 'right'].filter((s) => b.players[s]);
const sideOf = (b, charId) =>
  humanSides(b).find((s) => b.players[s].charId === cid(charId));

// --- зеркалирование: зритель v видит свою сторону как left ---
const viewSide = (s, v) => (v === 'left' ? s : other(s));
const pubSide = (s) =>
  ({ name: s.name, level: s.level, hp: s.hp, maxHp: s.maxHp });
const sidesFor = (e, v) =>
  ({ left: pubSide(e.sides[v]), right: pubSide(e.sides[other(v)]) });

function broadcast(b, payloadFor) {
  for (const s of humanSides(b)) b.players[s].send(payloadFor(s));
}

/** Инициатива PvP: ловкость персонажа (agi), иначе уровень. */
async function initiativeFor(charId, level) {
  const row = (await game.query(
    `SELECT agi FROM character_stats WHERE character_id = $1`, [charId])).rows[0];
  return Number(row?.agi) || Number(level) || 0;
}

/** turnStart для зрителя v: активная сторона и canAct (свой ход = left). */
function turnStartPayload(b, v) {
  const active = b.engine.activeSide;
  const mirrored = active ? viewSide(active, v) : 'left';
  return {
    turn: b.engine.turn,
    timeLeft: Math.max(0, Math.ceil((b.turnEndsAt - Date.now()) / 1000)),
    active: mirrored,
    canAct: mirrored === 'left',
  };
}

/** При старте процесса: зависших «идущих» боёв быть не должно. */
export async function battleBoot() {
  const r = await game.query(
    `UPDATE battles SET status = 4, ended_at = now() WHERE status IN (1, 2)`);
  if (r.rowCount) console.log('Закрыто зависших боёв:', r.rowCount);
}

async function snapshot(id, b) {
  await redis.set(snapKey(id), JSON.stringify({
    turn: b.engine.turn, phase: b.engine.phase, sides: b.engine.sides,
  }), { EX: 3600 });
}

async function logRounds(battleId, turn, strikes) {
  const ACTION = { hit: 1, blocked: 2, dodged: 3, crit: 4, death: 5 };
  let seq = 0;
  for (const s of strikes) {
    const type = s.dodged ? ACTION.dodged : s.crit ? ACTION.crit
      : s.blocked ? ACTION.blocked : ACTION.hit;
    await game.query(
      `INSERT INTO battle_rounds (battle_id, round_no, action_seq, actor_id,
          action_type, target_id, value, effects)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [battleId, turn, seq++, s.actorId ?? null, type, s.targetId ?? null,
       s.damage, JSON.stringify({ zone: s.zone, crit: s.crit,
         blocked: s.blocked, dodged: s.dodged })]);
    if (s.killed) {
      await game.query(
        `INSERT INTO battle_rounds (battle_id, round_no, action_seq, actor_id,
            action_type, target_id, value, effects)
         VALUES ($1, $2, $3, $4, 5, $5, 0, '{}')`,
        [battleId, turn, seq++, s.actorId ?? null, s.targetId ?? null]);
    }
  }
}

export async function startHunt(ch, send) {
  if (byChar.has(cid(ch.id))) throw err('already_in_battle', 409);

  const npc = (await game.query(
    `SELECT t.id, t.name, t.level, t.stats FROM npc_spawns s
       JOIN npc_templates t ON t.id = s.npc_template_id
      WHERE s.location_id = $1 LIMIT 1`, [ch.location_id])).rows[0];
  if (!npc) throw err('no_hunt_here', 400);

  const start = await gameConfig('character.start');
  const turnTime = Number(await gameConfig('battle.turn_time')) || 20;

  const ins = await game.query(
    `INSERT INTO battles (type, location_id, status, node_id, max_per_side,
        intervention, allow_leave, started_at, meta)
     VALUES (1, $1, 2, 'local', 1, 2, FALSE, now(), $2) RETURNING id`,
    [ch.location_id, JSON.stringify({ kind: 'hunt', npc: npc.id, npcName: npc.name })]);
  // BIGINT приходит из pg строкой; ключ в live должен совпадать
  // с Number(battleId) из админки (adminAbort)
  const battleId = Number(ins.rows[0].id);
  await game.query(
    `INSERT INTO battle_participants (battle_id, character_id, side, status)
     VALUES ($1, $2, 1, 1)`, [battleId, ch.id]);

  const engine = new Engine({
    // профиль с бонусами экипировки: надетые вещи влияют на hp/урон/крит/уворот
    left:  { name: ch.name, level: ch.level, isAI: false,
             ...(await combatProfileFor(ch.id, start)) },
    right: { name: npc.name, level: npc.level, isAI: true, ...npc.stats },
  }, { turnTime, mode: 'hunt' });

  const b = { id: battleId, kind: 'hunt', engine,
    players: { left: player(ch.id, send), right: null },
    timer: null, finishTimer: null, turnEndsAt: 0 };
  live.set(battleId, b);
  byChar.set(cid(ch.id), battleId);
  await snapshot(battleId, b);
  console.log(`Бой ${battleId}: старт охоты, char=${ch.id} (${ch.name})`);
  // объявление в чат локации; клиент делает «Бой #N» ссылкой на окно боя
  sendSystemChat(ch.location_id,
    `⚔ Бой #${battleId}: ${ch.name} против «${npc.name}» — начался!`)
    .catch(console.error);

  b.players.left.send(
    { type: 'battleStart', battleId, kind: 'hunt', ...sidesFor(engine, 'left') });
  beginTurn(b);
  return battleId;
}

/** Дуэль PvP: нападение на игрока из списка игроков локации. */
export async function startDuel(att, def, sendAtt, sendDef) {
  if (cid(att.id) === cid(def.id)) throw err('cannot_attack_self', 400);
  if (byChar.has(cid(att.id))) throw err('already_in_battle', 409);
  if (byChar.has(cid(def.id))) throw err('target_busy', 409);
  if (att.location_id !== def.location_id) throw err('not_same_location', 400);

  const start = await gameConfig('character.start');
  const turnTime = Number(await gameConfig('battle.turn_time')) || 20;

  const ins = await game.query(
    `INSERT INTO battles (type, location_id, status, node_id, max_per_side,
        intervention, allow_leave, started_at, meta)
     VALUES (2, $1, 2, 'local', 1, 2, FALSE, now(), $2) RETURNING id`,
    [att.location_id, JSON.stringify({ kind: 'pvp' })]);
  const battleId = Number(ins.rows[0].id);
  await game.query(
    `INSERT INTO battle_participants (battle_id, character_id, side, status)
     VALUES ($1, $2, 1, 1), ($1, $3, 2, 1)`, [battleId, att.id, def.id]);

  const [attIni, defIni] = await Promise.all([
    initiativeFor(att.id, att.level),
    initiativeFor(def.id, def.level),
  ]);
  const engine = new Engine({
    left:  { name: att.name, level: att.level, isAI: false, initiative: attIni,
             ...(await combatProfileFor(att.id, start)) },
    right: { name: def.name, level: def.level, isAI: false, initiative: defIni,
             ...(await combatProfileFor(def.id, start)) },
  }, { turnTime, mode: 'pvp' });

  const b = { id: battleId, kind: 'pvp', engine,
    players: { left: player(att.id, sendAtt), right: player(def.id, sendDef) },
    timer: null, finishTimer: null, turnEndsAt: 0 };
  live.set(battleId, b);
  for (const s of humanSides(b)) byChar.set(b.players[s].charId, battleId);
  await snapshot(battleId, b);
  console.log(`Бой ${battleId}: PvP, ${att.name} (${att.id}) напал на ${def.name} (${def.id})`);
  sendSystemChat(att.location_id,
    `⚔ Бой #${battleId}: ${att.name} против ${def.name} — начался!`)
    .catch(console.error);

  broadcast(b, (s) =>
    ({ type: 'battleStart', battleId, kind: 'pvp', ...sidesFor(engine, s) }));
  beginTurn(b);
  return battleId;
}

/** Снимок идущего боя для battleResume / GET /api/battle/current. */
export function resumePayload(charId) {
  const battleId = byChar.get(cid(charId));
  if (!battleId) return null;
  const b = live.get(battleId);
  const side = sideOf(b, charId);
  const payload = {
    type: 'battleResume', battleId, kind: b.kind,
    sides: sidesFor(b.engine, side),
    turn: b.engine.turn, phase: b.engine.phase,
    timeLeft: Math.max(0, Math.ceil((b.turnEndsAt - Date.now()) / 1000)),
    moveSubmitted: !!b.engine.moves[side],
  };
  if (b.kind === 'pvp' && b.engine.phase === 'choose') {
    Object.assign(payload, turnStartPayload(b, side));
  }
  return payload;
}

/** Реконнект: вернуть бой и заново привязать сокет. */
export function attach(charId, send) {
  const payload = resumePayload(charId);
  if (!payload) return null;
  const b = live.get(payload.battleId);
  const p = b.players[sideOf(b, charId)];
  p.send = send;
  p.attached = true;
  console.log(`Бой ${b.id}: реконнект char=${charId}, фаза=${b.engine.phase}`);
  // реконнект посреди фазы resolving: не ждать страховочные 20 секунд,
  // если других игроков, доигрывающих анимации, нет
  const othersAnimating = humanSides(b).some((s) =>
    b.players[s] !== p && b.players[s].attached && !b.players[s].turnDone);
  if (b.engine.phase === 'resolving' && !othersAnimating) {
    clearTimeout(b.finishTimer);
    b.finishTimer = setTimeout(() => advanceTurn(b), 1500);
  }
  return payload;
}

export function detach(charId) {
  const battleId = byChar.get(cid(charId));
  if (!battleId) return;
  const b = live.get(battleId);
  const p = b.players[sideOf(b, charId)];
  p.send = noop;        // бой живёт дальше без зрителя
  p.attached = false;
  console.log(`Бой ${battleId}: зритель отключился (char=${charId}), бой продолжается`);
}

function startTurnTimer(b, onTimeout) {
  let left = Math.max(0, Math.ceil((b.turnEndsAt - Date.now()) / 1000));
  clearInterval(b.timer);
  b.timer = setInterval(() => {
    left -= 1;
    broadcast(b, () => ({ type: 'timer', timeLeft: left }));
    if (left <= 0) onTimeout(b);
  }, 1000);
}

function broadcastTurnStart(b, t) {
  b.turnEndsAt = Date.now() + b.engine.turnTime * 1000;
  broadcast(b, (v) => ({ type: 'turnStart', ...t, ...turnStartPayload(b, v) }));
  startTurnTimer(b, (bt) => {
    if (bt.kind === 'pvp') {
      bt.engine.fillTimeoutActive();
      resolvePvPMove(bt, bt.engine.activeSide);
    } else {
      bt.engine.fillTimeouts();
      maybeResolve(bt);
    }
  });
}

function beginTurn(b) {
  if (b.kind === 'pvp') return beginPvPRound(b);
  const t = b.engine.startTurn();
  for (const s of humanSides(b)) b.players[s].turnDone = false;
  broadcastTurnStart(b, t);

  if (!b.players.right) {           // противник — ИИ (охота)
    setTimeout(() => {
      if (b.engine.phase === 'choose' && !b.engine.moves.right) {
        b.engine.submit('right', b.engine.randomMove());
        maybeResolve(b);
      }
    }, 400 + Math.random() * 900);
  }
}

function beginPvPRound(b) {
  const t = b.engine.startRound();
  for (const s of humanSides(b)) b.players[s].turnDone = false;
  broadcastTurnStart(b, t);
}

function beginPvPSubTurn(b) {
  const t = b.engine.startSubTurn();
  for (const s of humanSides(b)) b.players[s].turnDone = false;
  broadcastTurnStart(b, t);
}

export function submitMove(charId, move) {
  const b = live.get(byChar.get(cid(charId)));
  if (!b) return false;
  const side = sideOf(b, charId);
  if (!side) return false;
  const ok = b.engine.submit(side, {
    attack: move.attack, block: move.block ?? null, pass: !!move.pass });
  if (!ok) return false;
  if (b.kind === 'pvp') resolvePvPMove(b, side);
  else maybeResolve(b);
  return true;
}

async function resolvePvPMove(b, side) {
  if (b.engine.phase !== 'choose') return;
  clearInterval(b.timer);
  const r = b.engine.resolveActive();
  for (const s of r.strikes) {
    s.actorId  = b.players[s.attacker] ? b.players[s.attacker].charId : null;
    s.targetId = b.players[s.defender] ? b.players[s.defender].charId : null;
  }
  for (const s of humanSides(b)) {
    b.players[s].totalDamage += r.strikes
      .filter((st) => st.attacker === s && !st.dodged)
      .reduce((a, st) => a + st.damage, 0);
  }
  b.engine.acted[side] = true;
  await snapshot(b.id, b);
  logRounds(b.id, r.turn, r.strikes).catch(console.error);
  broadcast(b, (v) => ({ type: 'resolve', turn: r.turn,
    strikes: r.strikes.map((st) => ({ ...st,
      attacker: viewSide(st.attacker, v), defender: viewSide(st.defender, v) })),
    passed: r.passed.map((p) => viewSide(p, v)),
    sides: sidesFor(b.engine, v) }));
  const anyAttached = humanSides(b).some((s) => b.players[s].attached);
  b.pvpAfterResolve = () => {
    if (b.engine.finished()) return void endBattle(b).catch(console.error);
    const otherSide = other(side);
    if (!b.engine.acted[otherSide]) return beginPvPSubTurn(b);
    return beginPvPRound(b);
  };
  b.finishTimer = setTimeout(() => advanceTurn(b), anyAttached ? 20000 : 1500);
}

async function maybeResolve(b) {
  if (!b.engine.ready || b.engine.phase !== 'choose') return;
  clearInterval(b.timer);
  const r = b.engine.resolve();
  for (const s of r.strikes) {
    s.actorId  = b.players[s.attacker] ? b.players[s.attacker].charId : null;
    s.targetId = b.players[s.defender] ? b.players[s.defender].charId : null;
  }
  for (const s of humanSides(b)) {
    b.players[s].totalDamage += r.strikes
      .filter((st) => st.attacker === s && !st.dodged)
      .reduce((a, st) => a + st.damage, 0);
  }
  await snapshot(b.id, b);
  logRounds(b.id, r.turn, r.strikes).catch(console.error);
  broadcast(b, (v) => ({ type: 'resolve', turn: r.turn,
    strikes: r.strikes.map((st) => ({ ...st,
      attacker: viewSide(st.attacker, v), defender: viewSide(st.defender, v) })),
    passed: r.passed.map((p) => viewSide(p, v)),
    sides: sidesFor(b.engine, v) }));
  // клиент проигрывает анимации и шлёт turnDone; страховка — авто.
  // Если все игроки отключены, ждать некого: заочный бой идёт в полном темпе.
  const anyAttached = humanSides(b).some((s) => b.players[s].attached);
  b.finishTimer = setTimeout(() => advanceTurn(b), anyAttached ? 20000 : 1500);
}

export async function finishTurn(charId) {
  const b = live.get(byChar.get(cid(charId)));
  if (!b || b.engine.phase !== 'resolving') return;
  const side = sideOf(b, charId);
  if (side) b.players[side].turnDone = true;
  // следующий ход — когда все подключённые игроки доиграли анимации
  if (humanSides(b).some((s) => b.players[s].attached && !b.players[s].turnDone)) return;
  advanceTurn(b);
}

function advanceTurn(b) {
  if (b.engine.phase !== 'resolving') return;
  clearTimeout(b.finishTimer);
  if (b.kind === 'pvp' && b.pvpAfterResolve) {
    const next = b.pvpAfterResolve;
    b.pvpAfterResolve = null;
    return next();
  }
  if (b.engine.finished()) return void endBattle(b).catch(console.error);
  beginTurn(b);
}

function dropLive(b) {
  clearInterval(b.timer); clearTimeout(b.finishTimer);
  live.delete(b.id);
  for (const s of humanSides(b)) byChar.delete(b.players[s].charId);
}

async function endBattle(b) {
  dropLive(b);
  const winner = b.engine.winner();
  const reward = b.kind === 'hunt' ? await gameConfig('battle.reward.hunt') : null;

  await tx(async (c) => {
    await c.query(
      `UPDATE battles SET status = 3, ended_at = now(), winner_side = $2 WHERE id = $1`,
      [b.id, winner === 'left' ? 1 : winner === 'right' ? 2 : null]);
    for (const s of humanSides(b)) {
      const p = b.players[s];
      const me = b.engine.sides[s];
      const victory = winner === s;
      await c.query(
        `UPDATE battle_participants SET status = $3, result = $4, left_round = $5,
            damage_dealt = $6, exp_gained = $7, kills = $8, deaths = $9
          WHERE battle_id = $1 AND character_id = $2`,
        [b.id, p.charId, me.hp > 0 ? 1 : 2,
         victory ? 1 : winner ? 2 : 3, b.engine.turn,
         p.totalDamage, victory && reward ? reward.exp : 0,
         victory ? 1 : 0, me.hp > 0 ? 0 : 1]);
      if (victory && reward) {
        await addCurrency(c, p.charId, CUR[reward.currency], reward.amount, 7,
          { idempotencyKey: randomUUID(), type: 1, id: b.id });
        await addExp(c, p.charId, reward.exp);
      }
      await c.query(`UPDATE characters SET hp_cur = $2 WHERE id = $1`,
        [p.charId, me.maxHp]);
    }
  });
  await redis.del(snapKey(b.id));
  broadcast(b, (v) => ({ type: 'battleEnd',
    winner: winner ? viewSide(winner, v) : null, victory: winner === v,
    sides: sidesFor(b.engine, v),
    reward: winner === v && reward ? reward : null }));

  if (b.kind === 'hunt' && winner === 'left') {
    onHuntVictory(b.players.left.charId, (text) =>
      b.players.left.send({ type: 'chat', from: 'Система', text }))
      .catch(console.error);
  }
}

async function abortBattle(b, reason) {
  dropLive(b);
  await tx(async (c) => {
    await c.query(
      `UPDATE battles SET status = 4, ended_at = now() WHERE id = $1`, [b.id]);
    for (const s of humanSides(b)) {
      const p = b.players[s];
      await c.query(
        `UPDATE battle_participants SET status = 3, result = 4, left_round = $3
          WHERE battle_id = $1 AND character_id = $2`,
        [b.id, p.charId, b.engine.turn]);
      await c.query(`UPDATE characters SET hp_cur = $2 WHERE id = $1`,
        [p.charId, b.engine.sides[s].maxHp]);
    }
  });
  await redis.del(snapKey(b.id));
  broadcast(b, (v) => ({ type: 'battleEnd', winner: null, victory: false,
    aborted: true, reason, sides: sidesFor(b.engine, v) }));
}

/** Побег из PvP: сбежавший засчитывается как проигравший, противник победил. */
async function escapeDuel(b, escaper) {
  dropLive(b);
  const winner = other(escaper);
  await tx(async (c) => {
    await c.query(
      `UPDATE battles SET status = 3, ended_at = now(), winner_side = $2 WHERE id = $1`,
      [b.id, winner === 'left' ? 1 : 2]);
    for (const s of humanSides(b)) {
      const p = b.players[s];
      await c.query(
        `UPDATE battle_participants SET status = $3, result = $4, left_round = $5,
            damage_dealt = $6
          WHERE battle_id = $1 AND character_id = $2`,
        [b.id, p.charId, s === escaper ? 3 : 1, s === escaper ? 4 : 1,
         b.engine.turn, p.totalDamage]);
      await c.query(`UPDATE characters SET hp_cur = $2 WHERE id = $1`,
        [p.charId, b.engine.sides[s].maxHp]);
    }
  });
  await redis.del(snapKey(b.id));
  broadcast(b, (v) => v === escaper
    ? { type: 'battleEnd', winner: null, victory: false, aborted: true,
        reason: 'escape', sides: sidesFor(b.engine, v) }
    : { type: 'battleEnd', winner: 'left', victory: true,
        sides: sidesFor(b.engine, v), reward: null });
}

/** Эликсир побега: расход предмета и прерывание боя — одно целое. */
export async function escapeBattle(charId) {
  const b = live.get(byChar.get(cid(charId)));
  if (!b) throw err('no_battle', 400);
  const tplId = Number(await gameConfig('battle.escape_elixir')) || 201;

  await tx(async (c) => {
    const it = (await c.query(
      `SELECT * FROM item_instances
        WHERE owner_type = 1 AND owner_id = $1 AND template_id = $2 AND status = 1
        ORDER BY id LIMIT 1 FOR UPDATE`, [charId, tplId])).rows[0];
    if (!it) throw err('no_escape_elixir', 400);
    if (it.quantity > 1) {
      await c.query(
        `UPDATE item_instances SET quantity = quantity - 1, version = version + 1,
            updated_at = now() WHERE id = $1`, [it.id]);
    } else {
      await c.query(
        `UPDATE item_instances SET status = 2, deleted_at = now(),
            version = version + 1 WHERE id = $1`, [it.id]);
    }
    await c.query(
      `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id,
          quantity, from_owner_type, from_owner_id, reason, ref_type, ref_id)
       VALUES ($1, $2, $3, 1, 1, $4, 7, 1, $5)`,
      [randomUUID(), it.id, tplId, charId, b.id]);
  });
  if (b.kind === 'pvp') await escapeDuel(b, sideOf(b, charId));
  else await abortBattle(b, 'escape');
}

/** Кнопка «Прервать бой» в админке. */
export async function adminAbort(battleId) {
  const b = live.get(Number(battleId));
  if (b) {
    console.log(`Бой ${battleId}: прерван админом (живой)`);
    await abortBattle(b, 'admin');
    return true;
  }
  // боя нет в памяти (например, после рестарта сервера) — закрываем в БД
  const r = await game.query(
    `UPDATE battles SET status = 4, ended_at = now()
      WHERE id = $1 AND status IN (1, 2)`, [battleId]);
  console.log(`Бой ${battleId}: abort без live-состояния, обновлено строк: ${r.rowCount}`);
  return r.rowCount > 0;
}

export function leaveBattle(charId) {
  if (byChar.has(cid(charId))) {
    throw err('cannot_leave', 403);
  }
}

/** REST-страховка к push battleResume: клиент сам спрашивает идущий бой. */
export function battleRoutes(app, authed) {
  app.get('/api/battle/current', authed, (req, res) => {
    res.json(resumePayload(req.session.character_id) || { battleId: null });
  });

  // Окно боя из ссылки в чате: идущий — составы с hp/mp, иначе — итоги
  app.get('/api/battles/:id', authed, async (req, res) => {
    const id = Number(req.params.id);
    const battle = (await game.query(
      `SELECT id, type, status, winner_side, meta, started_at, ended_at
         FROM battles WHERE id = $1`, [id])).rows[0];
    if (!battle) throw err('not_found', 404);
    const meta = battle.meta || {};

    const b = live.get(id);
    if (b) {
      const member = async (s) => {
        const side = b.engine.sides[s];
        const p = b.players[s];
        let mpCur = 0;
        if (p) {
          const mp = (await game.query(
            `SELECT mp_cur FROM characters WHERE id = $1`, [p.charId])).rows[0];
          mpCur = mp ? mp.mp_cur : 0;
        }
        return { name: side.name, level: side.level, hp: Math.round(side.hp),
                 maxHp: side.maxHp, mp: mpCur, maxMp: 100 };
      };
      return res.json({
        battleId: id, status: 'active', turn: b.engine.turn,
        teams: {
          left:  [await member('left')],
          right: [await member('right')],
        },
      });
    }

    // итоги: участники-персонажи из БД…
    const parts = (await game.query(
      `SELECT bp.side, bp.result, bp.damage_dealt, bp.kills, bp.deaths,
              bp.exp_gained, bp.valor_gained, ch.name, ch.level
         FROM battle_participants bp JOIN characters ch ON ch.id = bp.character_id
        WHERE bp.battle_id = $1 ORDER BY bp.side, ch.name`, [id])).rows;
    const results = parts.map((p) => ({
      side: p.side, name: p.name, level: p.level,
      damage: Number(p.damage_dealt), kills: p.kills, deaths: p.deaths,
      exp: Number(p.exp_gained), valor: Number(p.valor_gained),
      result: p.result,
    }));

    // …и противник-NPC: его цифры собираются из журнала ходов
    if (meta.npcName) {
      const npc = (await game.query(
        `SELECT coalesce(sum(value) FILTER (WHERE actor_id IS NULL AND action_type <> 5), 0) AS damage,
                count(*) FILTER (WHERE action_type = 5 AND actor_id IS NULL)  AS kills,
                count(*) FILTER (WHERE action_type = 5 AND target_id IS NULL) AS deaths
           FROM battle_rounds WHERE battle_id = $1`, [id])).rows[0];
      const lvl = meta.npc ? (await game.query(
        `SELECT level FROM npc_templates WHERE id = $1`, [meta.npc])).rows[0] : null;
      results.push({
        side: 2, name: meta.npcName, level: lvl ? lvl.level : null,
        damage: Number(npc.damage), kills: Number(npc.kills),
        deaths: Number(npc.deaths), exp: null, valor: null, result: null,
      });
    }

    res.json({
      battleId: id,
      status: battle.status === 3 ? 'finished' : 'aborted',
      winnerSide: battle.winner_side,
      results,
    });
  });
}
