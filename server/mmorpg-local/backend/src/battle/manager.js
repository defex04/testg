import { randomUUID } from 'crypto';
import { game, tx, redis, gameConfig } from '../db.js';
import { Engine } from './engine.js';
import { addCurrency, CUR } from '../economy.js';
import { addExp, combatProfileFor, getCharacter } from '../characters.js';
import { onHuntVictory } from '../quests.js';
import { sendSystemChat } from '../chat.js';
import { elixirParams } from '../belt.js';

/**
 * Бои живут в памяти процесса; снапшот хода — в Redis battle:{id}:state;
 * в PostgreSQL — battles/battle_participants (старт, итоги) и battle_rounds.
 *
 * Стороны — команды бойцов (NvN); 1×1 (охота, дуэль) — частный случай.
 * Движок ведёт абсолютные стороны (left = инициатор), но каждому игроку
 * события отправляются «зеркально»: своя команда — слева, и показывается
 * один «сфокусированный» соперник (тот, кто сейчас ходит против него,
 * либо его текущая цель). Пока ход у союзника — клиент видит плашку
 * «ожидание соперника» и прячет правую модель.
 *
 * Вмешательство (joinBattle) разрешено, если у боя intervention = open
 * (флаг считается из конфига + locations.flags при старте, админ может
 * переключить вживую).
 */
const live = new Map();    // battleId(Number) -> b
const byChar = new Map();  // charId(String) -> battleId
const noop = () => {};
const cid = (v) => String(v);

const snapKey = (id) => `battle:${id}:state`;
const err = (msg, status, extra = {}) => Object.assign(new Error(msg), { status }, extra);
const other = (s) => (s === 'left' ? 'right' : 'left');

// --- сетевой слой игрока поверх бойца движка ---
function makeBattle(id, kind, locationId, policy, engine) {
  return { id, kind, locationId, engine, policy,
    players: new Map(), timer: null, finishTimer: null, turnEndsAt: 0,
    step: 0 };   // токен sub-turn: отложенные колбэки устаревают при смене (анти-двойной-advance)
}
function addPlayer(b, charId, send, side) {
  b.players.set(cid(charId),
    { charId: cid(charId), side, send: send || noop, attached: true,
      totalDamage: 0, turnDone: false });
  return b.players.get(cid(charId));
}
const playerList = (b) => [...b.players.values()];
const attachedList = (b) => playerList(b).filter((p) => p.attached);

function broadcast(b, payloadFor) {
  for (const p of b.players.values()) p.send(payloadFor(p));
}

// --- зеркалирование: команда зрителя как left ---
const pub = (f) => f && ({ id: f.id, name: f.name, level: f.level,
  hp: Math.round(f.hp), maxHp: f.maxHp, alive: f.alive,
  buffTurns: f.buffTurns || 0 });
const rosterFor = (b, vSide) => ({
  left:  b.engine.teams[vSide].map((id) => pub(b.engine.fighter(id))),
  right: b.engine.teams[other(vSide)].map((id) => pub(b.engine.fighter(id))),
});
/** Любой враг для «правой» модели (живой в приоритете), иначе первый из команды. */
function anyEnemy(b, vSide) {
  const e = b.engine;
  return e.aliveOf(other(vSide))[0] || e.fighter(e.teams[other(vSide)][0]) || null;
}
function sidesFor(b, p, focus) {
  const me = b.engine.fighter(p.charId);
  const right = focus || anyEnemy(b, me.side);
  return { left: pub(me), right: pub(right) };
}

/** turnStart для зрителя: кто активен, можно ли ходить, на кого смотреть. */
function turnStartFor(b, p) {
  const e = b.engine;
  const me = e.fighter(p.charId);
  const vSide = me.side;
  const af = e.currentActor();
  let canAct = false, waiting = false, focus = null;
  if (af) {
    if (af.id === me.id) {            // мой ход — смотрю на своего «липкого» соперника
      canAct = true; focus = e.opponentOf(me.id) || e.enemiesOf(me.id)[0] || null;
    } else if (af.side !== vSide) { focus = af; }  // ходит враг — смотрим на него
    else { waiting = true; }                        // ходит союзник — ждём соперника
  }
  return {
    type: 'turnStart', turn: e.turn,
    timeLeft: Math.max(0, Math.ceil((b.turnEndsAt - Date.now()) / 1000)),
    canAct, waiting,
    active: af ? (af.side === vSide ? 'left' : 'right') : 'left',
    focus: focus ? pub(focus) : null,
    targets: e.enemiesOf(me.id).map(pub),   // живые враги — для выбора цели
    roster: rosterFor(b, vSide),
  };
}

