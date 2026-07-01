import { randomUUID } from 'crypto';
import { game, tx, redis, gameConfig } from '../db.js';
import { Engine } from './engine.js';
import { makeModel } from './stats.js';
import { composeBuild } from './gear.js';
import { addCurrency, CUR } from '../economy.js';
import { addExp, combatProfileFor, combatModelFor, getCharacter } from '../characters.js';
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
    effectTimer: null, lastEffectAt: 0,   // тикер эффектов по времени (HoT/DoT/мана)
    watchdog: null, resolveAt: 0,         // сторож зависаний + время входа в розыгрыш (#1)
    stats: new Map(),   // id бойца движка -> { damage, kills } по ВСЕМ (вкл. ИИ-шайку, #1.3/1.4)
    step: 0 };   // токен sub-turn: отложенные колбэки устаревают при смене (анти-двойной-advance)
}
function addPlayer(b, charId, send, side) {
  b.players.set(cid(charId),
    { charId: cid(charId), side, send: send || noop, attached: true,
      totalDamage: 0, kills: 0, turnDone: false });
  return b.players.get(cid(charId));
}
const playerList = (b) => [...b.players.values()];
const attachedList = (b) => playerList(b).filter((p) => p.attached);

/** Боевая статистика бойца движка по его id (урон/убийства) — для ВСЕХ участников,
 *  включая ИИ-бойцов шайки, чтобы итог боя показывал каждого (#1.3/#1.4). */
function statFor(b, fid) {
  const key = String(fid);
  let s = b.stats.get(key);
  if (!s) { s = { damage: 0, kills: 0 }; b.stats.set(key, s); }
  return s;
}

function broadcast(b, payloadFor) {
  for (const p of b.players.values()) p.send(payloadFor(p));
}

// --- зеркалирование: команда зрителя как left ---
const pub = (f) => f && ({ id: f.id, name: f.name, level: f.level,
  hp: Math.round(f.hp), maxHp: f.maxHp, alive: f.alive,
  mp: Math.round(f.mp || 0), maxMp: f.maxMp || 0,
  buffTurns: f.buffTurns || 0, buffMult: f.buffMult || 1, buffQuality: f.buffQuality || 0,
  critBuffTurns: f.critBuffTurns || 0, critBuffAdd: f.critBuffAdd || 0,
  critBuffQuality: f.critBuffQuality || 0,
  effects: (f.effects || []).map((e) => ({ kind: e.kind, q: e.quality || 0,
    remainSec: Math.max(0, Math.ceil((e.durationMs - e.elapsedMs) / 1000)),
    // точный остаток (мс): клиент ведёт ПЛАВНЫЙ локальный отсчёт от него, а каждое
    // событие лишь ресинкает — без ±1с дёрганья таймера эффекта
    remainMs: Math.max(0, Math.round(e.durationMs - e.elapsedMs)),
    everySec: Math.max(1, Math.round((e.stepMs || 5000) / 1000)) })) });
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
  const right = focus || b.engine.opponentOf(me.id) || anyEnemy(b, me.side);
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
    } else if (af.side !== vSide) {
      const myOpp = e.opponentOf(me.id);
      const actorOpp = e.opponentOf(af.id);
      if ((myOpp && String(myOpp.id) === String(af.id))
          || (actorOpp && String(actorOpp.id) === String(me.id))) {
        focus = af;
      } else {
        waiting = true; focus = myOpp || null;
      }
    } else { waiting = true; focus = e.opponentOf(me.id) || null; }
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

function elixirEventFor(b, q, actor, target, data) {
  const qme = b.engine.fighter(q.charId);
  const isTargetSelf = target.charId != null && cid(q.charId) === cid(target.charId);
  const isActorSelf = actor.charId != null && cid(q.charId) === cid(actor.charId);
  return {
    type: 'elixir',
    byId: actor.id,
    byName: actor.name,
    targetId: target.id,
    targetName: target.name,
    targetSide: target.side === qme.side ? 'left' : 'right',
    target: pub(target),
    onSelf: isTargetSelf,
    isUser: isActorSelf,
    kind: data.kind,
    itemName: data.itemName || '',
    heal: data.heal || 0,
    mult: data.mult || 1,
    turns: data.turns || 0,
    secs: data.secs || 0,             // длительность эффекта по времени (HoT/DoT/мана)
    everySec: data.everySec || 0,     // период дискретного тика (сек), для подписи «каждые N c»
    amount: data.amount || 0,         // суммарная величина эффекта (HP/MP)
    critAdd: data.critAdd || 0,       // прибавка к криту («Эликсир крови»)
    removed: data.removed || null,    // снятые виды («Свиток очищения»)
    cooldownUntil: data.cooldownUntil || 0,   // тайм-аут свитка (для пьющего)
    buffTurns: target.buffTurns || 0,
    hp: Math.round(target.hp),
    maxHp: target.maxHp,
    mp: Math.round(target.mp || 0),
    maxMp: target.maxMp || 0,
    slot: data.slot,
    slotQty: data.slotQty,
    roster: rosterFor(b, qme.side),
  };
}

function broadcastElixir(b, actor, target, data) {
  broadcast(b, (q) => elixirEventFor(b, q, actor, target, data));
}

