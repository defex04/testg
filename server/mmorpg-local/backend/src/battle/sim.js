/**
 * Headless-симулятор боёв для админки: гоняет НАСТОЯЩИЙ движок (engine.js) с
 * боевой моделью Broken Sun (stats.js) — без таймеров, Redis и БД. Нужен, чтобы:
 *  1) замерить нагрузку движка (wall/CPU-время, бои/с, удары/с, память);
 *  2) тестировать баланс статов/формул (винрейт, криты/увороты/блоки/контры, ср. урон);
 *  3) для ≤4 боёв записать таймлайн ударов — клиент проигрывает его «анимацией».
 *
 * Бойцы синтетические: профиль команды задаёт характеристики (Мощь/Защита/…),
 * уровень растит непроцентные статы, разброс % даёт бойцов с разными значениями.
 * Эликсиры мощи/здоровья моделируются как у ИИ (запас зарядов + порог здоровья).
 */
import { Engine } from './engine.js';
import { STAT_META, STAT_DEFAULTS, makeModel, levelFactor } from './stats.js';

const clampNum = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const jitter = (pct) => 1 + (Math.random() * 2 - 1) * pct;

const MAX_SIDE = 500;
const MAX_BATTLES = 2000;
const MAX_REC_BATTLES = 4;
const MAX_REC_EVENTS = 6000;
const WALL_BUDGET_MS = 25000;
const YIELD_EVERY = 25000;

/** Профиль команды → массив дефов бойцов (статы + эликсиры; у каждого свой разброс). */
function buildTeam(side, p, model) {
  const n = clampNum(p.count, 1, MAX_SIDE, 1);
  const level = clampNum(p.level, 1, 1000, 1);
  const varPct = clampNum(p.varPct, 0, 1, 0.15);
  const lf = levelFactor(level, model.coef.levelGrowth);
  const prefix = String(p.name || (side === 'left' ? 'Альфа' : 'Бета')).slice(0, 24);
  const elx = p.elixir || {};
  const ePowerUses = clampNum(elx.powerUses, 0, 99, 0);
  const ePowerMult = clampNum(elx.powerMult, 1, 3, 1.5);
  const ePowerTurns = clampNum(elx.powerTurns, 1, 10, 3);
  const eHealUses = clampNum(elx.healUses, 0, 99, 0);
  const eHealPct = clampNum(elx.healPct, 0, 100, 30);
  const eHealAt = clampNum(elx.healAtPct, 0, 100, 60) / 100;
  const st = p.stats || p;   // статы можно прислать вложенно (stats) или плоско

  const out = [];
  for (let i = 0; i < n; i++) {
    const stats = {};
    for (const m of STAT_META) {
      const base = num(st[m.key], STAT_DEFAULTS[m.key]);
      const v = base * (m.pct ? 1 : lf) * jitter(varPct);
      stats[m.key] = m.pct ? +v.toFixed(2) : Math.max(1, Math.round(v));
    }
    const hp = stats.health;
    out.push({
      id: `${side[0]}${i + 1}`, name: `${prefix} ${i + 1}`, level, isAI: true,
      stats, hp, damage: [1, 1],                 // legacy-поля не нужны в модельном бою
      initiative: stats.initiative + Math.random(),
      aiPowerUses: ePowerUses, aiPowerMult: ePowerMult, aiPowerTurns: ePowerTurns,
      aiHealUses: eHealUses, aiHealAmount: Math.round(hp * eHealPct / 100), aiHealAt: eHealAt,
    });
  }
  return out;
}

const sideAcc = () => ({ attacks: 0, hits: 0, crits: 0, blocked: 0, dodgedAgainst: 0,
  counters: 0, kills: 0, damage: 0, elixPower: 0, elixHeal: 0, elixHealAmt: 0 });

