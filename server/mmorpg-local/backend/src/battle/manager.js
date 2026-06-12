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

const publicSides = (e) => ({
  left:  { name: e.sides.left.name,  level: e.sides.left.level,
           hp: e.sides.left.hp,  maxHp: e.sides.left.maxHp },
  right: { name: e.sides.right.name, level: e.sides.right.level,
           hp: e.sides.right.hp, maxHp: e.sides.right.maxHp },
});

export async function startHunt(ch, send) {
  if (byChar.has(cid(ch.id))) throw Object.assign(new Error('already_in_battle'), { status: 409 });

  const npc = (await game.query(
    `SELECT t.id, t.name, t.level, t.stats FROM npc_spawns s
       JOIN npc_templates t ON t.id = s.npc_template_id
      WHERE s.location_id = $1 LIMIT 1`, [ch.location_id])).rows[0];
  if (!npc) throw Object.assign(new Error('no_hunt_here'), { status: 400 });

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
  }, { turnTime });

  const b = { id: battleId, engine, charId: cid(ch.id), send: send || noop,
    attached: true, timer: null, finishTimer: null, totalDamage: 0, turnEndsAt: 0 };
  live.set(battleId, b);
  byChar.set(cid(ch.id), battleId);
  await snapshot(battleId, b);
  console.log(`Бой ${battleId}: старт, char=${ch.id} (${ch.name})`);
  // объявление в чат локации; клиент делает «Бой #N» ссылкой на окно боя
  sendSystemChat(ch.location_id,
    `⚔ Бой #${battleId}: ${ch.name} против «${npc.name}» — начался!`)
    .catch(console.error);

  b.send({ type: 'battleStart', battleId, ...publicSides(engine) });
  beginTurn(b);
  return battleId;
}

/** Снимок идущего боя для battleResume / GET /api/battle/current. */
export function resumePayload(charId) {
  const battleId = byChar.get(cid(charId));
  if (!battleId) return null;
  const b = live.get(battleId);
  return {
    type: 'battleResume', battleId,
    sides: publicSides(b.engine),
    turn: b.engine.turn, phase: b.engine.phase,
    timeLeft: Math.max(0, Math.ceil((b.turnEndsAt - Date.now()) / 1000)),
    moveSubmitted: !!b.engine.moves.left,
  };
}

/** Реконнект: вернуть бой и заново привязать сокет. */
export function attach(charId, send) {
  const payload = resumePayload(charId);
  if (!payload) return null;
  const b = live.get(payload.battleId);
  b.send = send;
  b.attached = true;
  console.log(`Бой ${b.id}: реконнект char=${charId}, фаза=${b.engine.phase}`);
  // реконнект посреди фазы resolving: не ждать страховочные 20 секунд,
  // а быстро начать следующий ход
  if (b.engine.phase === 'resolving') {
    clearTimeout(b.finishTimer);
    b.finishTimer = setTimeout(() => finishTurn(charId), 1500);
  }
  return payload;
}

export function detach(charId) {
  const battleId = byChar.get(cid(charId));
  if (battleId) {
    const b = live.get(battleId);
    b.send = noop;        // бой живёт дальше без зрителя
    b.attached = false;
    console.log(`Бой ${battleId}: зритель отключился (char=${charId}), бой продолжается`);
  }
}

function beginTurn(b) {
  const t = b.engine.startTurn();
  b.turnEndsAt = Date.now() + b.engine.turnTime * 1000;
  b.send({ type: 'turnStart', ...t });
  let left = b.engine.turnTime;

  setTimeout(() => {
    if (b.engine.phase === 'choose' && !b.engine.moves.right) {
      b.engine.submit('right', b.engine.randomMove());
      maybeResolve(b);
    }
  }, 400 + Math.random() * 900);

  b.timer = setInterval(() => {
    left -= 1;
    b.send({ type: 'timer', timeLeft: left });
    if (left <= 0) {
      b.engine.fillTimeouts();   // оффлайн-игрок просто пропускает удар
      maybeResolve(b);
    }
  }, 1000);
}

export function submitMove(charId, move) {
  const b = live.get(byChar.get(cid(charId)));
  if (!b) return false;
  const ok = b.engine.submit('left', {
    attack: move.attack, block: move.block ?? null, pass: !!move.pass });
  if (ok) maybeResolve(b);
  return ok;
}

async function maybeResolve(b) {
  if (!b.engine.ready || b.engine.phase !== 'choose') return;
  clearInterval(b.timer);
  const r = b.engine.resolve();
  for (const s of r.strikes) {
    s.actorId  = s.attacker === 'left' ? b.charId : null;
    s.targetId = s.defender === 'left' ? b.charId : null;
  }
  b.totalDamage += r.strikes
    .filter((s) => s.attacker === 'left' && !s.dodged)
    .reduce((a, s) => a + s.damage, 0);
  await snapshot(b.id, b);
  logRounds(b.id, r.turn, r.strikes).catch(console.error);
  b.send({ type: 'resolve', ...r, sides: publicSides(b.engine) });
  // клиент проигрывает анимации и шлёт turnDone; страховка — авто.
  // Если игрок отключён, ждать некого: заочный бой идёт в полном темпе.
  b.finishTimer = setTimeout(() => finishTurn(b.charId), b.attached ? 20000 : 1500);
}

