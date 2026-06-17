/**
 * Серверный движок боя — командный NvN. Формулы и семантика 1:1 с прежней
 * версией: 3 зоны удара × 3 блока, blocked ×0.12, crit ×1.8, crit+block ×0.85,
 * dodge. Бой 1×1 (охота, дуэль) — частный случай команд из одного бойца.
 *
 * Модель хода:
 *  - стороны left/right — массивы бойцов;
 *  - раунд: каждый живой боец действует один раз в порядке инициативы (по убыванию);
 *  - порядок инициативы считается ОДИН РАЗ со стабильным тай-брейком и
 *    переиспользуется каждый раунд → строго чередование, без ударов подряд
 *    одним бойцом (это и был баг «ходит дважды» при равной инициативе);
 *  - удар активного бойца разыгрывается сразу (sub-turn), затем ход переходит
 *    следующему по инициативе — отсюда естественное «переключение» соперника.
 */
export const ZONES = ['high', 'mid', 'low'];
const rnd = (min, max) => min + Math.random() * (max - min);

export class Engine {
  /**
   * sides: { left: [def...], right: [def...] }
   * def: { id?, name, level, hp, damage:[min,max], crit?, dodge?, initiative?, isAI?, charId? }
   */
  constructor(sides, { turnTime = 20, target = {} } = {}) {
    this.turnTime = turnTime;
    // выбор цели: соперник «липкий» (держится несколько ходов), меняется
    // принудительно (умер), с вероятностью switchChance или если боец «холодный»
    // (давно не дрался). Новый соперник выбирается взвешенно, с приоритетом
    // «холодным» врагам — простаивающих втягиваем в бой. См. README/plan.
    this.target = {
      switchChance: target.switchChance ?? 0.25,
      coldTurns: target.coldTurns ?? 2,
      coldWeight: target.coldWeight ?? 1.5,
    };
    this.fighters = new Map();           // id -> боец
    this.teams = { left: [], right: [] };
    this._seq = 0;
    for (const side of ['left', 'right']) {
      for (const def of sides[side] || []) this._add(side, def);
    }
    this.turn = 0;
    this.phase = 'idle';                  // idle | choose | resolving | ended
    this.order = [];                     // id в порядке инициативы (фиксирован)
    this.idx = -1;                       // позиция текущего бойца в order
    this.acted = new Set();              // кто уже походил в этом раунде
    this._pending = null;                // выбранный, но ещё не разыгранный ход
    this._buildOrder();
  }

  _add(side, def) {
    const id = def.id != null ? String(def.id) : `ai${++this._seq}`;
    const hp = def.hp;
    const f = {
      id, side,
      name: def.name, level: def.level ?? 1,
      charId: def.charId ?? null,
      isAI: !!def.isAI,
      maxHp: hp, hp,
      damage: def.damage,
      crit: def.crit ?? 0.1,
      dodge: def.dodge ?? 0.06,
      initiative: Number(def.initiative ?? def.level ?? 0),
      // тай-брейк фиксируется при создании: при равной инициативе порядок
      // постоянен между раундами, поэтому никто не бьёт дважды подряд
      tiebreak: Math.random(),
      alive: hp > 0,
      block: null,                       // стойка; null в ходе снимает блок
      opponentId: null,                  // «липкий» соперник (цель/фокус)
      lastActiveTurn: 0,                 // раунд последнего размена — для «холода»
    };
    this.fighters.set(id, f);
    this.teams[side].push(id);
    return f;
  }

  _buildOrder() {
    // инициатива по убыванию; при равной — игроки раньше ИИ (приоритет живых),
    // затем фиксированный тай-брейк (постоянный между раундами → нет ударов подряд)
    this.order = [...this.fighters.values()]
      .sort((a, b) => (b.initiative - a.initiative)
        || ((a.isAI ? 1 : 0) - (b.isAI ? 1 : 0))
        || (a.tiebreak - b.tiebreak))
      .map((f) => f.id);
  }

  fighter(id)   { return this.fighters.get(String(id)); }
  enemySide(s)  { return s === 'left' ? 'right' : 'left'; }
  aliveOf(side) { return this.teams[side].map((id) => this.fighters.get(id)).filter((f) => f.alive); }
  enemiesOf(id) {
    const f = this.fighter(id);
    return f ? this.aliveOf(this.enemySide(f.side)) : [];
  }

  /** Горячий вход в идущий бой (вмешательство): боец вступает со следующего раунда. */
  addFighter(side, def) {
    const curId = this.currentActorId();
    const f = this._add(side, def);
    this._buildOrder();
    if (this.phase !== 'idle') this.acted.add(f.id);
    // пересборка order не должна сменить активного бойца на другого
    if (curId) {
      const ni = this.order.indexOf(curId);
      if (ni >= 0) this.idx = ni;
    }
    return f;
  }

  /** Новый раунд: сбрасываем «походивших», порядок инициативы НЕ перевыбираем. */
  startRound() {
    this.turn += 1;
    this.phase = 'choose';
    this.acted = new Set();
    this.idx = -1;
    return this._nextActor();
  }

  _nextActor() {
    for (let i = this.idx + 1; i < this.order.length; i++) {
      const f = this.fighters.get(this.order[i]);
      if (f.alive && !this.acted.has(f.id) && this.enemiesOf(f.id).length) {
        this.idx = i;
        this.phase = 'choose';
        return { turn: this.turn, timeLeft: this.turnTime, active: f.id };
      }
    }
    this.idx = this.order.length;
    return null;   // раунд окончен
  }

