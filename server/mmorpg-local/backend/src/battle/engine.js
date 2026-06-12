/**
 * Серверный порт BattleSystem.js — формулы и семантика 1:1:
 * 3 зоны удара × 3 блока, таймер хода, инициатива игрока перед ИИ,
 * pass при истечении таймера, blocked ×0.12, crit ×1.8, crit+block ×0.85.
 * Без DOM/таймеров рендера: тики и события отдаёт менеджер.
 */
export const ZONES = ['high', 'mid', 'low'];
const rnd = (min, max) => min + Math.random() * (max - min);

export class Engine {
  constructor(sides, { turnTime = 20 } = {}) {
    this.turnTime = turnTime;
    this.sides = {};
    for (const k of ['left', 'right']) {
      const s = sides[k];
      this.sides[k] = { ...s, maxHp: s.hp, hp: s.hp,
        crit: s.crit ?? 0.1, dodge: s.dodge ?? 0.06 };
    }
    this.turn = 0;
    this.phase = 'idle';
    this.moves = { left: null, right: null };
    this.moveOrder = [];
  }

  startTurn() {
    this.turn += 1;
    this.phase = 'choose';
    this.moves = { left: null, right: null };
    this.moveOrder = [];
    return { turn: this.turn, timeLeft: this.turnTime };
  }

  randomMove() {
    return { attack: ZONES[(Math.random() * 3) | 0], block: ZONES[(Math.random() * 3) | 0] };
  }

  submit(side, move) {
    if (this.phase !== 'choose' || this.moves[side]) return false;
    if (!move.pass && !ZONES.includes(move.attack)) return false;
    if (move.block != null && !ZONES.includes(move.block)) return false;
    this.moves[side] = move;
    this.moveOrder.push(side);
    return true;
  }

  get ready() { return !!(this.moves.left && this.moves.right); }

  /** Таймаут хода: ИИ бьёт наугад, игрок без выбора пропускает удар. */
  fillTimeouts() {
    for (const side of ['left', 'right']) {
      if (!this.moves[side]) {
        this.submit(side, this.sides[side].isAI
          ? this.randomMove()
          : { attack: null, block: null, pass: true });
      }
    }
  }

  resolve() {
    this.phase = 'resolving';
    const order = [...this.moveOrder].sort((a, b) =>
      (this.sides[a].isAI ? 1 : 0) - (this.sides[b].isAI ? 1 : 0));
    const passed = order.filter((s) => this.moves[s].pass);
    const strikes = [];

    for (const attackerSide of order) {
      if (this.moves[attackerSide].pass) continue;
      const defenderSide = attackerSide === 'left' ? 'right' : 'left';
      const attacker = this.sides[attackerSide];
      const defender = this.sides[defenderSide];
      if (attacker.hp <= 0 || defender.hp <= 0) continue;

      const zone = this.moves[attackerSide].attack;
      const blocked = this.moves[defenderSide].block === zone;
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
      strikes.push({ attacker: attackerSide, defender: defenderSide, zone,
        blocked, dodged, crit, damage, defenderHp: defender.hp,
        killed: defender.hp <= 0 });
      if (defender.hp <= 0) break;
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