/** resolve для зрителя: удары переведены в его систему (он — left, фокус — right). */
function resolveFor(b, p, r) {
  const e = b.engine;
  const me = e.fighter(p.charId);
  const vSide = me.side;
  let focus = null;
  const strikes = r.strikes.map((s) => {
    const att = e.fighter(s.attackerId), def = e.fighter(s.defenderId);
    const meIsAtt = att.id === me.id, meIsDef = def.id === me.id;
    if (meIsAtt || meIsDef) {
      focus = meIsAtt ? def : att;     // в кадре — мой соперник по этому удару
      return { ...s, attacker: meIsAtt ? 'left' : 'right',
        defender: meIsAtt ? 'right' : 'left',
        attackerName: att.name, defenderName: def.name };
    }
    // удар между другими бойцами — только в журнал, без 3D
    return { ...s, offscreen: true,
      attacker: att.side === vSide ? 'left' : 'right',
      defender: def.side === vSide ? 'left' : 'right',
      attackerName: att.name, defenderName: def.name };
  });
  const passed = r.passed.map((id) => e.fighter(id).side === vSide ? 'left' : 'right');
  return { type: 'resolve', turn: r.turn, strikes, passed,
    sides: sidesFor(b, p, focus), focus: focus ? pub(focus) : null,
    roster: rosterFor(b, vSide) };
}

function startView(b, p) {
  const me = b.engine.fighter(p.charId);
  const enemy = anyEnemy(b, me.side);
  return { left: pub(me), right: pub(enemy),
    roster: rosterFor(b, me.side), focus: pub(enemy),
    policy: { intervention: b.policy.intervention } };
}

/** Настройки выбора цели (липкость/«холод») из конфига; есть дефолты. */
const numCfg = (v, d) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
async function targetCfg() {
  return {
    switchChance: numCfg(await gameConfig('battle.target.switch_chance'), 0.25),
    coldTurns:    numCfg(await gameConfig('battle.target.cold_turns'), 2),
    coldWeight:   numCfg(await gameConfig('battle.target.cold_weight'), 1.5),
  };
}

/**
 * Инициатива (кто ходит первым) — определяется ОДИН РАЗ при входе в бой и не
 * зависит от роли: напал ты, напали на тебя или ты вмешался (#3). База — ловкость
 * (agi), иначе уровень; сверху случайный бросок (0..1), который решает порядок
 * при равной ловкости. Значение фиксируется в бойце движка и больше не меняется,
 * поэтому очередь раундов стабильна (см. engine._buildOrder).
 */
async function initiativeFor(charId, level) {
  const row = (await game.query(
    `SELECT agi FROM character_stats WHERE character_id = $1`, [charId])).rows[0];
  const base = Number(row?.agi) || Number(level) || 0;
  return base + Math.random();
}

/** Политика вмешательства/выхода: приоритет локация → глобальный дефолт по виду боя. */
async function resolvePolicy(kind, locationId) {
  const def = (await gameConfig('battle.intervention.default'))
    || { hunt: false, pvp: true };
  const maxPerSide = Number(await gameConfig('battle.max_per_side')) || 10;
  const loc = (await game.query(
    `SELECT flags FROM locations WHERE id = $1`, [locationId])).rows[0];
  const flags = (loc && loc.flags) || {};
  const open = typeof flags.intervention === 'boolean' ? flags.intervention : !!def[kind];
  const allowLeave = typeof flags.allow_leave === 'boolean' ? flags.allow_leave : false;
  return { intervention: open ? 'open' : 'closed', allowLeave, maxPerSide };
}

export async function battleBoot() {
  const r = await game.query(
    `UPDATE battles SET status = 4, ended_at = now() WHERE status IN (1, 2)`);
  if (r.rowCount) console.log('Закрыто зависших боёв:', r.rowCount);
}