/** Эликсиры активного бойца (как ИИ): мощь — если буффа нет; лечение — по порогу HP. */
function applyElixirs(engine, af, acc) {
  if (!af || !af.alive) return;
  const a = acc[af.side];
  if ((af.aiPowerUses || 0) > 0 && af.buffTurns <= 0) {
    af.aiPowerUses -= 1;
    engine.addBuff(af.id, af.aiPowerMult, af.aiPowerTurns);
    a.elixPower++;
  }
  if ((af.aiHealUses || 0) > 0 && af.hp <= af.maxHp * (af.aiHealAt || 0.6)) {
    af.aiHealUses -= 1;
    a.elixHealAmt += engine.heal(af.id, af.aiHealAmount || 0);
    a.elixHeal++;
  }
}

/** Один бой до конца (или до maxTurns). Обновляет acc; если rec — пишет таймлайн. */
function runOneBattle(left, right, opts, model, acc, rec) {
  const engine = new Engine({ left, right }, { turnTime: opts.turnTime, target: opts.target, model });
  const maxTurns = opts.maxTurns;
  let subTurns = 0;

  if (rec) {
    const pub = (f) => ({ id: f.id, name: f.name, level: f.level, maxHp: f.maxHp });
    rec.fighters = { left: left.map((d) => pub(engine.fighter(d.id))),
                     right: right.map((d) => pub(engine.fighter(d.id))) };
    rec.events = [];
  }

  let actor = engine.startRound();
  let guard = 0;
  const guardMax = 20_000_000;
  while (actor && engine.turn <= maxTurns && !engine.finished()) {
    const af = engine.currentActor();
    if (af) {
      applyElixirs(engine, af, acc);                 // эликсиры перед своим ходом
      engine.submit(af.id, engine.aiMove());
      const r = engine.resolveActive();
      for (const s of r.strikes) {
        subTurns++;
        const a = acc[s.attackerSide];
        a.attacks++;
        if (s.dodged) a.dodgedAgainst++;
        else { a.hits++; a.damage += s.damage; if (s.crit) a.crits++; if (s.blocked) a.blocked++; }
        if (s.counter) a.counters++;
        if (s.killed) a.kills++;
        if (rec && rec.events.length < MAX_REC_EVENTS) {
          rec.events.push({ t: r.turn, a: s.attackerId, d: s.defenderId, side: s.attackerSide,
            zone: s.zone, blocked: s.blocked, dodged: s.dodged, crit: s.crit,
            counter: !!s.counter, dmg: s.damage, hp: Math.round(s.defenderHp), killed: !!s.killed });
        }
      }
    }
    let next = engine.advance();
    if (!next) { if (engine.finished()) break; next = engine.startRound(); }
    actor = next;
    if (++guard > guardMax) break;
  }
  engine.phase = 'ended';

  const lAlive = engine.aliveOf('left').length, rAlive = engine.aliveOf('right').length;
  const winner = lAlive && !rAlive ? 'left' : rAlive && !lAlive ? 'right' : null;
  acc.subTurns += subTurns;
  if (rec) { rec.winner = winner; rec.turns = engine.turn; rec.truncated = rec.events.length >= MAX_REC_EVENTS; }
  return { winner, timedOut: engine.turn > maxTurns, turns: engine.turn };
}

/** Свод по стороне: проценты исходов + средние. */
function sideReport(a, battles) {
  const r2 = (x) => +x.toFixed(1);
  return {
    attacks: a.attacks, hits: a.hits, crits: a.crits, blocked: a.blocked,
    dodgedAgainst: a.dodgedAgainst, counters: a.counters, kills: a.kills,
    critRate: r2(a.hits ? a.crits / a.hits * 100 : 0),
    dodgeRate: r2(a.attacks ? a.dodgedAgainst / a.attacks * 100 : 0),
    blockRate: r2(a.hits ? a.blocked / a.hits * 100 : 0),
    counterRate: r2(a.attacks ? a.counters / a.attacks * 100 : 0),
    avgDamagePerHit: Math.round(a.hits ? a.damage / a.hits : 0),
    avgDamagePerBattle: Math.round(battles ? a.damage / battles : 0),
    avgKillsPerBattle: r2(battles ? a.kills / battles : 0),
    elixPower: a.elixPower, elixHeal: a.elixHeal, elixHealAmt: a.elixHealAmt,
  };
}

