/**
 * Серверный движок боя — командный NvN. Формулы и семантика 1:1 с прежней
 * версией: 3 зоны удара × 3 блока, blocked ×0.12, crit ×1.8, crit+block ×0.85,
 * dodge. Бой 1×1 (охота, дуэль) — частный случай команд из одного бойца.
 *
 * Модель хода (как в «Легенде: Наследие драконов»):
 *  - стороны left/right — массивы бойцов;
 *  - бой — набор ДУЭЛЕЙ 1-на-1: каждый боец бьёт ровно ОДНОГО соперника, и его
 *    бьёт ровно один (никаких «навалиться вдвоём на одного»). Цель НЕ выбирает
 *    игрок — пары сватает СЕРВЕР (assignTargets). Кто без пары — «ждёт»;
 *  - раунд: каждый боец В ПАРЕ действует один раз в порядке инициативы (по
 *    убыванию); «ждущие» ход пропускают. Порядок инициативы считается ОДИН РАЗ со
 *    стабильным тай-брейком → строгое чередование, без ударов подряд одним бойцом;
 *  - пары стабильны внутри «эпохи ротации» и сдвигаются раз в N раундов: в
 *    неравном бою ждущий обязательно вступает в бой (честная ротация), ровные
 *    команды иногда перемешиваются. Решает СЕРВЕР, детерминированно (см. _pairEpoch);
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
  constructor(sides, { turnTime = 20, target = {}, model = null, pairRotate = {} } = {}) {
    this.turnTime = turnTime;
    // Боевая модель статов (Broken Sun) — опционально. Если задана и у бойцов есть
    // блок stats, удар считается по производным формулам (Мощь/Защита/Точность/…)
    // и включается контратака. Без модели — прежняя логика (зоны/блок ×0.12/крит ×1.8),
    // поэтому ЖИВОЙ бой не меняется. Модель использует симулятор.
    this.model = model;
    // Ротация дуэльных пар (сколько раундов держится одна раскладка): для НЕРАВНЫХ
    // команд частая (ждущий быстро вступает в бой), для РОВНЫХ — редкая (лишь
    // «иногда перемешать» для разнообразия). См. assignTargets/_pairEpoch.
    this.pairRotateUneven = Math.max(1, Number(pairRotate.uneven) || 2);
    this.pairRotateEven   = Math.max(1, Number(pairRotate.even)   || 4);
    // target.* (switchChance/cold*) больше НЕ управляют сменой соперника — пары
    // строгие 1:1 и ротируются по таймеру (assignTargets). Поля приняты лишь для
    // совместимости с симулятором/админкой (там ещё слайдеры), движок их не чтит.
    this.target = {
      switchChance: target.switchChance ?? 0,
      coldTurns: target.coldTurns ?? 0,
      coldWeight: target.coldWeight ?? 0,
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
      opponentId: null,                  // соперник по дуэли (null = «ждёт»); см. assignTargets
      lastTargetedTurn: 0,               // раунд, когда по бойцу БИЛИ (для статистики/отладки)
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
      // роли «пачки» (см. manager.applyAiElixirs): лекарь лечит союзников, отравитель травит цель
      aiHealAllyUses: Number(def.aiHealAllyUses ?? 0),
      aiPoisonUses: Number(def.aiPoisonUses ?? 0),
      aiPoisonPct: Number(def.aiPoisonPct ?? 0),
      aiPoisonSecs: Number(def.aiPoisonSecs ?? 40),
      aiPoisonEvery: Number(def.aiPoisonEvery ?? 5),
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
   *  и пересобираем дуэльные пары под текущую эпоху ротации (assignTargets). */
  startRound() {
    this.turn += 1;
    this.phase = 'choose';
    this.acted = new Set();
    this.idx = -1;
    this.assignTargets();
    return this._nextActor();
  }

  _nextActor() {
    for (let i = this.idx + 1; i < this.order.length; i++) {
      const f = this.fighters.get(this.order[i]);
      // ходят только бойцы В ПАРЕ; «ждущие» (без живого соперника) пропускаются
      if (f.alive && !this.acted.has(f.id) && this._hasLiveOpponent(f)) {
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
  /** Активный боец sub-turn'а: жив, ещё не ходил в раунде, есть назначенный соперник. */
  _isActiveActor(f) {
    return !!(f && f.alive && !this.acted.has(f.id) && this._hasLiveOpponent(f));
  }
  currentActor() {
    const f = this.fighter(this.currentActorId());
    return this._isActiveActor(f) ? f : null;
  }

  /** Есть ли у бойца назначенный ЖИВОЙ соперник (он в паре, а не «ждёт»). */
  _hasLiveOpponent(f) {
    const o = f && f.opponentId ? this.fighter(f.opponentId) : null;
    return !!(o && o.alive && o.side !== f.side);
  }

  /**
   * Эпоха ротации пар: меняется раз в N раундов и сдвигает раскладку. Для НЕРАВНЫХ
   * команд (есть ждущие) ротация частая (pairRotateUneven) — ждущий быстро вступает
   * в бой; для РОВНЫХ — редкая (pairRotateEven), лишь «иногда перемешать». Сдвиг на
   * 1 за эпоху → честный round-robin (ждущая позиция равномерно ходит по кругу).
   */
  _pairEpoch(uneven) {
    const period = uneven ? this.pairRotateUneven : this.pairRotateEven;
    return Math.floor((this.turn - 1) / Math.max(1, period));
  }

  /**
   * Сватовство дуэлей 1-на-1 (механика «Легенды: Наследие драконов»). Раз в раунд
   * пересобираем раскладку: меньшую сторону целиком разбираем по парам с большей,
   * ЛИШНИЕ бойцы большей стороны «ждут» (без соперника). Строго 1:1 — никого не
   * бьют двое сразу. Раскладка детерминирована (стабильна внутри эпохи), а раз в N
   * раундов ротация её сдвигает: ждущие обязательно вступают в бой, ровные команды
   * иногда перемешиваются (см. _pairEpoch).
   *   small[i] ↔ big[(i + epoch) mod |big|];  не выбранные в big — ждут.
   */
  assignTargets() {
    // ранг инициативы строим ОДИН раз за раунд (обе стороны сортируем по нему)
    const rank = new Map(this.order.map((id, i) => [id, i]));
    const byInit = (s) => this.aliveOf(s).sort((a, b) =>
      (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    const left = byInit('left'), right = byInit('right');
    for (const f of [...left, ...right]) f.opponentId = null;   // пересобираем заново
    if (!left.length || !right.length) return;
    const [small, big] = left.length <= right.length ? [left, right] : [right, left];
    const uneven = small.length !== big.length;
    const epoch = this._pairEpoch(uneven);
    const mod = big.length;
    for (let i = 0; i < small.length; i++) {
      const a = small[i];
      const b = big[(i + epoch) % mod];
      a.opponentId = b.id;
      b.opponentId = a.id;
    }
    // оставшиеся в big (mod > small.length) держат opponentId = null → «ждут»
  }

  /**
   * Соперник бойца по его дуэли на этот раунд (назначен assignTargets). Возвращает
   * его, если жив; иначе null — соперник погиб либо боец «ждёт». Нового СЕРВЕР здесь
   * НЕ подбирает: пары пересобираются в начале следующего раунда (assignTargets).
   * Так держится строгая модель 1:1 без «доганивания» чужих целей.
   */
  ensureOpponent(actorId) {
    const f = this.fighter(actorId);
    if (!f) return null;
    const o = f.opponentId ? this.fighter(f.opponentId) : null;
    return o && o.alive && o.side !== f.side ? o : null;
  }

  /** Текущий соперник без пере-выбора (для фокуса зрителя). */
  opponentOf(actorId) {
    const f = this.fighter(actorId);
    const cur = f && f.opponentId ? this.fighter(f.opponentId) : null;
    return cur && cur.alive && cur.side !== f.side ? cur : null;
  }

  aiMove() {
    // цель ИИ — его назначенный соперник по дуэли (assignTargets), поэтому здесь
    // только зоны удара/блока; ИИ цель не выбирает (move.target не шлёт)
    return { attack: ZONES[(Math.random() * 3) | 0], block: ZONES[(Math.random() * 3) | 0] };
  }

  /**
   * Выбор хода активного бойца. move: { attack, block, pass }.
   * Цель ближнего удара НЕ из move — это назначенный сервером соперник по дуэли
   * (assignTargets, строгая пара 1:1). Игрок цель удара НЕ выбирает; move.target
   * используется лишь для эликсиров/эффектов (выбор союзника/врага), не для удара.
   */
  submit(actorId, move) {
    if (this.phase !== 'choose') return false;
    const f = this.fighter(actorId);
    if (!f || !this._isActiveActor(f) || this.currentActorId() !== f.id) return false;
    if (move.block != null && !ZONES.includes(move.block)) return false;
    let target = null;
    if (!move.pass) {
      if (!ZONES.includes(move.attack)) return false;
      // бьём своего соперника по паре; если его уже нет (погиб/«ждём») — ход впустую
      target = this.ensureOpponent(f.id);
      if (!target) return false;
    }
    f.block = move.block ?? null;
    this._pending = { actorId: f.id, targetId: target ? target.id : null,
                      attack: move.attack, pass: !!move.pass };
    return true;
  }

  _strike(attacker, defender, zone, isCounter = false) {
    // отметка «по бойцу били в этом раунде» — для статистики/отладки (на состав
    // пар не влияет: пары строит assignTargets по ротации, а не по «холоду»)
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
    // Когда заряды кончились — полностью обнуляем (чтобы чип/счётчик не «висел», #2).
    if (!isCounter && attacker.critBuffTurns > 0) {
      attacker.critBuffTurns -= 1;
      if (attacker.critBuffTurns <= 0) { attacker.critBuffTurns = 0; attacker.critBuffAdd = 0; }
    }
    // «Эликсир мощи»: тот же порядок — на нуле зарядов сбрасываем множитель.
    if (attacker.buffTurns <= 0 && attacker.buffMult !== 1) attacker.buffMult = 1;
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
  addBuff(id, mult, turns, quality = 0) {
    const f = this.fighter(id);
    if (!f || !f.alive) return false;
    f.buffMult = mult;
    f.buffTurns = Math.max(0, Math.round(turns));
    f.buffQuality = quality;             // цвет чипа эффекта = качество эликсира (#3)
    return true;
  }

  /** Прибавка к шансу крита («Эликсир крови») на N своих ходов. */
  addCritBuff(id, add, turns, quality = 0) {
    const f = this.fighter(id);
    if (!f || !f.alive) return false;
    f.critBuffAdd = Math.max(0, Number(add) || 0);
    f.critBuffTurns = Math.max(0, Math.round(turns));
    f.critBuffQuality = quality;
    return true;
  }

  /**
   * Эффект по времени (HoT/DoT/мана): total — суммарная величина (HP/MP),
   * РАВНЫМИ ПОРЦИЯМИ применяемая ДИСКРЕТНЫМИ тиками каждые periodMs реального
   * времени, пока не истечёт durationMs. kind: 'health' | 'heal_scroll'
   * (лечение), 'poison' (урон), 'mana' (восстановление MP).
   *
   * Тик — «как часы» (#3): длительность делится на целое число равных шагов
   * (ticksTotal = round(duration/period)), порция = total/ticksTotal, реальный
   * период = duration/ticksTotal (последний шаг приходится ровно на конец). Это
   * детерминированно и не зависит от джиттера событийного цикла (tickEffects
   * считает по «настенному» elapsedMs, а не по числу вызовов).
   *
   * stack=false → эффект того же вида ЗАМЕНЯЕТСЯ (эликсиры: рефреш, без стопок);
   * stack=true  → ДОБАВЛЯЕТСЯ к идущим (свитки яда/исцеления копятся от нескольких
   * источников на одну цель). См. tickEffects.
   */
  addOverTime(id, kind, total, durationMs, srcId = null, stack = false,
              quality = 0, periodMs = 5000) {
    const f = this.fighter(id);
    if (!f || !f.alive) return false;
    if (!stack) f.effects = f.effects.filter((e) => e.kind !== kind);
    const dur = Math.max(1, Number(durationMs) || 1);
    const per = Math.max(1, Math.min(dur, Number(periodMs) || 5000));
    const ticksTotal = Math.max(1, Math.round(dur / per));
    const stepMs = dur / ticksTotal;            // реальный период тика (мс)
    f.effects.push({ kind, total: Math.max(0, Number(total) || 0),
      applied: 0, durationMs: dur, elapsedMs: 0,
      stepMs, ticksTotal, ticksDone: 0,
      srcId, quality });
    return true;
  }

  /**
   * Тик эффектов по времени: dtMs — прошедшее реальное время. Применяет ВСЕ
   * дискретные шаги, чьё время наступило (стабильно при любом dt — наверстывает
   * пропущенные тики, если событийный цикл подвис). Кладёт на бойца `_effDelta`
   * — ЧИСТОЕ изменение HP именно от эффектов за этот тик (для всплывашек: полоса
   * HP двигается и от ударов, а число должно показывать ровно эффект, #2).
   * Возвращает:
   *  - changed: бойцы, у кого что-то поменялось;
   *  - deaths:  id умерших от яда;
   *  - damageBySrc: Map(srcId → суммарный урон ядом) — для статистики (#1);
   *  - kills: [{killerId, victimId}] — кому засчитать скальп от яда (#1).
   */
  tickEffects(dtMs) {
    const dt = Math.max(0, Number(dtMs) || 0);
    const changed = [], deaths = [];
    const damageBySrc = new Map(), kills = [];
    if (!dt) return { changed, deaths, damageBySrc, kills };
    for (const f of this.fighters.values()) {
      if (!f.alive || !f.effects.length) continue;
      let touched = false, effDelta = 0;
      for (const e of f.effects) {
        if (f.alive === false) break;
        e.elapsedMs = Math.min(e.durationMs, e.elapsedMs + dt);
        // сколько целых шагов «созрело» к текущему времени (но не больше всего)
        const dueTicks = Math.min(e.ticksTotal, Math.floor(e.elapsedMs / e.stepMs + 1e-6));
        if (dueTicks <= e.ticksDone) continue;
        const want = e.total * (dueTicks / e.ticksTotal);   // сколько ВСЕГО должно быть применено
        const delta = want - e.applied;
        e.applied = want;
        e.ticksDone = dueTicks;
        if (delta === 0) continue;
        touched = true;
        if (e.kind === 'mana') {
          f.mp = Math.max(0, Math.min(f.maxMp, f.mp + delta));
        } else if (e.kind === 'poison') {
          const before = f.hp;
          f.hp = Math.max(0, f.hp - delta);
          const dealt = before - f.hp;         // реально снятый HP (не ниже 0)
          effDelta -= dealt;
          if (e.srcId != null) damageBySrc.set(e.srcId, (damageBySrc.get(e.srcId) || 0) + dealt);
          if (before > 0 && f.hp <= 0) {        // именно этот яд добил — ему скальп
            f.alive = false;
            kills.push({ killerId: e.srcId, victimId: f.id });
          }
        } else {                               // health / heal_scroll — лечение
          const before = f.hp;
          f.hp = Math.min(f.maxHp, f.hp + delta);
          effDelta += f.hp - before;
        }
      }
      // эффект снят, когда отыграл все свои шаги (а не «почти» по времени)
      f.effects = f.effects.filter((e) => e.ticksDone < e.ticksTotal);
      if (touched) { f._effDelta = effDelta; changed.push(f); if (!f.alive) deaths.push(f.id); }
    }
    return { changed, deaths, damageBySrc, kills };
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