/** Настройки выбора цели — оставлены для совместимости (движок их больше не чтит:
 *  пары строгие 1:1 и ротируются по таймеру, см. engine.assignTargets). */
const numCfg = (v, d) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));
async function targetCfg() {
  return {
    switchChance: numCfg(await gameConfig('battle.target.switch_chance'), 0.25),
    coldTurns:    numCfg(await gameConfig('battle.target.cold_turns'), 2),
    coldWeight:   numCfg(await gameConfig('battle.target.cold_weight'), 1.5),
  };
}

/** Ротация дуэльных пар (раундов на раскладку): неравный бой — часто (ждущий
 *  быстро вступает), ровные команды — редко (иногда перемешать). См. engine. */
async function pairRotateCfg() {
  return {
    uneven: numCfg(await gameConfig('battle.pair_rotate_uneven'), 2),
    even:   numCfg(await gameConfig('battle.pair_rotate_even'), 4),
  };
}

/**
 * Инициатива (кто ходит первым) — определяется ОДИН РАЗ при входе в бой и не
 * зависит от роли: напал ты, напали на тебя или ты вмешался (#3). База — ловкость
 * (agi), иначе уровень; сверху случайный бросок (0..1), который решает порядок
 * при равной ловкости. Значение фиксируется в бойце движка и больше не меняется,
 * поэтому очередь раундов стабильна (см. engine._buildOrder).
 */
const MAX_MP = 100;   // запасной максимум маны (старая механика без модели)
/** Текущая мана персонажа для бойца движка («Эликсир маны» восстанавливает её).
 *  maxMp — из модельного стата «Мана» (панель «Параметры» и бой показывают одно
 *  и то же число), при выключенной модели — прежние 100. */
async function mpFor(charId, maxMp = MAX_MP) {
  const cap = Math.max(1, Math.round(Number(maxMp) || MAX_MP));
  const row = (await game.query(
    `SELECT mp_cur FROM characters WHERE id = $1`, [charId])).rows[0];
  return { mp: Math.min(cap, row ? Number(row.mp_cur) || 0 : 0), maxMp: cap };
}

async function initiativeFor(charId, level) {
  const row = (await game.query(
    `SELECT agi FROM character_stats WHERE character_id = $1`, [charId])).rows[0];
  const base = Number(row?.agi) || Number(level) || 0;
  return base + Math.random();
}

// Боевая модель треугольника (Broken Sun): коэффициенты по умолчанию (critBlockPierce,
// нормировка и пр. — см. battle/stats.js). Включается флагом game_config 'battle.model'
// (мгновенный выкл, если в live что-то не так). По умолчанию ВЫКЛ — старая механика.
const battleModel = makeModel();
async function modelEnabled() {
  const cfg = await gameConfig('battle.model');
  return !!(cfg && cfg.enabled);
}

/** Деф бойца-игрока: модельный (school из атрибутов → composeBuild) или старый профиль.
 *  extra перекрывает базу (например, initiative). */
async function playerDef(ch, useModel, start, extra = {}) {
  const combat = useModel
    ? await combatModelFor(ch.id, ch.level)
    : await combatProfileFor(ch.id, start);
  const manaCap = useModel && combat.stats ? combat.stats.mana : MAX_MP;
  return { id: ch.id, charId: ch.id, name: ch.name, level: ch.level, isAI: false,
    ...combat, ...(await mpFor(ch.id, manaCap)), ...extra };
}