async function snapshot(id, b) {
  await redis.set(snapKey(id), JSON.stringify({
    turn: b.engine.turn, phase: b.engine.phase,
    teams: b.engine.teams, fighters: [...b.engine.fighters.values()],
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

// ============================================================
// Создание боёв
// ============================================================
export async function startHunt(ch, send) {
  if (byChar.has(cid(ch.id))) throw err('already_in_battle', 409);

  const npc = (await game.query(
    `SELECT t.id, t.name, t.level, t.stats FROM npc_spawns s
       JOIN npc_templates t ON t.id = s.npc_template_id
      WHERE s.location_id = $1 LIMIT 1`, [ch.location_id])).rows[0];
  if (!npc) throw err('no_hunt_here', 400);

  const start = await gameConfig('character.start');
  const turnTime = Number(await gameConfig('battle.turn_time')) || 20;
  const policy = await resolvePolicy('hunt', ch.location_id);

  const ins = await game.query(
    `INSERT INTO battles (type, location_id, status, node_id, max_per_side,
        intervention, allow_leave, started_at, meta)
     VALUES (1, $1, 2, 'local', $2, $3, $4, now(), $5) RETURNING id`,
    [ch.location_id, policy.maxPerSide, policy.intervention === 'open' ? 1 : 2,
     policy.allowLeave, JSON.stringify({ kind: 'hunt', npc: npc.id, npcName: npc.name })]);
  const battleId = Number(ins.rows[0].id);
  await game.query(
    `INSERT INTO battle_participants (battle_id, character_id, side, status)
     VALUES ($1, $2, 1, 1)`, [battleId, ch.id]);

  const engine = new Engine({
    left:  [{ id: ch.id, charId: ch.id, name: ch.name, level: ch.level,
              isAI: false, ...(await combatProfileFor(ch.id, start)) }],
    right: [{ id: `npc-${npc.id}`, name: npc.name, level: npc.level, isAI: true, ...npc.stats }],
  }, { turnTime, target: await targetCfg() });

  const b = makeBattle(battleId, 'hunt', ch.location_id, policy, engine);
  const p = addPlayer(b, ch.id, send, 'left');
  live.set(battleId, b);
  byChar.set(cid(ch.id), battleId);
  await snapshot(battleId, b);
  console.log(`Бой ${battleId}: старт охоты, char=${ch.id} (${ch.name})`);
  sendSystemChat(ch.location_id,
    `⚔ Бой #${battleId}: ${ch.name} против «${npc.name}» — начался!`)
    .catch(console.error);

  p.send({ type: 'battleStart', battleId, kind: 'hunt', ...startView(b, p) });
  beginRound(b);
  return battleId;
}

/** Контекст идущего боя персонажа (для target_busy и клиента). */
export function battleContextForChar(charId) {
  const battleId = byChar.get(cid(charId));
  if (!battleId) return {};
  const b = live.get(battleId);
  if (!b || b.engine.phase === 'ended') return {};
  const f = b.engine.fighter(cid(charId));
  return {
    battleId,
    targetSide: f ? f.side : null,
    allowJoin: b.policy.intervention === 'open',
  };
}

/** Дуэль PvP: нападение на игрока из списка игроков локации. */
export async function startDuel(att, def, sendAtt, sendDef) {
  if (cid(att.id) === cid(def.id)) throw err('cannot_attack_self', 400);
  if (byChar.has(cid(att.id))) throw err('already_in_battle', 409);
  if (byChar.has(cid(def.id))) {
    throw err('target_busy', 409, battleContextForChar(def.id));
  }
  if (att.location_id !== def.location_id) throw err('not_same_location', 400);

  const start = await gameConfig('character.start');
  const turnTime = Number(await gameConfig('battle.turn_time')) || 20;
  const policy = await resolvePolicy('pvp', att.location_id);

  const ins = await game.query(
    `INSERT INTO battles (type, location_id, status, node_id, max_per_side,
        intervention, allow_leave, started_at, meta)
     VALUES (2, $1, 2, 'local', $2, $3, $4, now(), $5) RETURNING id`,
    [att.location_id, policy.maxPerSide, policy.intervention === 'open' ? 1 : 2,
     policy.allowLeave, JSON.stringify({ kind: 'pvp' })]);
  const battleId = Number(ins.rows[0].id);
  await game.query(
    `INSERT INTO battle_participants (battle_id, character_id, side, status)
     VALUES ($1, $2, 1, 1), ($1, $3, 2, 1)`, [battleId, att.id, def.id]);

  const [attIni, defIni] = await Promise.all([
    initiativeFor(att.id, att.level),
    initiativeFor(def.id, def.level),
  ]);
  const engine = new Engine({
    left:  [{ id: att.id, charId: att.id, name: att.name, level: att.level,
              isAI: false, initiative: attIni, ...(await combatProfileFor(att.id, start)) }],
    right: [{ id: def.id, charId: def.id, name: def.name, level: def.level,
              isAI: false, initiative: defIni, ...(await combatProfileFor(def.id, start)) }],
  }, { turnTime, target: await targetCfg() });

  const b = makeBattle(battleId, 'pvp', att.location_id, policy, engine);
  addPlayer(b, att.id, sendAtt, 'left');
  addPlayer(b, def.id, sendDef, 'right');
  live.set(battleId, b);
  byChar.set(cid(att.id), battleId);
  byChar.set(cid(def.id), battleId);
  await snapshot(battleId, b);
  console.log(`Бой ${battleId}: PvP, ${att.name} (${att.id}) напал на ${def.name} (${def.id})`);
  sendSystemChat(att.location_id,
    `⚔ Бой #${battleId}: ${att.name} против ${def.name} — начался!`)
    .catch(console.error);

  broadcast(b, (p) => ({ type: 'battleStart', battleId, kind: 'pvp', ...startView(b, p) }));
  beginRound(b);
  return battleId;
}

/** Вмешательство: войти в идущий бой на сторону side ('left' | 'right'). */
export async function joinBattle(charId, battleId, side, send) {
  if (byChar.has(cid(charId))) throw err('already_in_battle', 409);
  const b = live.get(Number(battleId));
  if (!b || b.engine.phase === 'ended') throw err('battle_not_found', 404);
  if (b.policy.intervention !== 'open') throw err('intervention_closed', 403);
  if (side !== 'left' && side !== 'right') throw err('bad_side', 400);

  const ch = await getCharacter(charId);
  if (ch.location_id !== b.locationId) throw err('not_same_location', 400);
  if (b.engine.aliveOf(side).length >= b.policy.maxPerSide) throw err('side_full', 403);

  const start = await gameConfig('character.start');
  const initiative = await initiativeFor(ch.id, ch.level);
  b.engine.addFighter(side, { id: ch.id, charId: ch.id, name: ch.name, level: ch.level,
    isAI: false, initiative, ...(await combatProfileFor(ch.id, start)) });
  const p = addPlayer(b, ch.id, send, side);
  // если вмешались прямо во время розыгрыша — этот sub-turn новичок не видел,
  // поэтому не ждём от него turnDone (иначе он зря держит ход до страховки)
  if (b.engine.phase === 'resolving') p.turnDone = true;
  byChar.set(cid(ch.id), battleId);
  await game.query(
    `INSERT INTO battle_participants (battle_id, character_id, side, status, joined_round)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (battle_id, character_id) DO NOTHING`,
    [b.id, ch.id, side === 'left' ? 1 : 2, b.engine.turn]);
  await snapshot(b.id, b);
  console.log(`Бой ${b.id}: вмешательство char=${ch.id} (${ch.name}) на сторону ${side}`);
  sendSystemChat(b.locationId,
    `⚔ Бой #${b.id}: ${ch.name} вмешивается в бой!`).catch(console.error);

  p.send({ type: 'battleStart', battleId: b.id, kind: b.kind, ...startView(b, p) });
  // сразу синхронизируем ход — иначе UI вмешавшегося «зависает» до следующего turnStart
  if (b.engine.phase === 'choose') p.send(turnStartFor(b, p));
  // остальным — обновлённый состав; активный ход не трогаем
  for (const q of b.players.values()) {
    if (q !== p) q.send({ type: 'rosterUpdate',
      roster: rosterFor(b, b.engine.fighter(q.charId).side) });
  }
  return b.id;
}

// ============================================================
// Резюм / реконнект
// ============================================================
export function resumePayload(charId) {
  const battleId = byChar.get(cid(charId));
  if (!battleId) return null;
  const b = live.get(battleId);
  if (!b) return null;
  const me = b.engine.fighter(cid(charId));
  if (!me) return null;
  const payload = {
    type: 'battleResume', battleId, kind: b.kind,
    sides: sidesFor(b, { charId: cid(charId) }),
    roster: rosterFor(b, me.side),
    turn: b.engine.turn, phase: b.engine.phase,
    timeLeft: Math.max(0, Math.ceil((b.turnEndsAt - Date.now()) / 1000)),
    policy: { intervention: b.policy.intervention },
    moveSubmitted: b.engine.acted.has(me.id),
  };
  if (b.engine.phase === 'choose') {
    Object.assign(payload, turnStartFor(b, { charId: cid(charId) }));
    payload.type = 'battleResume';
  }
  return payload;
}

export function attach(charId, send) {
  const payload = resumePayload(charId);
  if (!payload) return null;
  const b = live.get(payload.battleId);
  const p = b.players.get(cid(charId));
  if (!p) return null;
  p.send = send;
  p.attached = true;
  console.log(`Бой ${b.id}: реконнект char=${charId}, фаза=${b.engine.phase}`);
  const othersAnimating = attachedList(b).some((x) => x !== p && !x.turnDone);
  if (b.engine.phase === 'resolving' && !othersAnimating) {
    clearTimeout(b.finishTimer);
    const step = b.step;
    b.finishTimer = setTimeout(() => { if (b.step === step) advance(b); }, 1500);
  }
  return payload;
}

export function detach(charId) {
  const battleId = byChar.get(cid(charId));
  if (!battleId) return;
  const b = live.get(battleId);
  const p = b && b.players.get(cid(charId));
  if (!p) return;
  p.send = noop;
  p.attached = false;
  console.log(`Бой ${battleId}: зритель отключился (char=${charId}), бой продолжается`);
}

// ============================================================
// Конвейер хода (единый sub-turn для всех видов боя)
// ============================================================
function startTurnTimer(b) {
  const step = b.step;
  let left = Math.max(0, Math.ceil((b.turnEndsAt - Date.now()) / 1000));
  clearInterval(b.timer);
  b.timer = setInterval(() => {
    if (b.step !== step) { clearInterval(b.timer); return; }   // sub-turn сменился
    left -= 1;
    broadcast(b, () => ({ type: 'timer', timeLeft: left }));
    if (left <= 0) { clearInterval(b.timer); onTurnTimeout(b); }
  }, 1000);
}

function onTurnTimeout(b) {
  if (b.engine.phase !== 'choose') return;
  let af = b.engine.currentActor();
  if (!af) {
    const next = b.engine.advance();
    if (next) return enterActor(b);
    return beginRound(b);
  }
  const move = af.isAI
    ? b.engine.aiMove()
    : { attack: null, block: null, pass: true };
  if (!b.engine.submit(af.id, move) && af.isAI) {
    b.engine.submit(af.id, { attack: null, block: null, pass: true });
  }
  resolveCurrent(b);
}

function enterActor(b) {
  b.step += 1;                       // новый sub-turn → старые таймеры устаревают
  const step = b.step;
  for (const p of b.players.values()) p.turnDone = false;
  b.turnEndsAt = Date.now() + b.engine.turnTime * 1000;
  // если idx указывает на уже походившего/мёртвого — сдвигаем к следующему
  let af = b.engine.currentActor();
  if (!af) {
    const next = b.engine.advance();
    if (!next) {
      if (b.engine.finished()) return void endBattle(b).catch(console.error);
      return beginRound(b);
    }
    af = b.engine.currentActor();
  }
  if (!af) return;
  // соперник «напротив» уже задан на весь раунд (engine.buildPairs в startRound)
  // и не переключается до следующего раунда — отдельный ре-пик в суб-ходе не нужен.
  broadcast(b, (p) => turnStartFor(b, p));
  startTurnTimer(b);
  if (af && af.isAI) {
    setTimeout(() => {
      if (b.step !== step) return;   // ход уже сменился — не дублируем
      if (b.engine.phase === 'choose' && b.engine.currentActorId() === af.id) {
        if (!b.engine.submit(af.id, b.engine.aiMove())) {
          console.warn(`Бой ${b.id}: ИИ ${af.name} (${af.id}) — пропуск хода`);
          b.engine.submit(af.id, { attack: null, block: null, pass: true });
        }
        resolveCurrent(b);
      }
    }, 400 + Math.random() * 900);
  }
}

function beginRound(b) {
  const t = b.engine.startRound();
  if (!t) {
    if (b.engine.finished()) endBattle(b).catch(console.error);
    return;
  }
  enterActor(b);
}

export function submitMove(charId, move) {
  const b = live.get(byChar.get(cid(charId)));
  if (!b) return false;
  const me = b.engine.fighter(cid(charId));
  if (!me) return false;
  const p = b.players.get(cid(charId));
  if (b.engine.currentActorId() !== me.id) {
    p?.send({ type: 'error', error: 'not_your_turn' });
    return false;
  }
  const ok = b.engine.submit(me.id, {
    attack: move.attack, block: move.block ?? null,
    target: move.target ?? null, pass: !!move.pass });
  if (!ok) {
    p?.send({ type: 'error', error: 'invalid_move' });
    return false;
  }
  resolveCurrent(b);
  return true;
}

const clampNum = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/**
 * Использовать боевой эликсир из ячейки пояса (slot) в свой ход — АВТОРИТЕТНО:
 *  1) параметры эффекта (kind/potency/turns) берём из шаблона эликсира на сервере;
 *  2) реально СПИСЫВАЕМ 1 заряд из инвентаря (FOR UPDATE + item_ledger), как
 *     Эликсир побега — без предмета выпить нельзя;
 *  3) применяем эффект к выбранной в ростере цели (союзник/себя), по умолчанию — себе;
 *  4) рассылаем итог: пьющему — слот/чип, всем — обновлённый ростер.
 * Значения зажимаются (анти-чит): heal ≤ 60% макс. HP, мощь ≤ +100% на ≤5 ударов.
 */
export async function useElixir(charId, msg = {}) {
  const b = live.get(byChar.get(cid(charId)));
  if (!b || b.engine.phase === 'ended') return false;
  const me = b.engine.fighter(cid(charId));
  const p = b.players.get(cid(charId));
  if (!me || !me.alive) return false;
  // только в свой ход выбора (как пояс на клиенте: beltLive=true лишь на своём ходу)
  if (b.engine.phase !== 'choose' || b.engine.currentActorId() !== me.id) {
    p?.send({ type: 'error', error: 'not_your_turn' });
    return false;
  }
  // ячейка пояса: шаблон + заряды (quantity). Параметры эффекта — из шаблона на
  // сервере (анти-чит), не из клиента.
  const slot = Number(msg.slot);
  const belt = (await game.query(
    `SELECT b.template_id, b.quantity, t.base_stats FROM character_belt b
       JOIN item_templates t ON t.id = b.template_id
      WHERE b.character_id = $1 AND b.slot = $2`, [charId, slot])).rows[0];
  const params = belt && elixirParams(belt.base_stats);
  if (!params || Number(belt.quantity) <= 0) {
    p?.send({ type: 'error', error: 'belt_empty' }); return false;
  }
  // нельзя пить эликсир мощи, пока его усиление ещё действует (тот же эффект)
  if (params.kind === 'power' && me.buffTurns > 0) {
    p?.send({ type: 'error', error: 'elixir_active' }); return false;
  }

  // авторитетно списываем 1 заряд из инвентаря И из ячейки пояса (в одной tx).
  // Возвращаем остаток в ячейке (для клиента). Нет предмета — отказ и очистка
  // ячейки: пояс не должен «висеть» зарядами, которых уже нет в рюкзаке.
  let slotQty;
  try {
    slotQty = await tx(async (c) => {
      const it = (await c.query(
        `SELECT id, quantity FROM item_instances
          WHERE owner_type = 1 AND owner_id = $1 AND template_id = $2 AND status = 1
          ORDER BY id LIMIT 1 FOR UPDATE`, [charId, belt.template_id])).rows[0];
      if (!it) throw Object.assign(new Error('no_elixir'), { status: 400 });
      if (it.quantity > 1) {
        await c.query(`UPDATE item_instances SET quantity = quantity - 1,
            version = version + 1, updated_at = now() WHERE id = $1`, [it.id]);
      } else {
        await c.query(`UPDATE item_instances SET status = 2, deleted_at = now(),
            version = version + 1 WHERE id = $1`, [it.id]);
      }
      await c.query(
        `INSERT INTO item_ledger (idempotency_key, item_instance_id, template_id,
            quantity, from_owner_type, from_owner_id, reason, ref_type, ref_id)
         VALUES ($1, $2, $3, 1, 1, $4, 7, 1, $5)`,
        [randomUUID(), it.id, belt.template_id, charId, b.id]);
      // заряд из ячейки пояса; на нуле — освобождаем ячейку (слот пустеет)
      const left = Number(belt.quantity) - 1;
      if (left > 0) {
        await c.query(`UPDATE character_belt SET quantity = $3
            WHERE character_id = $1 AND slot = $2`, [charId, slot, left]);
      } else {
        await c.query(`DELETE FROM character_belt WHERE character_id = $1 AND slot = $2`,
          [charId, slot]);
      }
      return left;
    });
  } catch (e) {
    if (e.message === 'no_elixir') {              // рюкзак пуст — освобождаем ячейку
      await game.query(`DELETE FROM character_belt WHERE character_id = $1 AND slot = $2`,
        [charId, slot]).catch(() => {});
    }
    p?.send({ type: 'error', error: e.message || 'no_elixir' });
    return false;
  }

  // цель эффекта: выбранный в ростере союзник или себя (своя сторона, живой)
  let tf = me;
  if (msg.target != null) {
    const cand = b.engine.fighter(cid(msg.target));
    if (cand && cand.alive && cand.side === me.side) tf = cand;
  }
  const kind = params.kind;
  let healed = 0, mult = 1, turns = 0;
  if (kind === 'health') {
    // лечим на абсолютную величину из шаблона, зажатую до макс. HP (анти-чит)
    healed = b.engine.heal(tf.id, clampNum(params.heal, 1, tf.maxHp, Math.round(tf.maxHp * 0.3)));
  } else {
    mult = clampNum(params.mult, 1, 2, 1.3);
    turns = clampNum(params.turns, 1, 5, 3);
    b.engine.addBuff(tf.id, mult, turns);
  }
  await snapshot(b.id, b);

  // slotQty (остаток заряда в ячейке пояса после списания) уже посчитан выше в tx
  broadcast(b, (q) => {
    const qme = b.engine.fighter(q.charId);
    return { type: 'elixir',
      byId: cid(charId),                                  // кто выпил (лог/слот)
      onSelf: cid(q.charId) === cid(tf.charId ?? ''),     // эффект пришёлся зрителю → его плашка
      isUser: cid(q.charId) === cid(charId),              // зритель — пьющий → его пояс/чип
      kind, heal: healed, mult, turns, buffTurns: tf.buffTurns,
      hp: Math.round(tf.hp), maxHp: tf.maxHp,
      slot, slotQty,
      roster: rosterFor(b, qme.side) };
  });
  return true;
}

async function resolveCurrent(b) {
  if (b.engine.phase !== 'choose') return;
  clearInterval(b.timer);
  const r = b.engine.resolveActive();
  for (const s of r.strikes) {
    s.actorId  = b.engine.fighter(s.attackerId)?.charId ?? null;
    s.targetId = b.engine.fighter(s.defenderId)?.charId ?? null;
    const ap = s.actorId && b.players.get(cid(s.actorId));
    if (ap && !s.dodged) ap.totalDamage += s.damage;
  }
  await snapshot(b.id, b);
  logRounds(b.id, r.turn, r.strikes).catch(console.error);
  broadcast(b, (p) => resolveFor(b, p, r));
  // клиент проигрывает анимации и шлёт turnDone; страховка — авто.
  // Если все игроки отключены, ждать некого: заочный бой идёт в полном темпе.
  const anyAttached = attachedList(b).length > 0;
  const step = b.step;
  b.finishTimer = setTimeout(() => { if (b.step === step) advance(b); },
    anyAttached ? 6000 : 1500);
}

export async function finishTurn(charId) {
  const b = live.get(byChar.get(cid(charId)));
  if (!b || b.engine.phase !== 'resolving') return;
  const p = b.players.get(cid(charId));
  if (p) p.turnDone = true;
  if (attachedList(b).some((x) => !x.turnDone)) return;
  advance(b);
}

function advance(b) {
  if (b.engine.phase !== 'resolving') return;
  clearTimeout(b.finishTimer);
  if (b.engine.finished()) return void endBattle(b).catch(console.error);
  const next = b.engine.advance();
  if (next) enterActor(b);
  else beginRound(b);
}

// ============================================================
// Завершение / прерывание / побег
// ============================================================
function dropLive(b) {
  clearInterval(b.timer); clearTimeout(b.finishTimer);
  live.delete(b.id);
  for (const p of b.players.values()) byChar.delete(p.charId);
}

async function endBattle(b) {
  dropLive(b);
  b.engine.phase = 'ended';
  const winner = b.engine.winner();   // абсолютная сторона
  const reward = b.kind === 'hunt' ? await gameConfig('battle.reward.hunt') : null;

  await tx(async (c) => {
    await c.query(
      `UPDATE battles SET status = 3, ended_at = now(), winner_side = $2 WHERE id = $1`,
      [b.id, winner === 'left' ? 1 : winner === 'right' ? 2 : null]);
    for (const p of b.players.values()) {
      const me = b.engine.fighter(p.charId);
      const victory = winner === p.side;
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
  broadcast(b, (p) => ({ type: 'battleEnd',
    winner: winner ? (winner === p.side ? 'left' : 'right') : null,
    victory: winner === p.side,
    sides: sidesFor(b, p), roster: rosterFor(b, p.side),
    reward: winner === p.side && reward ? reward : null }));

  if (b.kind === 'hunt' && winner === 'left') {
    const lp = playerList(b).find((p) => p.side === 'left');
    if (lp) onHuntVictory(lp.charId, (text) =>
      lp.send({ type: 'chat', from: 'Система', text })).catch(console.error);
  }
}

async function abortBattle(b, reason) {
  dropLive(b);
  b.engine.phase = 'ended';
  await tx(async (c) => {
    await c.query(
      `UPDATE battles SET status = 4, ended_at = now() WHERE id = $1`, [b.id]);
    for (const p of b.players.values()) {
      await c.query(
        `UPDATE battle_participants SET status = 3, result = 4, left_round = $3
          WHERE battle_id = $1 AND character_id = $2`,
        [b.id, p.charId, b.engine.turn]);
      await c.query(`UPDATE characters SET hp_cur = $2 WHERE id = $1`,
        [p.charId, b.engine.fighter(p.charId).maxHp]);
    }
  });
  await redis.del(snapKey(b.id));
  broadcast(b, (p) => ({ type: 'battleEnd', winner: null, victory: false,
    aborted: true, reason, sides: sidesFor(b, p), roster: rosterFor(b, p.side) }));
}

/** Эликсир побега: расход предмета и выход из боя — одно целое. */
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
  await escapeFighter(b, cid(charId));
}

/** Боец покидает бой: остальным бой продолжается, если на стороне ещё есть живые. */
async function escapeFighter(b, charId) {
  const p = b.players.get(charId);
  const f = b.engine.fighter(charId);
  if (!p || !f) return;
  f.alive = false; f.hp = 0;
  b.engine.acted.add(f.id);

  await tx(async (c) => {
    await c.query(
      `UPDATE battle_participants SET status = 3, result = 4, left_round = $3,
          damage_dealt = $4 WHERE battle_id = $1 AND character_id = $2`,
      [b.id, charId, b.engine.turn, p.totalDamage]);
    await c.query(`UPDATE characters SET hp_cur = $2 WHERE id = $1`, [charId, f.maxHp]);
  });
  p.send({ type: 'battleEnd', winner: null, victory: false, aborted: true,
    reason: 'escape', sides: sidesFor(b, p), roster: rosterFor(b, f.side) });
  byChar.delete(charId);
  b.players.delete(charId);
  await snapshot(b.id, b);

  if (b.engine.finished()) return void endBattle(b).catch(console.error);
  // если уходил активный боец — двигаем ход дальше
  if (b.engine.phase === 'choose' && b.engine.currentActorId() === charId) {
    const next = b.engine.advance();
    if (next) enterActor(b); else beginRound(b);
  } else {
    for (const q of b.players.values())
      q.send({ type: 'rosterUpdate', roster: rosterFor(b, b.engine.fighter(q.charId).side) });
  }
}

/** Идущие бои в локации (для списка «вмешаться» на клиенте). */
export function activeBattlesInLocation(locId) {
  const out = [];
  for (const b of live.values()) {
    if (b.locationId !== locId || b.engine.phase === 'ended') continue;
    const left = b.engine.aliveOf('left').map((f) => f.name);
    const right = b.engine.aliveOf('right').map((f) => f.name);
    out.push({
      battleId: b.id,
      kind: b.kind,
      turn: b.engine.turn,
      allowJoin: b.policy.intervention === 'open',
      teams: { left, right },
    });
  }
  return out.sort((a, b) => a.battleId - b.battleId);
}

/** Кнопка «Прервать бой» в админке. */
export async function adminAbort(battleId) {
  const b = live.get(Number(battleId));
  if (b) {
    console.log(`Бой ${battleId}: прерван админом (живой)`);
    await abortBattle(b, 'admin');
    return true;
  }
  const r = await game.query(
    `UPDATE battles SET status = 4, ended_at = now()
      WHERE id = $1 AND status IN (1, 2)`, [battleId]);
  console.log(`Бой ${battleId}: abort без live-состояния, обновлено строк: ${r.rowCount}`);
  return r.rowCount > 0;
}

/** Админка: открыть/закрыть вмешательство в конкретный бой вживую. */
export async function adminSetIntervention(battleId, open) {
  const r = await game.query(
    `UPDATE battles SET intervention = $2 WHERE id = $1`,
    [battleId, open ? 1 : 2]);
  const b = live.get(Number(battleId));
  if (b) {
    b.policy.intervention = open ? 'open' : 'closed';
    broadcast(b, () => ({ type: 'policy', intervention: b.policy.intervention }));
  }
  return r.rowCount > 0 || !!b;
}

export function leaveBattle(charId) {
  const b = live.get(byChar.get(cid(charId)));
  if (b && !b.policy.allowLeave) throw err('cannot_leave', 403);
  // allowLeave — выход без эликсира (бой продолжается для остальных)
  if (b) return escapeFighter(b, cid(charId));
}

// ============================================================
// REST-страховка к push battleResume + окно «Бой #N»
// ============================================================
export function battleRoutes(app, authed) {
  app.get('/api/battle/current', authed, (req, res) => {
    res.json(resumePayload(req.session.character_id) || { battleId: null });
  });

  app.get('/api/battles/:id', authed, async (req, res) => {
    const id = Number(req.params.id);
    const battle = (await game.query(
      `SELECT id, type, status, winner_side, meta, started_at, ended_at, intervention
         FROM battles WHERE id = $1`, [id])).rows[0];
    if (!battle) throw err('not_found', 404);
    const meta = battle.meta || {};

    const b = live.get(id);
    if (b) {
      const teamMembers = async (side) => {
        const out = [];
        for (const fid of b.engine.teams[side]) {
          const f = b.engine.fighter(fid);
          let mp = 0;
          if (f.charId) {
            const mr = (await game.query(
              `SELECT mp_cur FROM characters WHERE id = $1`, [f.charId])).rows[0];
            mp = mr ? mr.mp_cur : 0;
          }
          out.push({ name: f.name, level: f.level, hp: Math.round(f.hp),
            maxHp: f.maxHp, mp: f.charId ? mp : 0, maxMp: 100, alive: f.alive });
        }
        return out;
      };
      return res.json({
        battleId: id, status: 'active', turn: b.engine.turn,
        intervention: b.policy.intervention,
        allowJoin: b.policy.intervention === 'open',
        startedAt: battle.started_at,
        teams: { left: await teamMembers('left'), right: await teamMembers('right') },
      });
    }

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
      startedAt: battle.started_at,
      endedAt: battle.ended_at,
      results,
    });
  });
}