export async function finishTurn(charId) {
  const b = live.get(byChar.get(cid(charId)));
  if (!b || b.engine.phase !== 'resolving') return;
  clearTimeout(b.finishTimer);
  if (b.engine.finished()) return endBattle(b);
  beginTurn(b);
}

function dropLive(b) {
  clearInterval(b.timer); clearTimeout(b.finishTimer);
  live.delete(b.id); byChar.delete(b.charId);
}

async function endBattle(b) {
  dropLive(b);
  const winner = b.engine.winner();
  const victory = winner === 'left';
  const me = b.engine.sides.left;
  const reward = await gameConfig('battle.reward.hunt');

  await tx(async (c) => {
    await c.query(
      `UPDATE battles SET status = 3, ended_at = now(), winner_side = $2 WHERE id = $1`,
      [b.id, winner === 'left' ? 1 : winner === 'right' ? 2 : null]);
    await c.query(
      `UPDATE battle_participants SET status = $3, result = $4, left_round = $5,
          damage_dealt = $6, exp_gained = $7, kills = $8, deaths = $9
        WHERE battle_id = $1 AND character_id = $2`,
      [b.id, b.charId, me.hp > 0 ? 1 : 2, victory ? 1 : 2, b.engine.turn,
       b.totalDamage, victory ? reward.exp : 0,
       victory ? 1 : 0, me.hp > 0 ? 0 : 1]);
    if (victory) {
      await addCurrency(c, b.charId, CUR[reward.currency], reward.amount, 7,
        { idempotencyKey: randomUUID(), type: 1, id: b.id });
      await addExp(c, b.charId, reward.exp);
    }
    await c.query(`UPDATE characters SET hp_cur = $2 WHERE id = $1`,
      [b.charId, me.maxHp]);
  });
  await redis.del(snapKey(b.id));
  b.send({ type: 'battleEnd', winner, victory,
    sides: publicSides(b.engine), reward: victory ? reward : null });

  if (victory) {
    onHuntVictory(b.charId, (text) =>
      b.send({ type: 'chat', from: 'Система', text })).catch(console.error);
  }
}

async function abortBattle(b, reason) {
  dropLive(b);
  await tx(async (c) => {
    await c.query(
      `UPDATE battles SET status = 4, ended_at = now() WHERE id = $1`, [b.id]);
    await c.query(
      `UPDATE battle_participants SET status = 3, result = 4, left_round = $3
        WHERE battle_id = $1 AND character_id = $2`,
      [b.id, b.charId, b.engine.turn]);
    await c.query(`UPDATE characters SET hp_cur = $2 WHERE id = $1`,
      [b.charId, b.engine.sides.left.maxHp]);
  });
  await redis.del(snapKey(b.id));
  b.send({ type: 'battleEnd', winner: null, victory: false, aborted: true,
    reason, sides: publicSides(b.engine) });
}

/** Эликсир побега: расход предмета и прерывание боя — одно целое. */
export async function escapeBattle(charId) {
  const b = live.get(byChar.get(cid(charId)));
  if (!b) throw Object.assign(new Error('no_battle'), { status: 400 });
  const tplId = Number(await gameConfig('battle.escape_elixir')) || 201;

  await tx(async (c) => {
    const it = (await c.query(
      `SELECT * FROM item_instances
        WHERE owner_type = 1 AND owner_id = $1 AND template_id = $2 AND status = 1
        ORDER BY id LIMIT 1 FOR UPDATE`, [charId, tplId])).rows[0];
    if (!it) throw Object.assign(new Error('no_escape_elixir'), { status: 400 });
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
  await abortBattle(b, 'escape');
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
    throw Object.assign(new Error('cannot_leave'), { status: 403 });
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
    if (!battle) throw Object.assign(new Error('not_found'), { status: 404 });
    const meta = battle.meta || {};

    const b = live.get(id);
    if (b) {
      const mp = (await game.query(
        `SELECT mp_cur FROM characters WHERE id = $1`, [b.charId])).rows[0];
      const member = (s, extra) => ({ name: s.name, level: s.level,
        hp: Math.round(s.hp), maxHp: s.maxHp, ...extra });
      return res.json({
        battleId: id, status: 'active', turn: b.engine.turn,
        teams: {
          left:  [member(b.engine.sides.left,  { mp: mp ? mp.mp_cur : 0, maxMp: 100 })],
          right: [member(b.engine.sides.right, { mp: 0, maxMp: 100 })],
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
