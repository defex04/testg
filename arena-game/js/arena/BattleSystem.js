/**
 * Пошаговая боевая система в духе «Легенда: Наследие драконов».
 *
 * Чистая логика без DOM и 3D: зоны атаки, блоки, таймер хода, расчёт урона.
 * Общается с внешним миром событиями (EventTarget), поэтому её можно
 * переиспользовать с любым рендером и любым UI — или перенести на сервер.
 */

export const ZONES = [
  { id: 'high', label: 'Вверх', hint: 'голова' },
  { id: 'mid',  label: 'Центр', hint: 'корпус' },
  { id: 'low',  label: 'Вниз',  hint: 'ноги' },
];

export const BLOCKS = [
  { id: 'b-high', zones: ['high'], label: 'Вверх', hint: 'голова' },
  { id: 'b-mid',  zones: ['mid'],  label: 'Центр', hint: 'корпус' },
  { id: 'b-low',  zones: ['low'],  label: 'Вниз',  hint: 'ноги' },
];

const rnd = (min, max) => min + Math.random() * (max - min);

export class BattleSystem extends EventTarget {
  /**
   * sides: { left: stats, right: stats }
   * stats: { name, hp, damage: [min, max], crit, dodge, isAI }
   */
  constructor(sides, opts = {}) {
    super();
    this.turnTime = opts.turnTime ?? 30;
    this.sides = {};
    for (const key of ['left', 'right']) {
      const s = sides[key];
      this.sides[key] = {
        ...s,
        maxHp: s.hp,
        hp: s.hp,
        crit: s.crit ?? 0.1,
        dodge: s.dodge ?? 0.06,
      };
    }
    this.turn = 0;
    this.phase = 'idle'; // idle | choose | resolving | ended
    this.moves = { left: null, right: null };
    this._moveOrder = [];   // порядок, в котором стороны сделали выбор
    this._timerId = null;
    this.timeLeft = 0;
  }

  start() {
    this._startTurn();
  }

  _startTurn() {
    if (this.phase === 'ended') return;
    this.turn += 1;
    this.phase = 'choose';
    this.moves = { left: null, right: null };
    this._moveOrder = [];
    this.timeLeft = this.turnTime;
    this._emit('turnStart', { turn: this.turn, timeLeft: this.timeLeft });

    this._timerId = setInterval(() => {
      this.timeLeft -= 1;
      this._emit('timer', { timeLeft: this.timeLeft });
      if (this.timeLeft <= 0) {
        // время вышло: ИИ бьёт наугад, а игрок без выбора пропускает удар
        // (его в этот ход бьют, но сам он не отвечает)
        for (const side of ['left', 'right']) {
          if (!this.moves[side]) {
            this._setMove(side, this.sides[side].isAI
              ? this._randomMove()
              : { attack: null, block: null, pass: true });
          }
        }
      }
    }, 1000);

    // ИИ делает выбор с небольшой задержкой
    for (const side of ['left', 'right']) {
      if (this.sides[side].isAI) {
        setTimeout(() => {
          if (this.phase === 'choose' && !this.moves[side]) {
            this._setMove(side, this._randomMove());
          }
        }, 400 + Math.random() * 900);
      }
    }
  }

  _randomMove() {
    return {
      attack: ZONES[Math.floor(Math.random() * ZONES.length)].id,
      block: BLOCKS[Math.floor(Math.random() * BLOCKS.length)].id,
    };
  }

  submitMove(side, move) {
    if (this.phase !== 'choose' || this.moves[side]) return false;
    this._setMove(side, move);
    return true;
  }

  _setMove(side, move) {
    this.moves[side] = move;
    this._moveOrder.push(side);
    if (this.moves.left && this.moves.right) this._resolve();
  }

  _resolve() {
    this.phase = 'resolving';
    clearInterval(this._timerId);

    // Инициатива: игрок, сделавший выбор, всегда бьёт раньше ИИ;
    // между живыми игроками (PvP) — кто раньше нажал, тот и первый.
    // Сторона, пропустившая ход (pass), не бьёт вовсе.
    const order = [...this._moveOrder].sort((a, b) =>
      (this.sides[a].isAI ? 1 : 0) - (this.sides[b].isAI ? 1 : 0));
    const passed = order.filter((s) => this.moves[s].pass);
    const strikes = [];

    for (const attackerSide of order) {
      if (this.moves[attackerSide].pass) continue;
      const defenderSide = attackerSide === 'left' ? 'right' : 'left';
      const attacker = this.sides[attackerSide];
      const defender = this.sides[defenderSide];
      if (attacker.hp <= 0 || defender.hp <= 0) continue;

      const attackZone = this.moves[attackerSide].attack;
      const blockDef = BLOCKS.find((b) => b.id === this.moves[defenderSide].block);
      const blocked = !!blockDef && blockDef.zones.includes(attackZone);
      const dodged = !blocked && Math.random() < defender.dodge;
      const crit = !dodged && Math.random() < attacker.crit;

      let damage = 0;
      if (!dodged) {
        damage = rnd(attacker.damage[0], attacker.damage[1]);
        if (crit && blocked) damage *= 0.85;        // крит пробивает блок
        else if (crit) damage *= 1.8;
        else if (blocked) damage *= 0.12;           // блок гасит удар
        damage = Math.max(1, Math.round(damage));
        defender.hp = Math.max(0, defender.hp - damage);
      }

      strikes.push({
        attacker: attackerSide,
        defender: defenderSide,
        zone: attackZone,
        blocked,
        dodged,
        crit,
        damage,
        defenderHp: defender.hp,
        killed: defender.hp <= 0,
      });
      if (defender.hp <= 0) break;
    }

    this._emit('resolve', { turn: this.turn, strikes, passed, sides: this.sides });
  }

  /** Вызывается оркестратором после проигрывания всех анимаций хода. */
  finishTurn() {
    if (this.phase !== 'resolving') return;
    const dead = ['left', 'right'].filter((s) => this.sides[s].hp <= 0);
    if (dead.length) {
      this.phase = 'ended';
      const winner = this.sides.left.hp > 0 ? 'left'
        : this.sides.right.hp > 0 ? 'right' : null;
      this._emit('battleEnd', { winner, sides: this.sides });
    } else {
      this._startTurn();
    }
  }

  destroy() {
    clearInterval(this._timerId);
    this.phase = 'ended';
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
