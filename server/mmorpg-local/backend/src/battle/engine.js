/**
 * Серверный порт BattleSystem.js — формулы и семантика 1:1:
 * 3 зоны удара × 3 блока, таймер хода, pass при таймауте,
 * blocked ×0.12, crit ×1.8, crit+block ×0.85.
 *
 * Режимы:
 *  - hunt: оба выбирают ход одновременно, удары в одном resolve;
 *  - pvp: поочерёдно — сначала инициатива, удар сразу, потом ход соперника.
 */
export const ZONES = ['high', 'mid', 'low'];
const rnd = (min, max) => min + Math.random() * (max - min);
const other = (s) => (s === 'left' ? 'right' : 'left');

export class Engine {
  constructor(sides, { turnTime = 20, mode = 'hunt' } = {}) {
    this.mode = mode;
    this.turnTime = turnTime;
    this.sides = {};
    for (const k of ['left', 'right']) {
      const s = sides[k];
      this.sides[k] = { ...s, maxHp: s.hp, hp: s.hp,
        crit: s.crit ?? 0.1, dodge: s.dodge ?? 0.06,
        initiative: Number(s.initiative ?? s.level ?? 0) };
    }
    this.turn = 0;
    this.phase = 'idle';
    this.moves = { left: null, right: null };
    this.moveOrder = [];
    // PvP: блок держится между ходами, пока игрок не сменит
    this.blocks = { left: null, right: null };
    this.activeSide = null;
    this.acted = { left: false, right: false };
  }

  /** Охота: оба выбирают ход одновременно. */
  startTurn() {
    this.turn += 1;
    this.phase = 'choose';
    this.moves = { left: null, right: null };
    this.moveOrder = [];
    return { turn: this.turn, timeLeft: this.turnTime };
  }

  /** PvP: новый раунд — первым ходит с большей инициативой. */
  startRound() {
    this.turn += 1;
    this.phase = 'choose';
    this.moves = { left: null, right: null };
    this.moveOrder = [];
    this.acted = { left: false, right: false };
    const li = this.sides.left.initiative;
    const ri = this.sides.right.initiative;
    this.activeSide = li === ri
      ? (Math.random() < 0.5 ? 'left' : 'right')
      : (li > ri ? 'left' : 'right');
    return { turn: this.turn, timeLeft: this.turnTime, active: this.activeSide };
  }

  /** PvP: второй удар в том же раунде. */
  startSubTurn() {
    this.activeSide = other(this.activeSide);
    this.phase = 'choose';
    return { turn: this.turn, timeLeft: this.turnTime, active: this.activeSide };
  }

  randomMove() {
    return { attack: ZONES[(Math.random() * 3) | 0], block: ZONES[(Math.random() * 3) | 0] };
  }

  submit(side, move) {
    if (this.phase !== 'choose' || this.moves[side]) return false;
    if (this.mode === 'pvp' && side !== this.activeSide) return false;
    if (!move.pass && !ZONES.includes(move.attack)) return false;
    if (move.block != null && !ZONES.includes(move.block)) return false;
    this.moves[side] = move;
    if (move.block != null) this.blocks[side] = move.block;
    this.moveOrder.push(side);
    return true;
  }

  get ready() { return !!(this.moves.left && this.moves.right); }

  /** Таймаут хода (охота): ИИ бьёт наугад, игрок без выбора пропускает удар. */
  fillTimeouts() {
    for (const side of ['left', 'right']) {
      if (!this.moves[side]) {
        this.submit(side, this.sides[side].isAI
          ? this.randomMove()
          : { attack: null, block: null, pass: true });
      }
    }
  }

  /** Таймаут хода (PvP): активный игрок пропускает удар, блок сохраняется. */
  fillTimeoutActive() {
    if (!this.moves[this.activeSide]) {
      this.submit(this.activeSide, { attack: null, block: null, pass: true });
    }
  }

  _defenderBlock(defenderSide) {
    return this.mode === 'pvp'
      ? this.blocks[defenderSide]
      : this.moves[defenderSide]?.block ?? null;
  }

  _strike(attackerSide, defenderSide, zone) {
    const attacker = this.sides[attackerSide];
    const defender = this.sides[defenderSide];
    const blocked = this._defenderBlock(defenderSide) === zone;
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
    }
    return { attacker: attackerSide, defender: defenderSide, zone,
      blocked, dodged, crit, damage, defenderHp: defender.hp,
      killed: defender.hp <= 0 };
  }

  /** Охота: оба удара за раунд. */
  resolve() {
    this.phase = 'resolving';
    const order = [...this.moveOrder].sort((a, b) =>
      (this.sides[a].isAI ? 1 : 0) - (this.sides[b].isAI ? 1 : 0));
    const passed = order.filter((s) => this.moves[s].pass);
    const strikes = [];

    for (const attackerSide of order) {
      if (this.moves[attackerSide].pass) continue;
      const defenderSide = other(attackerSide);
      const attacker = this.sides[attackerSide];
      const defender = this.sides[defenderSide];
      if (attacker.hp <= 0 || defender.hp <= 0) continue;

      const zone = this.moves[attackerSide].attack;
      strikes.push(this._strike(attackerSide, defenderSide, zone));
      if (defender.hp <= 0) break;
    }
    return { turn: this.turn, strikes, passed };
  }

  /** PvP: удар только активного игрока, сразу после выбора. */
  resolveActive() {
    this.phase = 'resolving';
    const attackerSide = this.activeSide;
    const move = this.moves[attackerSide];
    const passed = move.pass ? [attackerSide] : [];
    const strikes = [];

    if (!move.pass) {
      const defenderSide = other(attackerSide);
      const attacker = this.sides[attackerSide];
      const defender = this.sides[defenderSide];
      if (attacker.hp > 0 && defender.hp > 0) {
        strikes.push(this._strike(attackerSide, defenderSide, move.attack));
      }
    }
    return { turn: this.turn, strikes, passed };
  }

  finished() {
    return this.sides.left.hp <= 0 || this.sides.right.hp <= 0;
  }

  winner() {
    return this.sides.left.hp > 0 ? 'left' : this.sides.right.hp > 0 ? 'right' : null;
  }
}