/** Подмешать модельные статы NPC (для модельного боя): школа из шаблона или нейтраль. */
function withNpcModel(member, fallbackLevel) {
  const level = member.level ?? fallbackLevel ?? 1;
  const built = composeBuild(member.school || 'natisk', {
    level,
    equipped: Array.isArray(member.equipped) ? member.equipped : [],
    allocFrac: member.allocFrac != null ? Number(member.allocFrac) : 0,
  });
  const hpMult = Number.isFinite(Number(member.modelHpMult)) ? Number(member.modelHpMult) : 0.95;
  const powerMult = Number.isFinite(Number(member.modelPowerMult)) ? Number(member.modelPowerMult) : 0.78;
  built.stats.health = Math.max(1, Math.round(built.stats.health * hpMult));
  built.stats.power = Math.max(1, Math.round(built.stats.power * powerMult));
  return { ...member, stats: built.stats, statNorm: built.statNorm,
           hp: built.stats.health, damage: member.damage || [1, 1] };
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
export async function startHunt(ch, send, npcId = null) {
  if (byChar.has(cid(ch.id))) throw err('already_in_battle', 409);

  // npcId (опц.) — какую цель локации бить (напр. «Шайка разбойников»); сервер
  // ВАЛИДИРУЕТ, что она тут водится (анти-чит). Без него — первая цель локации.
  const tid = Number(npcId) || null;
  const npc = (await game.query(
    `SELECT t.id, t.name, t.level, t.stats FROM npc_spawns s
       JOIN npc_templates t ON t.id = s.npc_template_id
      WHERE s.location_id = $1 ${tid ? 'AND t.id = $2' : ''}
        AND t.active = TRUE AND t.kind IN (1, 3)
      ORDER BY t.id LIMIT 1`, tid ? [ch.location_id, tid] : [ch.location_id])).rows[0];
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

  // Правая сторона: «пачка» (stats.pack = массив бойцов с ролями) ИЛИ одиночка.
  // У пачки каждый боец — свои hp/урон + роль (яд/лечение/мощь, см. applyAiElixirs).
  const stats = npc.stats || {};
  const pack = Array.isArray(stats.pack) ? stats.pack : null;
  const right = pack
    ? pack.map((m, i) => ({
        id: `npc-${npc.id}-${i + 1}`, name: m.name || `${npc.name} ${i + 1}`,
        level: m.level ?? npc.level, isAI: true,
        hp: Number(m.hp) || 100, damage: m.damage || [7, 11],
        crit: m.crit ?? 0.1, dodge: m.dodge ?? 0.05,
        aiPoisonUses: m.aiPoisonUses, aiPoisonPct: m.aiPoisonPct,
        aiPoisonSecs: m.aiPoisonSecs, aiPoisonEvery: m.aiPoisonEvery,
        aiHealAllyUses: m.aiHealAllyUses, aiHealAmount: m.aiHealAmount, aiHealAt: m.aiHealAt,
        aiPowerUses: m.aiPowerUses, aiPowerMult: m.aiPowerMult, aiPowerTurns: m.aiPowerTurns }))
    : [{ id: `npc-${npc.id}`, name: npc.name, level: npc.level, isAI: true,
         ...stats, hp: Number(stats.hp) || 180, damage: stats.damage || [13, 19],
         aiHealUses: stats.aiHealUses ?? 0, aiPowerUses: stats.aiPowerUses ?? 0,
         aiHealAmount: stats.aiHealAmount ?? 45, aiHealAt: stats.aiHealAt ?? 0.45,
         aiPowerMult: stats.aiPowerMult ?? 1.15, aiPowerTurns: stats.aiPowerTurns ?? 1 }];
  // награда: переопределение из шаблона (stats.reward) либо общий конфиг охоты
  const huntReward = (stats.reward && typeof stats.reward === 'object') ? stats.reward : null;

  // модельный бой (треугольник) — если включён флагом; тогда и игрок, и NPC несут stats-блок
  const useModel = await modelEnabled();
  const engine = new Engine({
    left:  [await playerDef(ch, useModel, start)],
    right: useModel ? right.map((m) => withNpcModel(m, npc.level)) : right,
  }, { turnTime, target: await targetCfg(), pairRotate: await pairRotateCfg(),
       model: useModel ? battleModel : null,
       counterChance: numCfg(await gameConfig('battle.counter_chance'), 1) });

  const b = makeBattle(battleId, 'hunt', ch.location_id, policy, engine);
  b.npcId = npc.id;
  b.reward = huntReward;   // null → endBattle возьмёт battle.reward.hunt из конфига
  const p = addPlayer(b, ch.id, send, 'left');
  live.set(battleId, b);
  byChar.set(cid(ch.id), battleId);
  await snapshot(battleId, b);
  console.log(`Бой ${battleId}: старт охоты, char=${ch.id} (${ch.name})`);
  sendSystemChat(ch.location_id,
    `Бой #${battleId}: ${ch.name} против «${npc.name}» — начался!`)
    .catch(console.error);

  p.send({ type: 'battleStart', battleId, kind: 'hunt', ...startView(b, p) });
  startEffectTicker(b);
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
  const useModel = await modelEnabled();
  const engine = new Engine({
    left:  [await playerDef(att, useModel, start, { initiative: attIni })],
    right: [await playerDef(def, useModel, start, { initiative: defIni })],
  }, { turnTime, target: await targetCfg(), pairRotate: await pairRotateCfg(),
       model: useModel ? battleModel : null,
       counterChance: numCfg(await gameConfig('battle.counter_chance'), 1) });

  const b = makeBattle(battleId, 'pvp', att.location_id, policy, engine);
  addPlayer(b, att.id, sendAtt, 'left');
  addPlayer(b, def.id, sendDef, 'right');
  live.set(battleId, b);
  byChar.set(cid(att.id), battleId);
  byChar.set(cid(def.id), battleId);
  await snapshot(battleId, b);
  console.log(`Бой ${battleId}: PvP, ${att.name} (${att.id}) напал на ${def.name} (${def.id})`);
  sendSystemChat(att.location_id,
    `Бой #${battleId}: ${att.name} против ${def.name} — начался!`)
    .catch(console.error);

  broadcast(b, (p) => ({ type: 'battleStart', battleId, kind: 'pvp', ...startView(b, p) }));
  startEffectTicker(b);
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
  // согласованность: вмешавшийся строится по модели САМОГО боя (она задана при старте)
  const useModel = !!b.engine.model;
  b.engine.addFighter(side, await playerDef(ch, useModel, start, { initiative }));
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
    `Бой #${b.id}: ${ch.name} вмешивается в бой!`).catch(console.error);

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
  if (b.timer) { clearInterval(b.timer); b.timer = null; }
  const step = b.step;
  // Таймер привязан к «стене» (turnEndsAt), а не к «вычесть 1 за тик»: при задержках
  // событийного цикла (снапшоты, GC, запись в БД) значение не уплывает и тайм-аут
  // срабатывает ровно по сроку — бой остаётся точным.
  //
  // Интервал гасит СВОЙ id (а не b.timer): устаревший тик из прошлого хода больше
  // не убивает уже созданный таймер следующего — это и был «таймер завис на месте».
  const id = setInterval(() => {
    if (b.step !== step || b.engine.phase !== 'choose') {
      clearInterval(id);
      if (b.timer === id) b.timer = null;
      return;
    }
    const left = Math.max(0, Math.ceil((b.turnEndsAt - Date.now()) / 1000));
    broadcast(b, () => ({ type: 'timer', timeLeft: left }));
    if (left <= 0) {
      clearInterval(id);
      if (b.timer === id) b.timer = null;
      onTurnTimeout(b);
    }
  }, 1000);
  b.timer = id;
}

