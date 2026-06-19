// Юнит-проверка движка: модель «пар» в мультибое (кто против кого).
// Пара фиксируется на раунд (buildPairs); удар идёт РОВНО паре, move.target
// для удара игнорируется; пары стабильны между раундами, но переназначаются при
// смерти соперника; в неравных командах никто не простаивает (дубль 2-в-1).
// Чистая логика — без сети/БД. Запуск: docker exec mmo-api node /app/test-facing.mjs
import { Engine } from './src/battle/engine.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) failed++;
};

// 3 на 2: A,B,C (слева) против X,Y (справа). switchChance:0 + coldTurns:99 →
// пары максимально СТАБИЛЬНЫ (детерминизм проверки); damage/ hp таковы, что за
// раунд никто не гибнет.
const mk = (id, ini) => ({ id, name: id, level: 10, hp: 1000,
  damage: [10, 10], crit: 0, dodge: 0, initiative: ini, isAI: false });
const newEngine = () => new Engine(
  { left: [mk('A', 100), mk('B', 90), mk('C', 80)], right: [mk('X', 70), mk('Y', 60)] },
  { turnTime: 20, target: { switchChance: 0, coldTurns: 99, coldWeight: 1 } });

const livingOpp = (e, id) => {
  const f = e.fighter(id); const o = f.opponentId ? e.fighter(f.opponentId) : null;
  return o && o.alive && o.side !== f.side ? o : null;
};

// 1) buildPairs: каждый живой боец получил ЖИВОГО соперника (никто не простаивает)
const eP = newEngine();
eP.startRound();
ok(['A', 'B', 'C', 'X', 'Y'].every((id) => livingOpp(eP, id)),
  'все бойцы получили живого соперника (никто не простаивает)');

// 2) неравные команды: какой-то враг «задвоен» (двое слева бьют одного справа)
const leftOpps = ['A', 'B', 'C'].map((id) => eP.fighter(id).opponentId);
ok(new Set(leftOpps).size < leftOpps.length, 'в 3 на 2 есть дубль (2-в-1)', 'цели=' + leftOpps.join(','));

// 3) первым ходит A (инициатива), удар идёт ПАРЕ; move.target игнорируется
const aOpp = eP.fighter('A').opponentId;
ok(eP.currentActorId() === 'A', 'первым ходит A (инициатива 100)');
const otherEnemy = ['X', 'Y'].find((id) => id !== aOpp);
eP.submit('A', { attack: 'high', block: 'mid', target: otherEnemy });  // «обман» цели
const r = eP.resolveActive();
ok(r.strikes.length === 1, 'ровно один удар за суб-ход (и только по одному)');
ok(r.strikes[0] && r.strikes[0].defenderId === aOpp,
  'удар пришёл паре, move.target проигнорирован', 'pair=' + aOpp + ' hit=' + (r.strikes[0] && r.strikes[0].defenderId));

// 4) пара стабильна в следующем раунде (switchChance 0, оба живы)
eP.advance();
let guard = 0;
while (eP.currentActor() && guard++ < 30) {
  const af = eP.currentActor();
  eP.submit(af.id, { attack: 'mid', block: 'low' });
  eP.resolveActive(); eP.advance();
}
eP.startRound();
ok(eP.fighter('A').opponentId === aOpp, 'пара A↔' + aOpp + ' стабильна в следующем раунде');

// 5) при смерти соперника пара переназначается на живого (никто не целит труп)
const eD = newEngine();
eD.startRound();
const X = eD.fighter('X'); X.alive = false; X.hp = 0;     // X погиб
eD.startRound();                                          // раунд 2 — пере-сватовство
ok(['A', 'B', 'C'].every((id) => eD.fighter(id).opponentId !== 'X'),
  'после смерти X никто не целит труп');
ok(livingOpp(eD, 'A'), 'A переключился на живого врага');

// 6) врагов не осталось — ensureOpponent честно возвращает null (без падений)
const eE = newEngine();
for (const id of ['X', 'Y']) { const f = eE.fighter(id); f.alive = false; f.hp = 0; }
ok(eE.ensureOpponent('A') === null, 'нет живых врагов → соперника нет (null)');

console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пар пройдены');
process.exit(failed ? 1 : 0);