/** Прогон серии боёв по профилям. opts из тела запроса. */
export async function runSimulation(body = {}) {
  const record = !!body.animate;
  let battles = clampNum(body.battles, 1, record ? MAX_REC_BATTLES : MAX_BATTLES, 100);
  if (record) battles = Math.min(battles, MAX_REC_BATTLES);
  const model = makeModel(body.coef || {});
  const opts = {
    maxTurns: clampNum(body.maxTurns, 1, 1000, 200),
    turnTime: clampNum(body.turnTime, 1, 600, 20),
    target: {
      switchChance: clampNum(body.switchChance, 0, 1, 0.25),
      coldTurns: clampNum(body.coldTurns, 0, 50, 2),
      coldWeight: clampNum(body.coldWeight, 0, 50, 1.5),
    },
  };
  const leftP = body.left || {}, rightP = body.right || {};

  const acc = { battles: 0, winsLeft: 0, winsRight: 0, draws: 0, timedOut: 0, turns: 0,
    subTurns: 0, left: sideAcc(), right: sideAcc() };
  const timelines = [];

  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const wallStart = process.hrtime.bigint();
  let partial = false, since = 0;

  for (let i = 0; i < battles; i++) {
    const left = buildTeam('left', leftP, model);
    const right = buildTeam('right', rightP, model);
    const rec = record ? { battle: i + 1 } : null;
    const r = runOneBattle(left, right, opts, model, acc, rec);

    acc.battles++;
    if (r.winner === 'left') acc.winsLeft++;
    else if (r.winner === 'right') acc.winsRight++;
    else acc.draws++;
    if (r.timedOut) acc.timedOut++;
    acc.turns += r.turns;
    if (rec) timelines.push(rec);

    // уступаем событийному циклу пачками ударов — чтобы не подвешивать сервер
    if (acc.subTurns - since >= YIELD_EVERY) { since = acc.subTurns; await new Promise((res) => setImmediate(res)); }
    if (Number(process.hrtime.bigint() - wallStart) / 1e6 > WALL_BUDGET_MS) { partial = true; break; }
  }

  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  const cpu = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();
  const n = acc.battles || 1;
  const dmgLeft = acc.left.damage, dmgRight = acc.right.damage;

  return {
    params: { battles: acc.battles, maxTurns: opts.maxTurns, record,
      left: { count: clampNum(leftP.count, 1, MAX_SIDE, 1) },
      right: { count: clampNum(rightP.count, 1, MAX_SIDE, 1) },
      coef: model.coef },
    partial,
    perf: {
      wallMs: +wallMs.toFixed(1),
      cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(1),
      perBattleMs: +(wallMs / n).toFixed(3),
      battlesPerSec: Math.round(n / (wallMs / 1000 || 1)),
      strikesPerSec: Math.round(acc.subTurns / (wallMs / 1000 || 1)),
      heapUsedDeltaMb: +((memAfter.heapUsed - memBefore.heapUsed) / 1048576).toFixed(2),
      rssMb: +(memAfter.rss / 1048576).toFixed(1),
    },
    balance: {
      winsLeft: acc.winsLeft, winsRight: acc.winsRight, draws: acc.draws,
      winRateLeft: +(acc.winsLeft / n * 100).toFixed(1),
      winRateRight: +(acc.winsRight / n * 100).toFixed(1),
      timedOut: acc.timedOut,
      avgTurns: +(acc.turns / n).toFixed(1),
      avgSubTurns: +(acc.subTurns / n).toFixed(1),
      avgDmgLeft: Math.round(dmgLeft / n),
      avgDmgRight: Math.round(dmgRight / n),
      totalStrikes: acc.subTurns,
    },
    combat: { left: sideReport(acc.left, n), right: sideReport(acc.right, n) },
    timelines,
  };
}
