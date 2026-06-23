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
  constructor(sides, { turnTime = 20, target = {}, model = null } = {}) {
    this.turnTime = turnTime;
    // Боевая модель статов (Broken Sun) — опционально. Если задана и у бойцов есть
    // блок stats, удар считается по производным формулам (Мощь/Защита/Точность/…)
    // и включается контратака. Без модели — прежняя логика (зоны/блок ×0.12/крит ×1.8),
    // поэтому ЖИВОЙ бой не меняется. Модель использует симулятор.
    this.model = model;
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
      stats: def.stats || null,          // блок статов Broken Sun (для модельного боя)
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
      lastTargetedTurn: 0,               // раунд, когда по бойцу БИЛИ — для «холода» цели
      buffMult: 1,                       // множитель урона от «Эликсира мощи»
      buffTurns: 0,                      // на сколько своих ударов он действует
      critBuffAdd: 0,                    // прибавка к шансу крита («Эликсир крови»)
      critBuffTurns: 0,                  // на сколько своих ходов она действует
      mp: Number(def.mp ?? 0),           // мана (для «Эликсира маны»; на бой пока не влияет)
      maxMp: Number(def.maxMp ?? 0),
      effects: [],                       // эффекты по времени: HoT/DoT/мана (см. addOverTime)
      cooldowns: {},                     // тайм-ауты свитков по виду (wall-clock ms)
      aiHealUses: Number(def.aiHealUses ?? 0),
      aiPowerUses: Number(def.aiPowerUses ?? 0),
      aiHealAmount: Number(def.aiHealAmount ?? 0),
      aiHealAt: Number(def.aiHealAt ?? 0.6),
      aiPowerMult: Number(def.aiPowerMult ?? 1.5),
      aiPowerTurns: Number(def.aiPowerTurns ?? 3),
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

  /** Насколько боец «холодный» (раундов без удара ПО НЕМУ). */
  coldness(f) { return Math.max(0, this.turn - (f.lastTargetedTurn || 0)); }

  /** Вес выбора цели: база + приоритет «холодным» (на кого давно не нападали). */
  _targetWeight(enemy) { return 1 + this.target.coldWeight * this.coldness(enemy); }

  /** Самый «холодный»/незанятый враг из списка (вес ÷ текущая нагрузка). */
  _coldestEnemy(enemies, load) {
    let best = null, bestW = -Infinity;
    for (const e of enemies) {
      const w = this._targetWeight(e) / (1 + (load.get(String(e.id)) || 0));
      if (w > bestW) { bestW = w; best = e; }
    }
    return best;
  }

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

    // есть ли у бойца «заброшенный» живой враг — по нему давно не били (coldness)
    // и он сейчас ни с кем не сведён? Тогда устойчивую пару РАЗРЫВАЕМ, чтобы
    // втянуть забытого в размен. Иначе в неравном бою (1×N) сторона-одиночка
    // молотит всегда одного и того же, а второй враг не получает урона (ТЗ #3).
    const hasNeglected = (id) => this.enemiesOf(id).some(
      (e) => !engaged.has(e.id) && this.coldness(e) >= this.target.coldTurns);

    // 1) сохраняем устойчивые взаимные пары (если не «холодные» и не выпал шанс
    //    смены). Решение по паре принимаем РОВНО один раз (decided) — иначе второй
    //    конец пары мог бы отменить разрыв, и забытый враг так и не вступил бы в бой.
    const decided = new Set();
    for (const f of [...left, ...right]) {
      if (engaged.has(f.id) || decided.has(f.id)) continue;
      const p = f.opponentId ? this.fighter(f.opponentId) : null;
      const mutual = p && p.alive && p.side !== f.side
        && String(p.opponentId) === String(f.id)
        && !engaged.has(p.id) && !decided.has(p.id);
      if (!mutual) continue;
      decided.add(f.id); decided.add(p.id);
      const cold = this.coldness(f) >= this.target.coldTurns
        || this.coldness(p) >= this.target.coldTurns;
      if (cold || hasNeglected(f.id) || hasNeglected(p.id)
          || Math.random() < this.target.switchChance) continue;   // разъединяем
      engaged.add(f.id); engaged.add(p.id); bump(f.id); bump(p.id);
    }

    // 2) свободных (по инициативе) сватаем к наименее занятому/«холодному» врагу;
    //    взаимность ставим, если враг ещё свободен — но смотрит он на самого
    //    «холодного» из СВОИХ врагов (обычно это и есть f). Так одиночка в неравном
    //    бою смотрит на заброшенного, а не вечно на того, кто его атаковал первым.
    for (const id of this.order) {
      const f = this.fighter(id);
      if (!f || !f.alive || engaged.has(f.id)) continue;
      const enemies = this.enemiesOf(f.id);
      if (!enemies.length) continue;
      const best = this._coldestEnemy(enemies, load);
      f.opponentId = best.id; engaged.add(f.id); bump(best.id);
      if (!engaged.has(best.id)) {
        const back = this._coldestEnemy(this.enemiesOf(best.id), load) || f;
        best.opponentId = back.id; engaged.add(best.id); bump(back.id);
      }
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

  _strike(attacker, defender, zone, isCounter = false) {
    // «холод» цели = давно ли по бойцу БИЛИ: отмечаем лишь того, по кому ударили.
    // Боец, который сам атакует, но по нему не попадают, остаётся «холодным» —
    // его и выберут целью; иначе в 1×N одиночка молотит всегда одного (ТЗ #3).
    defender.lastTargetedTurn = this.turn;
    const m = this.model;
    let blocked, dodged, crit, damage = 0;
    if (m && attacker.stats && defender.stats) {
      // модельный бой: исходы из производных статов (блок — по шансу, не по зоне)
      const A = attacker.stats, D = defender.stats;
      dodged = Math.random() < m.dodgeChance(A, D);
      blocked = !dodged && Math.random() < m.blockChance(A, D);
      const critBonus = attacker.critBuffTurns > 0 ? attacker.critBuffAdd : 0;
      crit = !dodged && Math.random() < m.critChance(A, D) + critBonus;
      if (!dodged) {
        let dmg = m.baseDamage(A) * m.damageVariance();
        if (crit) dmg *= m.critMult(A);
        dmg *= (1 - m.defenseMitigation(D));
        if (blocked) dmg *= (1 - m.blockMitigation(D));
        if (attacker.buffTurns > 0) { dmg *= attacker.buffMult; attacker.buffTurns -= 1; }
        damage = Math.max(1, Math.round(dmg));
        damage = Math.min(damage, Math.max(0, Math.round(defender.hp)));
        defender.hp = Math.max(0, defender.hp - damage);
        if (defender.hp <= 0) defender.alive = false;
      }
    } else {
      // прежняя логика (живой бой): зональный блок ×0.12, крит ×1.8
      blocked = defender.block === zone;
      dodged = !blocked && Math.random() < defender.dodge;
      const critBonus = attacker.critBuffTurns > 0 ? attacker.critBuffAdd : 0;
      crit = !dodged && Math.random() < attacker.crit + critBonus;
      if (!dodged) {
        damage = rnd(attacker.damage[0], attacker.damage[1]);
        if (crit && blocked) damage *= 0.85;
        else if (crit) damage *= 1.8;
        else if (blocked) damage *= 0.12;
        // «Эликсир мощи»: усиливает удары N раз; заряд тратится на удар
        if (attacker.buffTurns > 0) { damage *= attacker.buffMult; attacker.buffTurns -= 1; }
        damage = Math.max(1, Math.round(damage));
        damage = Math.min(damage, Math.max(0, Math.round(defender.hp)));
        defender.hp = Math.max(0, defender.hp - damage);
        if (defender.hp <= 0) defender.alive = false;
      }
    }
    // «Эликсир крови»: прибавка к криту действует на ХОД бойца — гасим её на его
    // ударе (но не на контратаке, иначе сгорела бы до его настоящего хода).
    if (!isCounter && attacker.critBuffTurns > 0) attacker.critBuffTurns -= 1;
    return {
      attackerId: attacker.id, defenderId: defender.id,
      attackerSide: attacker.side, defenderSide: defender.side,
      zone, blocked, dodged, crit, damage, counter: isCounter,
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
      if (actor.alive && target && target.alive) {
        const s = this._strike(actor, target, p.attack);
        strikes.push(s);
        // контратака (только модельный бой): защитник бьёт в ответ по атакующему,
        // если выжил и удар попал; ответный удар сам контратаку не вызывает
        if (this.model && !s.dodged && target.alive && actor.alive
            && target.stats && actor.stats
            && Math.random() < this.model.counterChance(target.stats, actor.stats)) {
          strikes.push(this._strike(target, actor, ZONES[(Math.random() * 3) | 0], true));
        }
      }
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

  /** Прибавка к шансу крита («Эликсир крови») на N своих ходов. */
  addCritBuff(id, add, turns) {
    const f = this.fighter(id);
    if (!f || !f.alive) return false;
    f.critBuffAdd = Math.max(0, Number(add) || 0);
    f.critBuffTurns = Math.max(0, Math.round(turns));
    return true;
  }

  /**
   * Эффект по времени (HoT/DoT/мана): total — суммарная величина (HP/MP),
   * растянутая на durationMs реального времени. kind: 'health' | 'heal_scroll'
   * (лечение), 'poison' (урон), 'mana' (восстановление MP).
   * stack=false → эффект того же вида ЗАМЕНЯЕТСЯ (эликсиры: рефреш, без стопок);
   * stack=true  → ДОБАВЛЯЕТСЯ к идущим (свитки яда/исцеления копятся от нескольких
   * источников на одну цель). См. tickEffects.
   */
  addOverTime(id, kind, total, durationMs, srcId = null, stack = false) {
    const f = this.fighter(id);
    if (!f || !f.alive) return false;
    if (!stack) f.effects = f.effects.filter((e) => e.kind !== kind);
    f.effects.push({ kind, total: Math.max(0, Number(total) || 0),
      applied: 0, durationMs: Math.max(1, Number(durationMs) || 1),
      elapsedMs: 0, srcId });
    return true;
  }

  /**
   * Тик эффектов по времени: dtMs — прошедшее реальное время. Применяет дробную
   * долю каждого эффекта (по доле прошедшего времени), снимает доигравшие.
   * Возвращает { changed: [бойцы с изменением], deaths: [id умерших от яда] }.
   */
  tickEffects(dtMs) {
    const dt = Math.max(0, Number(dtMs) || 0);
    const changed = [], deaths = [];
    if (!dt) return { changed, deaths };
    for (const f of this.fighters.values()) {
      if (!f.alive || !f.effects.length) continue;
      let touched = false;
      for (const e of f.effects) {
        const step = Math.min(dt, e.durationMs - e.elapsedMs);
        if (step <= 0) continue;
        e.elapsedMs += step;
        const target = e.total * (e.elapsedMs / e.durationMs);
        const delta = target - e.applied;     // сколько применить в этом тике
        e.applied = target;
        if (delta === 0) continue;
        touched = true;
        if (e.kind === 'mana') {
          f.mp = Math.max(0, Math.min(f.maxMp, f.mp + delta));
        } else if (e.kind === 'poison') {
          f.hp = Math.max(0, f.hp - delta);
          if (f.hp <= 0) f.alive = false;
        } else {                               // health / heal_scroll — лечение
          f.hp = Math.min(f.maxHp, f.hp + delta);
        }
      }
      f.effects = f.effects.filter((e) => e.elapsedMs < e.durationMs - 0.5);
      if (touched) { changed.push(f); if (!f.alive) deaths.push(f.id); }
    }
    return { changed, deaths };
  }

  /** Снять эффекты указанных видов («Свиток очищения»). Возвращает снятые виды. */
  cleanse(id, kinds) {
    const f = this.fighter(id);
    if (!f) return [];
    const set = new Set(kinds || []);
    const removed = [];
    f.effects = f.effects.filter((e) => {
      if (set.has(e.kind)) { removed.push(e.kind); return false; }
      return true;
    });
    return removed;
  }

  finished() { return !this.aliveOf('left').length || !this.aliveOf('right').length; }
  winner()   { return this.aliveOf('left').length ? 'left'
                   : this.aliveOf('right').length ? 'right' : null; }
}
