// Контратака в живом бою (без модели): немедленный рипост, без направления.
import assert from 'assert';
import { Engine } from './src/battle/engine.js';

const mk = (counterChance) => new Engine({
  left:  [{ id: 'P', name: 'P', hp: 1000, damage: [20, 20], crit: 0, dodge: 0, initiative: 10 }],
  right: [{ id: 'E', name: 'E', hp: 1000, damage: [30, 30], crit: 0, dodge: 0, initiative: 5 }],
}, { turnTime: 20, counterChance });

let n = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' | ' + m); if (!c) n++; };

// 1. counterChance=1: после удара активного бойца цель сразу контратакует (2 удара в sub-turn)
{
  const e = mk(1); e.startRound();           // P ходит первым (initiative 10)
  e.submit('P', { attack: 'high', block: 'high' });
  const r = e.resolveActive();
  ok(r.strikes.length === 2, 'два удара в одном sub-turn (удар + контратака): ' + r.strikes.length);
  ok(r.strikes[0].attackerId === 'P' && !r.strikes[0].counter, 'первый — удар P');
  ok(r.strikes[1].attackerId === 'E' && r.strikes[1].counter === true, 'второй — контратака E сразу за ударом');
  ok(r.strikes[1].zone == null, 'у контратаки нет направления (zone=null): ' + r.strikes[1].zone);
}

// 2. Контратаку нельзя заблокировать по зоне (направления нет), хотя цель в блоке
{
  const e = mk(1); e.startRound();
  // P бьёт high; E поставил блок high — но это блок ПРОТИВ удара P (по нему), а
  // контратаку E делает САМ, её P блокировать зоной не может: проверяем, что
  // контратака не помечена blocked из-за совпадения зон.
  e.fighter('P').block = 'high';
  e.submit('P', { attack: 'high', block: 'high' });
  const r = e.resolveActive();
  const counter = r.strikes.find((s) => s.counter);
  ok(counter && counter.blocked === false, 'контратака не блокируется по зоне: blocked=' + counter?.blocked);
  ok(counter && counter.damage === 30, 'контратака бьёт полным уроном (30): ' + counter?.damage);
}

// 3. counterChance=0: контратаки нет (поведение симулятора/тестов не изменилось)
{
  const e = mk(0); e.startRound();
  e.submit('P', { attack: 'mid', block: 'mid' });
  const r = e.resolveActive();
  ok(r.strikes.length === 1 && !r.strikes[0].counter, 'без шанса контратаки — один удар: ' + r.strikes.length);
}

// 4. Контратака НЕ тратит «Эликсир мощи» цели (копится для её удара)
{
  const e = mk(1); e.startRound();
  e.addBuff('E', 1.5, 3);                     // у E мощь на 3 удара
  e.submit('P', { attack: 'low', block: 'low' });
  e.resolveActive();
  ok(e.fighter('E').buffTurns === 3, 'мощь цели не израсходована контратакой: ' + e.fighter('E').buffTurns);
}

console.log(n === 0 ? '\ntest-counter: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\ntest-counter: ПРОВАЛЕНО (${n})`);
process.exit(n === 0 ? 0 : 1);