  /** Следующий sub-turn в текущем раунде (null → раунд окончен). */
  advance() { return this._nextActor(); }

  currentActorId() {
    const id = this.order[this.idx];
    return id != null && this.idx < this.order.length ? id : null;
  }
  /** Активный боец sub-turn'а: жив, ещё не ходил в раунде, есть враги. */
  _isActiveActor(f) {
    return !!(f && f.alive && !this.acted.has(f.id) && this.enemiesOf(f.id).length);
  }
  currentActor() {
    const f = this.fighter(this.currentActorId());
    return this._isActiveActor(f) ? f : null;
  }

  /** Насколько боец «холодный» (раундов без размена). */
  coldness(f) { return Math.max(0, this.turn - (f.lastActiveTurn || 0)); }

  /** Вес выбора цели: база + приоритет «холодным» (на кого давно не нападали). */
  _targetWeight(enemy) { return 1 + this.target.coldWeight * this.coldness(enemy); }

  _weightedPick(list) {
    if (list.length <= 1) return list[0] || null;
    const w = list.map((e) => this._targetWeight(e));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i]; }
    return list[list.length - 1];
  }

  /**
   * Закрепить/обновить соперника бойца (липкий фокус + вероятностное
   * переключение + «холод»). Возвращает выбранного живого врага.
   */
  chooseOpponent(actorId) {
    const f = this.fighter(actorId);
    if (!f) return null;
    const enemies = this.enemiesOf(actorId);
    if (!enemies.length) { f.opponentId = null; return null; }
    const cur = f.opponentId ? this.fighter(f.opponentId) : null;
    const valid = cur && cur.alive && cur.side !== f.side;
    const selfCold = this.coldness(f) >= this.target.coldTurns;
    const wantSwitch = !valid || selfCold || Math.random() < this.target.switchChance;
    const pick = wantSwitch ? this._weightedPick(enemies) : cur;
    f.opponentId = pick ? pick.id : null;
    return pick;
  }

  /** Текущий соперник без пере-выбора (для фокуса зрителя). */
  opponentOf(actorId) {
    const f = this.fighter(actorId);
    const cur = f && f.opponentId ? this.fighter(f.opponentId) : null;
    return cur && cur.alive && cur.side !== f.side ? cur : null;
  }

  aiMove(actorId) {
    const t = this.chooseOpponent(actorId);
    return { attack: ZONES[(Math.random() * 3) | 0], block: ZONES[(Math.random() * 3) | 0],
             target: t ? t.id : null };
  }

  /** Выбор хода активного бойца. move: { attack, block, target, pass }. */
  submit(actorId, move) {
    if (this.phase !== 'choose') return false;
    const f = this.fighter(actorId);
    if (!f || !this._isActiveActor(f) || this.currentActorId() !== f.id) return false;
    if (move.block != null && !ZONES.includes(move.block)) return false;
    let target = null;
    if (!move.pass) {
      if (!ZONES.includes(move.attack)) return false;
      target = this.fighter(move.target);
      if (target && target.alive && target.side !== f.side) {
        f.opponentId = target.id;          // явный выбор закрепляем как соперника
      } else {
        // нет/павшая/своя цель — берём уже закреплённого, иначе выбираем нового
        target = this.opponentOf(f.id) || this.chooseOpponent(f.id);
      }
      if (!target) return false;
    }
    f.block = move.block ?? null;
    this._pending = { actorId: f.id, targetId: target ? target.id : null,
                      attack: move.attack, pass: !!move.pass };
    return true;
  }

  _strike(attacker, defender, zone) {
    // размен «согревает» обоих: учитывается «холод» при выборе целей
    attacker.lastActiveTurn = this.turn;
    defender.lastActiveTurn = this.turn;
    const blocked = defender.block === zone;
    const dodged = !blocked && Math.random() < defender.dodge;
    const crit = !dodged && Math.random() < attacker.crit;
    let damage = 0;
    if (!dodged) {
      damage = rnd(attacker.damage[0], attacker.damage[1]);
      if (crit && blocked) damage *= 0.85;
      else if (crit) damage *= 1.8;
      else if (blocked) damage *= 0.12;
      damage = Math.max(1, Math.round(damage));
      defender.hp = Math.max(0, defender.hp - damage);
      if (defender.hp <= 0) defender.alive = false;
    }
    return {
      attackerId: attacker.id, defenderId: defender.id,
      attackerSide: attacker.side, defenderSide: defender.side,
      zone, blocked, dodged, crit, damage,
      defenderHp: defender.hp, killed: !defender.alive,
    };
  }

  /** Разыграть удар активного бойца (один sub-turn). */
  resolveActive() {
    this.phase = 'resolving';
    const p = this._pending; this._pending = null;
    const strikes = [], passed = [];
    if (!p) return { turn: this.turn, strikes, passed };
    const actor = this.fighter(p.actorId);
    this.acted.add(actor.id);
    if (p.pass || !p.targetId) {
      passed.push(actor.id);
    } else {
      const target = this.fighter(p.targetId);
      if (actor.alive && target && target.alive) strikes.push(this._strike(actor, target, p.attack));
    }
    return { turn: this.turn, strikes, passed };
  }

  finished() { return !this.aliveOf('left').length || !this.aliveOf('right').length; }
  winner()   { return this.aliveOf('left').length ? 'left'
                   : this.aliveOf('right').length ? 'right' : null; }
}
