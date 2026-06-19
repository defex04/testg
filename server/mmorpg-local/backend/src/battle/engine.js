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
 *  - «пары» (кто против кого) сватаются ОДИН раз за раунд (buildPairs) и держатся
 *    весь раунд: удар бойца всегда приходит его паре — «пока соперник не ответит,
 *    ничего не переключается». Между раундами сервер решает: пара продолжает или
 *    меняется (стабильность против простаивания);
 *  - удар активного бойца разыгрывается сразу (sub-turn), затем ход переходит
 *    следующему по инициативе.
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
      opponentId: null,                  // «пара» на раунд (цель удара/фокус), см. buildPairs
      lastActiveTurn: 0,                 // раунд последнего размена — для «холода»
      buffMult: 1,                       // множитель урона от «Эликсира мощи»
      buffTurns: 0,                      // на сколько своих ударов он действует
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

  /** Новый раунд: сбрасываем «походивших», порядок инициативы НЕ перевыбираем,
   *  и ОДИН раз сватаем пары «кто против кого» на весь раунд (buildPairs). */
  startRound() {
    this.turn += 1;
    this.phase = 'choose';
    this.acted = new Set();
    this.idx = -1;
    this.buildPairs();
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

  /**
   * Сватовство пар «кто против кого» — ОДИН раз за раунд (см. startRound).
   * Закрепляет `opponentId` каждому живому бойцу на весь раунд → «пока соперник
   * не ответит, ничего не переключается». Решает СЕРВЕР, по трём правилам:
   *  1) стабильность: валидную взаимную пару с вероятностью (1−switchChance)
   *     сохраняем (реже переключения); «холодную» пару (давно без размена) —
   *     обязательно пере-сватываем;
   *  2) меньше простаивания: свободных бойцов (в порядке инициативы) ведём к
   *     наименее занятому и самому «холодному» врагу (вес `_targetWeight`/нагрузка);
   *  3) неравные команды: лишние бойцы «дублируются» на врага (2-в-1) — никто не
   *     стоит без дела; у врага opponentId = один из его атакующих (ответный удар).
   */
  buildPairs() {
    const left = this.aliveOf('left'), right = this.aliveOf('right');
    if (!left.length || !right.length) return;
    const engaged = new Set();
    const load = new Map();                       // enemyId -> сколько атакующих на нём
    const bump = (id) => load.set(String(id), (load.get(String(id)) || 0) + 1);

    // 1) сохраняем устойчивые взаимные пары (если не «холодные» и не выпал шанс смены)
    for (const f of [...left, ...right]) {
      if (engaged.has(f.id)) continue;
      const p = f.opponentId ? this.fighter(f.opponentId) : null;
      const mutual = p && p.alive && p.side !== f.side
        && String(p.opponentId) === String(f.id) && !engaged.has(p.id);
      if (!mutual) continue;
      const cold = this.coldness(f) >= this.target.coldTurns
        || this.coldness(p) >= this.target.coldTurns;
      if (cold || Math.random() < this.target.switchChance) continue;   // разъединяем
      engaged.add(f.id); engaged.add(p.id); bump(f.id); bump(p.id);
    }

    // 2) свободных (по инициативе) сватаем к наименее занятому/«холодному» врагу;
    //    взаимность ставим, если враг ещё свободен — иначе это «дубль» (2-в-1)
    for (const id of this.order) {
      const f = this.fighter(id);
      if (!f || !f.alive || engaged.has(f.id)) continue;
      const enemies = this.enemiesOf(f.id);
      if (!enemies.length) continue;
      let best = null, bestW = -Infinity;
      for (const e of enemies) {
        const w = this._targetWeight(e) / (1 + (load.get(String(e.id)) || 0));
        if (w > bestW) { bestW = w; best = e; }
      }
      f.opponentId = best.id; engaged.add(f.id); bump(best.id);
      if (!engaged.has(best.id)) { best.opponentId = f.id; engaged.add(best.id); bump(f.id); }
    }
  }

  /**
   * Стабильный соперник «напротив» для живого игрока: пока текущий жив — он и
   * остаётся (никакого случайного переключения), иначе детерминированно берём
   * первого живого врага в порядке инициативы (тот же, что вернёт enemiesOf[0],
   * — поэтому показанный фокус и реальная цель удара всегда совпадают).
   * Возвращает закреплённого живого врага (или null, если врагов не осталось).
   */
  ensureOpponent(actorId) {
    const f = this.fighter(actorId);
    if (!f) return null;
    const cur = f.opponentId ? this.fighter(f.opponentId) : null;
    if (cur && cur.alive && cur.side !== f.side) return cur;   // держим стабильно
    const pick = this.enemiesOf(actorId)[0] || null;
    f.opponentId = pick ? pick.id : null;
    return pick;
  }

  /** Текущий соперник без пере-выбора (для фокуса зрителя). */
  opponentOf(actorId) {
    const f = this.fighter(actorId);
    const cur = f && f.opponentId ? this.fighter(f.opponentId) : null;
    return cur && cur.alive && cur.side !== f.side ? cur : null;
  }

  aiMove() {
    // цель ИИ — его «пара» на этот раунд (см. submit/ensureOpponent), поэтому
    // здесь только зоны удара/блока
    return { attack: ZONES[(Math.random() * 3) | 0], block: ZONES[(Math.random() * 3) | 0] };
  }

  /**
   * Выбор хода активного бойца. move: { attack, block, pass }.
   * Цель ближнего удара НЕ из move — это всегда «пара» бойца (кто стоит
   * напротив, задано buildPairs на раунд). move.target для удара игнорируется
   * (выбор в ростере — только для эликсиров/эффектов, не для удара).
   */
  submit(actorId, move) {
    if (this.phase !== 'choose') return false;
    const f = this.fighter(actorId);
    if (!f || !this._isActiveActor(f) || this.currentActorId() !== f.id) return false;
    if (move.block != null && !ZONES.includes(move.block)) return false;
    let target = null;
    if (!move.pass) {
      if (!ZONES.includes(move.attack)) return false;
      // бьём «пару»; если она погибла раньше в этом раунде — ensureOpponent
      // добивает следующего живого врага, чтобы ход не простаивал
      target = this.ensureOpponent(f.id);
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
      // «Эликсир мощи»: усиливает удары N раз; заряд тратится на удар
      if (attacker.buffTurns > 0) { damage *= attacker.buffMult; attacker.buffTurns -= 1; }
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

  /** Лечение бойца (Эликсир здоровья). Возвращает фактически восстановленное HP. */
  heal(id, amount) {
    const f = this.fighter(id);
    if (!f || !f.alive) return 0;
    const before = f.hp;
    f.hp = Math.min(f.maxHp, f.hp + Math.max(0, Math.round(amount)));
    return f.hp - before;
  }

  /** Наложить усиление урона (Эликсир мощи) на N своих ударов. */
  addBuff(id, mult, turns) {
    const f = this.fighter(id);
    if (!f || !f.alive) return false;
    f.buffMult = mult;
    f.buffTurns = Math.max(0, Math.round(turns));
    return true;
  }

  finished() { return !this.aliveOf('left').length || !this.aliveOf('right').length; }
  winner()   { return this.aliveOf('left').length ? 'left'
                   : this.aliveOf('right').length ? 'right' : null; }
}