/** Самый раненый (по доле HP) живой союзник бойца — цель ИИ-лекаря. */
function mostInjuredAlly(b, af) {
  let best = null, bestFrac = 2;
  for (const id of b.engine.teams[af.side]) {
    const f = b.engine.fighter(id);
    if (!f || !f.alive) continue;
    const frac = f.maxHp ? f.hp / f.maxHp : 1;
    if (frac < bestFrac) { bestFrac = frac; best = f; }
  }
  return best;
}

function applyAiElixirs(b, af) {
  if (!af || !af.isAI || !af.alive) return;
  if ((af.aiPowerUses || 0) > 0 && af.buffTurns <= 0) {
    af.aiPowerUses -= 1;
    const mult = clampNum(af.aiPowerMult, 1, 2, 1.5);
    const turns = clampNum(af.aiPowerTurns, 1, 5, 3);
    b.engine.addBuff(af.id, mult, turns);
    broadcastElixir(b, af, af, { kind: 'power', mult, turns, itemName: 'Эликсир мощи' });
  }
  if ((af.aiHealUses || 0) > 0 && af.hp <= af.maxHp * (af.aiHealAt || 0.6)) {
    af.aiHealUses -= 1;
    const amount = clampNum(af.aiHealAmount, 1, af.maxHp, 800);
    const healed = b.engine.heal(af.id, amount);
    broadcastElixir(b, af, af, { kind: 'health', heal: healed, itemName: 'Эликсир жизни' });
  }
  // лекарь «пачки»: лечит самого раненого живого союзника (вкл. себя), если тот просел
  if ((af.aiHealAllyUses || 0) > 0) {
    const ally = mostInjuredAlly(b, af);
    if (ally && ally.hp < ally.maxHp * clampNum(af.aiHealAt, 0.1, 1, 0.7)) {
      af.aiHealAllyUses -= 1;
      const amount = clampNum(af.aiHealAmount, 1, ally.maxHp, 450);
      const healed = b.engine.heal(ally.id, amount);
      broadcastElixir(b, af, ally, { kind: 'health', heal: healed, itemName: 'Эликсир жизни' });
    }
  }
  // отравитель «пачки»: травит своего соперника, если на нём ещё нет ЕГО яда (без бесконечного стака)
  if ((af.aiPoisonUses || 0) > 0) {
    const foe = b.engine.opponentOf(af.id) || b.engine.enemiesOf(af.id)[0] || null;
    if (foe && !foe.effects.some((e) => e.kind === 'poison' && String(e.srcId) === String(af.id))) {
      af.aiPoisonUses -= 1;
      const secs = clampNum(af.aiPoisonSecs, 1, 600, 40);
      const every = clampNum(af.aiPoisonEvery, 1, secs, 5);
      const amount = Math.round(foe.maxHp * clampNum(af.aiPoisonPct, 0.01, 1, 0.1));
      b.engine.addOverTime(foe.id, 'poison', amount, secs * 1000, af.id, true, 0, every * 1000);
      broadcastElixir(b, af, foe,
        { kind: 'poison', amount, secs, everySec: every, itemName: 'Свиток отравления' });
    }
  }
  snapshot(b.id, b).catch(console.error);
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
  if (af.isAI) applyAiElixirs(b, af);
  // Игрок, прозевавший ход по тайм-ауту, почти всегда не отвечает и на сетевые
  // события (лаг/AFK — потому и прозевал). Не ждём от него turnDone после
  // розыгрыша, иначе ход висит до страховочного advance, а у всех таймер «замер
  // на 0:00». Зрители ход подтвердят сами, а этот боец уже отыграл.
  if (!af.isAI && af.charId != null) {
    const tp = b.players.get(cid(af.charId));
    if (tp) tp.turnDone = true;
  }
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
  // дуэльная пара «напротив» задана assignTargets в startRound и держится весь
  // раунд (ротация — между раундами); отдельный ре-пик в суб-ходе не нужен.
  broadcast(b, (p) => turnStartFor(b, p));
  startTurnTimer(b);
  if (af && af.isAI) {
    setTimeout(() => {
      if (b.step !== step) return;   // ход уже сменился — не дублируем
      if (b.engine.phase === 'choose' && b.engine.currentActorId() === af.id) {
        applyAiElixirs(b, af);
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

// --- Эффекты по времени (HoT/DoT/мана) тикают по «настенным» часам независимо от
//     ходов: один интервал на бой (engine.tickEffects). Запускается на старте боя,
//     гасится в dropLive. Рассылает effectTick с обновлёнными HP/MP и ростером. ---
function startEffectTicker(b) {
  if (b.effectTimer) return;
  b.lastEffectAt = Date.now();
  b.effectTimer = setInterval(() => onEffectTick(b), 1000);
  startWatchdog(b);
}

// Сторож зависаний (#1, #4): независимый от пер-секундного таймера и finishTimer
// бэкстоп. Если по какой-то причине (потерянный таймер, не пришедший turnDone,
// сбой анимации у клиента) ход «застрял» — принудительно двигаем бой дальше,
// чтобы он НИКОГДА не висел. Срабатывает только с запасом за обычными сроками,
// поэтому в здоровом бою не вмешивается.
const WATCHDOG_MS = 2000;
const CHOOSE_GRACE_MS = 3000;     // запас сверх turnEndsAt (обычный таймер уже должен был сработать)
const RESOLVE_MAX_MS = 9000;      // максимум на розыгрыш sub-turn'а (finishTimer ≤ 6c)
function startWatchdog(b) {
  if (b.watchdog) return;
  b.watchdog = setInterval(() => {
    try {
      const e = b.engine;
      if (!e || e.phase === 'ended') return;
      const now = Date.now();
      if (e.phase === 'choose') {
        if (b.turnEndsAt > 0 && now > b.turnEndsAt + CHOOSE_GRACE_MS) {
          console.warn(`Бой ${b.id}: сторож — застрял выбор хода, форсируем тайм-аут`);
          onTurnTimeout(b);
        }
      } else if (e.phase === 'resolving') {
        if (b.resolveAt > 0 && now > b.resolveAt + RESOLVE_MAX_MS) {
          console.warn(`Бой ${b.id}: сторож — застрял розыгрыш, форсируем переход хода`);
          advance(b);
        }
      }
    } catch (err) {
      console.error(`Бой ${b.id}: ошибка сторожа`, err);
    }
  }, WATCHDOG_MS);
}

function onEffectTick(b) {
  try {
    onEffectTickInner(b);
  } catch (e) {
    console.error(`Бой ${b?.id}: ошибка тика эффектов`, e);
  }
}
function onEffectTickInner(b) {
  if (!b || b.engine.phase === 'ended') return;
  const now = Date.now();
  const dt = now - (b.lastEffectAt || now);
  b.lastEffectAt = now;
  const res = b.engine.tickEffects(dt);
  if (!res.changed.length) return;
  // статистика (#1): урон ядом и скальпы засчитываем КАСТЕРУ (по srcId эффекта)
  for (const [srcId, amount] of res.damageBySrc) {
    if (srcId != null) statFor(b, srcId).damage += Math.round(amount);
    const sf = b.engine.fighter(srcId);
    const sp = sf && sf.charId != null && b.players.get(cid(sf.charId));
    if (sp) sp.totalDamage += Math.round(amount);
  }
  for (const k of res.kills) {
    logEffectKill(b, k).catch(console.error);
    if (k.killerId != null) statFor(b, k.killerId).kills += 1;   // скальп — отравителю
    const sf = b.engine.fighter(k.killerId);
    const sp = sf && sf.charId != null && b.players.get(cid(sf.charId));
    if (sp) sp.kills += 1;
  }
  snapshot(b.id, b).catch(console.error);
  broadcast(b, (p) => effectTickFor(b, p, res));
  if (res.deaths.length) handleEffectDeaths(b);
}

/** Лог гибели от яда в battle_rounds (death=5), чтобы итог боя был полным. */
async function logEffectKill(b, k) {
  const killer = b.engine.fighter(k.killerId);
  const victim = b.engine.fighter(k.victimId);
  await game.query(
    `INSERT INTO battle_rounds (battle_id, round_no, action_seq, actor_id,
        action_type, target_id, value, effects)
     VALUES ($1, $2, 0, $3, 5, $4, 0, '{"poison":true}')`,
    [b.id, b.engine.turn, killer?.charId ?? null, victim?.charId ?? null]);
}

/** effectTick для зрителя: изменившиеся бойцы переведены в его систему (он — left).
 *  `dHp` — чистое изменение HP от эффектов за тик (для всплывашек, #2). */
function effectTickFor(b, p, res) {
  const me = b.engine.fighter(p.charId);
  const vSide = me ? me.side : 'left';
  return {
    type: 'effectTick',
    self: me ? pub(me) : null,
    changed: res.changed.map((f) => ({ side: f.side === vSide ? 'left' : 'right',
      dHp: Math.round((f._effDelta || 0) * 100) / 100, ...pub(f) })),
    deaths: res.deaths.map(String),
    roster: rosterFor(b, vSide),
  };
}

/** Кто-то умер от яда (тик эффекта): закрыть бой или сдвинуть зависший ход. */
function handleEffectDeaths(b) {
  if (b.engine.finished()) return void endBattle(b).catch(console.error);
  // активный боец умер от яда в свою фазу выбора — двигаем ход дальше
  if (b.engine.phase === 'choose' && !b.engine.currentActor()) {
    const next = b.engine.advance();
    if (next) enterActor(b); else beginRound(b);
  }
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
  // ячейка пояса: шаблон + заряды (quantity). Параметры эффекта — из шаблона на
  // сервере (анти-чит), не из клиента.
  const slot = Number(msg.slot);
  const belt = (await game.query(
    `SELECT b.template_id, b.quantity, t.base_stats, t.name, t.quality FROM character_belt b
       JOIN item_templates t ON t.id = b.template_id
      WHERE b.character_id = $1 AND b.slot = $2`, [charId, slot])).rows[0];
  const params = belt && elixirParams(belt.base_stats);
  if (!params || Number(belt.quantity) <= 0) {
    p?.send({ type: 'error', error: 'belt_empty' }); return false;
  }
  const itemName = belt.name || '';      // имя расходника — для всплывашки в бою (ТЗ #4)
  const itemQ = Number(belt.quality) || 1;   // качество — цвет чипа эффекта (ТЗ #3)
  // Расходники можно применять в ЛЮБОЙ ход (не обязательно свой) — эффекты идут по
  // реальному времени. Ограничения: тайм-аут свитка и «эликсир того же вида уже活ен».
  const kind = params.kind;
  const SCROLL = kind === 'poison' || kind === 'heal_scroll' || kind === 'cleanse';
  // тайм-аут свитка (wall-clock, на пьющего): нельзя бросить тот же свиток, пока идёт
  if (SCROLL && (me.cooldowns[kind] || 0) > Date.now()) {
    p?.send({ type: 'error', error: 'on_cooldown', cooldownUntil: me.cooldowns[kind] });
    return false;
  }
  // Цель расходника (ТЗ §A — строгие правила применения):
  //  • эликсиры (жизнь/мощь/мана/кровь) и побег — ТОЛЬКО на себя (выбор цели игнорируем);
  //  • свиток ИСЦЕЛЕНИЯ — ТОЛЬКО на союзника (по умолчанию на себя; врага лечить нельзя);
  //  • свиток ОТРАВЛЕНИЯ — ТОЛЬКО на врага (выбранного либо того, кто напротив);
  //  • свиток ОЧИЩЕНИЯ — на любого бойца (союзник/враг/себя).
  let tf = me;
  const sel = msg.target != null ? b.engine.fighter(cid(msg.target)) : null;
  if (kind === 'poison') {
    tf = (sel && sel.alive && sel.side !== me.side)
      ? sel : (b.engine.opponentOf(me.id) || b.engine.enemiesOf(me.id)[0] || null);
    if (!tf) { p?.send({ type: 'error', error: 'no_target' }); return false; }
  } else if (kind === 'heal_scroll') {
    if (sel && sel.alive && sel.side !== me.side) {     // врага исцелять нельзя
      p?.send({ type: 'error', error: 'ally_only' }); return false;
    }
    if (sel && sel.alive) tf = sel;                     // живой союзник (включая себя)
  } else if (kind === 'cleanse') {
    if (sel && sel.alive) tf = sel;                     // очищение — на любого
  }
  // эликсиры (health/mana/power/blood) и escape — всегда на себя: tf остаётся me

  // ЭЛИКСИРЫ одного вида НЕ стакаются: нельзя наложить, пока тот же эффект активен на
  // цели (эликсир жизни заблокирован и при активном свитке исцеления). СВИТКИ —
  // стакаются (несколько союзников лечат/травят одного), их держит только тайм-аут.
  if (kind !== 'escape' && !SCROLL) {
    const busy =
      (kind === 'health' && tf.effects.some((e) => e.kind === 'health' || e.kind === 'heal_scroll'))
      || (kind === 'mana'  && tf.effects.some((e) => e.kind === 'mana'))
      || (kind === 'power' && tf.buffTurns > 0)
      || (kind === 'blood' && tf.critBuffTurns > 0);
    if (busy) { p?.send({ type: 'error', error: 'elixir_active' }); return false; }
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

  if (kind === 'escape') {
    broadcastElixir(b, me, me, { kind: 'escape', slot, slotQty, itemName });
    await escapeFighter(b, cid(charId));
    return true;
  }

  // применяем эффект (значения из шаблона зажаты — анти-чит). Лечение/урон/мана по
  // времени — через тикер (addOverTime); мощь/кровь — на ходы; очищение — снятие.
  const out = { kind, slot, slotQty, itemName };
  // период дискретного тика (сек): из шаблона, в окне [1c..длительность] (#3)
  const tickSec = (secs) => clampNum(params.tick, 1, secs, 5);
  if (kind === 'health' || kind === 'heal_scroll') {
    const secs = clampNum(params.secs, 1, 600, 60);
    out.secs = secs;
    out.everySec = tickSec(secs);
    out.amount = Math.round(tf.maxHp * clampNum(params.heal_pct, 0.01, 1, 0.2));
    // свиток исцеления стакается (несколько лекарей на одну цель), эликсир жизни — нет
    b.engine.addOverTime(tf.id, kind, out.amount, secs * 1000, me.id,
      kind === 'heal_scroll', itemQ, out.everySec * 1000);
  } else if (kind === 'mana') {
    const secs = clampNum(params.secs, 1, 600, 60);
    out.secs = secs;
    out.everySec = tickSec(secs);
    out.amount = Math.round((tf.maxMp || 0) * clampNum(params.mana_pct, 0.01, 1, 0.2));
    b.engine.addOverTime(tf.id, 'mana', out.amount, secs * 1000, me.id, false,
      itemQ, out.everySec * 1000);
  } else if (kind === 'poison') {
    const secs = clampNum(params.secs, 1, 600, 120);
    out.secs = secs;
    out.everySec = tickSec(secs);
    out.amount = Math.round(tf.maxHp * clampNum(params.dmg_pct, 0.01, 1, 0.15));
    // свиток отравления стакается: несколько источников яда на одной цели
    b.engine.addOverTime(tf.id, 'poison', out.amount, secs * 1000, me.id, true,
      itemQ, out.everySec * 1000);
  } else if (kind === 'power') {
    out.mult = clampNum(params.mult, 1, 2, 1.3);
    out.turns = clampNum(params.turns, 1, 5, 3);
    b.engine.addBuff(tf.id, out.mult, out.turns, itemQ);
  } else if (kind === 'blood') {
    out.critAdd = clampNum(params.crit_add, 0, 1, 0.2);
    out.turns = clampNum(params.turns, 1, 3, 1);
    b.engine.addCritBuff(tf.id, out.critAdd, out.turns, itemQ);
  } else if (kind === 'cleanse') {
    out.removed = b.engine.cleanse(tf.id, params.removes);
  }
  // тайм-аут свитка ставим после успешного применения (на пьющего)
  if (SCROLL) {
    me.cooldowns[kind] = Date.now() + clampNum(params.cooldown, 0, 600, 90) * 1000;
    out.cooldownUntil = me.cooldowns[kind];
  }
  await snapshot(b.id, b);

  // slotQty (остаток заряда в ячейке пояса после списания) уже посчитан выше в tx
  broadcastElixir(b, me, tf, out);
  return true;
}

async function resolveCurrent(b) {
  if (b.engine.phase !== 'choose') return;
  clearInterval(b.timer);
  b.resolveAt = Date.now();          // отметка для сторожа зависаний (#1)
  const r = b.engine.resolveActive();
  for (const s of r.strikes) {
    // статистика по id движка — для каждого бойца (вкл. ИИ-шайку, #1.4); убийство
    // засчитываем ТОЛЬКО тому, чей удар добил (s.killed на добивающем ударе, #1.3)
    if (!s.dodged) statFor(b, s.attackerId).damage += s.damage;
    if (s.killed)  statFor(b, s.attackerId).kills += 1;
    s.actorId  = b.engine.fighter(s.attackerId)?.charId ?? null;
    s.targetId = b.engine.fighter(s.defenderId)?.charId ?? null;
    const ap = s.actorId && b.players.get(cid(s.actorId));
    if (ap && !s.dodged) ap.totalDamage += s.damage;
    if (ap && s.killed) ap.kills += 1;
  }
  await snapshot(b.id, b);
  logRounds(b.id, r.turn, r.strikes).catch(console.error);
  broadcast(b, (p) => resolveFor(b, p, r));
  // клиент проигрывает анимации и шлёт turnDone; страховка — авто.
  // Если все игроки отключены, ждать некого: заочный бой идёт в полном темпе.
  // Пропуск/тайм-аут анимировать нечего — там короткий запас (иначе таймер
  // «висит» на 0:00 до страховки, если прозевавший соперник не шлёт turnDone).
  const anyAttached = attachedList(b).length > 0;
  const animated = r.strikes.length > 0;
  const step = b.step;
  b.finishTimer = setTimeout(() => { if (b.step === step) advance(b); },
    anyAttached && animated ? 6000 : 1500);
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

/**
 * Полный снимок итога боя по КАЖДОМУ бойцу движка (игроки + ИИ-шайка) — чтобы
 * таблица результатов показывала всех (а не одну строку «NPC», #1.4) и убийства
 * стояли у реальных убийц (#1.3). Кладётся в battles.meta.summary; финишное окно
 * «Бой #N» читает его в приоритете над старым агрегатом по battle_participants.
 *   side: 1 = left, 2 = right;  result: 1 победа, 2 поражение, 3 ничья.
 */
function buildSummary(b, winner) {
  return [...b.engine.fighters.values()].map((f) => {
    const st = b.stats.get(String(f.id)) || { damage: 0, kills: 0 };
    return {
      id: String(f.id), charId: f.charId ?? null, isAI: !!f.isAI,
      name: f.name, level: f.level,
      side: f.side === 'left' ? 1 : 2,
      damage: Math.round(st.damage), kills: st.kills,
      deaths: f.alive ? 0 : 1,
      result: winner ? (winner === f.side ? 1 : 2) : 3,
    };
  });
}

function dropLive(b) {
  clearInterval(b.timer); clearTimeout(b.finishTimer); clearInterval(b.effectTimer);
  clearInterval(b.watchdog);
  live.delete(b.id);
  for (const p of b.players.values()) byChar.delete(p.charId);
}

async function endBattle(b) {
  dropLive(b);
  b.engine.phase = 'ended';
  const winner = b.engine.winner();   // абсолютная сторона
  // награда охоты: переопределение боя (пачка) > общий конфиг battle.reward.hunt
  const reward = b.kind === 'hunt'
    ? (b.reward || await gameConfig('battle.reward.hunt')) : null;

  const summary = buildSummary(b, winner);
  await tx(async (c) => {
    await c.query(
      `UPDATE battles SET status = 3, ended_at = now(), winner_side = $2,
          meta = COALESCE(meta, '{}'::jsonb) || $3::jsonb WHERE id = $1`,
      [b.id, winner === 'left' ? 1 : winner === 'right' ? 2 : null,
       JSON.stringify({ summary })]);
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
         p.kills || 0, me.hp > 0 ? 0 : 1]);
      if (victory && reward) {
        await addCurrency(c, p.charId, CUR[reward.currency], reward.amount, 7,
          { idempotencyKey: randomUUID(), type: 1, id: b.id });
        await addExp(c, p.charId, reward.exp);
      }
      await c.query(`UPDATE characters SET hp_cur = $2, mp_cur = $3 WHERE id = $1`,
        [p.charId, me.maxHp, Math.round(me.mp || 0)]);
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
    if (lp) onHuntVictory(lp.charId, { npcId: b.npcId }, (text) =>
      lp.send({ type: 'chat', from: 'Система', text })).catch(console.error);
  }
}

async function abortBattle(b, reason) {
  dropLive(b);
  b.engine.phase = 'ended';
  const summary = buildSummary(b, b.engine.winner());
  await tx(async (c) => {
    await c.query(
      `UPDATE battles SET status = 4, ended_at = now(),
          meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [b.id, JSON.stringify({ summary })]);
    for (const p of b.players.values()) {
      await c.query(
        `UPDATE battle_participants SET status = 3, result = 4, left_round = $3
          WHERE battle_id = $1 AND character_id = $2`,
        [b.id, p.charId, b.engine.turn]);
      const af = b.engine.fighter(p.charId);
      await c.query(`UPDATE characters SET hp_cur = $2, mp_cur = $3 WHERE id = $1`,
        [p.charId, af.maxHp, Math.round(af.mp || 0)]);
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
  const f = b.engine.fighter(cid(charId));
  if (f) broadcastElixir(b, f, f, { kind: 'escape' });
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
    await c.query(`UPDATE characters SET hp_cur = $2, mp_cur = $3 WHERE id = $1`,
      [charId, f.maxHp, Math.round(f.mp || 0)]);
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

/** Недавно завершённые/прерванные бои локации (вкладка «Завершённые»). Состав
 *  команд берём из meta.summary (включает ИИ-шайку); старые бои без summary дают
 *  пустые составы — строка всё равно открывается в таблицу итогов. */
export async function finishedBattlesInLocation(locId, limit = 20) {
  const { rows } = await game.query(
    `SELECT id, type, status, winner_side, meta, ended_at
       FROM battles
      WHERE location_id = $1 AND status IN (3, 4)
      ORDER BY ended_at DESC NULLS LAST, id DESC
      LIMIT $2`, [locId, Math.max(1, Math.min(50, Number(limit) || 20))]);
  return rows.map((r) => {
    const meta = r.meta || {};
    const summary = Array.isArray(meta.summary) ? meta.summary : [];
    const names = (side) => summary.filter((s) => s.side === side).map((s) => s.name);
    return {
      battleId: Number(r.id),
      kind: meta.kind || (r.type === 1 ? 'hunt' : 'pvp'),
      status: r.status === 4 ? 'aborted' : 'finished',
      endedAt: r.ended_at,
      winnerSide: r.winner_side,
      teams: { left: names(1), right: names(2) },
    };
  });
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
            maxHp: f.maxHp, mp: f.charId ? Math.min(mp, f.maxMp || MAX_MP) : 0,
            maxMp: f.maxMp || MAX_MP, alive: f.alive });
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

    // exp/доблесть — только у игроков (battle_participants), берём по char id
    const partRows = (await game.query(
      `SELECT bp.character_id, bp.side, bp.result, bp.damage_dealt, bp.kills,
              bp.deaths, bp.exp_gained, bp.valor_gained, ch.name, ch.level
         FROM battle_participants bp JOIN characters ch ON ch.id = bp.character_id
        WHERE bp.battle_id = $1 ORDER BY bp.side, ch.name`, [id])).rows;

    let results;
    if (Array.isArray(meta.summary) && meta.summary.length) {
      // полный снимок (игроки + каждый боец шайки, #1.4); убийства у реальных убийц (#1.3)
      const byChar = new Map(partRows.map((r) => [String(r.character_id), r]));
      results = meta.summary.map((s) => {
        const pr = s.charId != null ? byChar.get(String(s.charId)) : null;
        return { side: s.side, name: s.name, level: s.level,
          damage: Number(s.damage) || 0, kills: Number(s.kills) || 0,
          deaths: Number(s.deaths) || 0,
          exp: pr ? Number(pr.exp_gained) : null,
          valor: pr ? Number(pr.valor_gained) : null,
          result: s.result ?? (pr ? pr.result : null), isAI: !!s.isAI };
      });
    } else {
      // старые бои без summary — прежний путь: игроки + одна строка-итог NPC
      results = partRows.map((p) => ({
        side: p.side, name: p.name, level: p.level,
        damage: Number(p.damage_dealt), kills: p.kills, deaths: p.deaths,
        exp: Number(p.exp_gained), valor: Number(p.valor_gained),
        result: p.result, isAI: false,
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
          deaths: Number(npc.deaths), exp: null, valor: null, result: null, isAI: true,
        });
      }
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
