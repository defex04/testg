// Юнит-проверка движка: дуэльные пары 1-на-1 в мультибое (механика «Легенды»).
// Строго 1:1 (никого не бьют двое), лишние «ждут»; пары стабильны внутри эпохи и
// ротируются раз в N раундов; move.target для удара ИГНОРИРУЕТСЯ (цель решает
// сервер); при смерти соперника — пере-сватовство. Чистая логика — без сети/БД.
// Запуск: docker exec mmo-api node /app/test-facing.mjs
import { Engine } from './src/battle/engine.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) failed++;
};

const mk = (id, ini) => ({ id, name: id, level: 10, hp: 1000,
  damage: [10, 10], crit: 0, dodge: 0, initiative: ini, isAI: false });
// 3 на 2: A,B,C (слева, инициатива 100/90/80) против X,Y (справа, 70/60).
// pairRotate:1 → раскладка сдвигается каждый раунд (удобно проверять ротацию).
const newEngine = () => new Engine(
  { left: [mk('A', 100), mk('B', 90), mk('C', 80)], right: [mk('X', 70), mk('Y', 60)] },
  { turnTime: 20, pairRotate: { uneven: 1, even: 1 } });

const livingOpp = (e, id) => {
  const f = e.fighter(id); const o = f.opponentId ? e.fighter(f.opponentId) : null;
  return o && o.alive && o.side !== f.side ? o : null;
};
// взаимность пары: если у X соперник A, то у A соперник X
const mutual = (e, id) => {
  const o = livingOpp(e, id);
  return !!o && String(e.fighter(o.id).opponentId) === String(id);
};

// 1) Строго 1:1: меньшая сторона (X,Y) целиком во ВЗАИМНЫХ парах; никого не бьют двое.
const eP = newEngine();
eP.startRound();
ok(['X', 'Y'].every((id) => livingOpp(eP, id) && mutual(eP, id)),
  'меньшая сторона (2) разобрана по взаимным парам 1:1');
const targetsOfLeft = ['A', 'B', 'C'].map((id) => eP.fighter(id).opponentId).filter(Boolean);
ok(new Set(targetsOfLeft).size === targetsOfLeft.length,
  'никого из правых не бьют двое (нет дублей)', 'цели=' + targetsOfLeft.join(','));

// 2) Лишний слева «ждёт» (без соперника) — ровно один из A/B/C, и он не ходит.
const waiting = ['A', 'B', 'C'].filter((id) => !livingOpp(eP, id));
ok(waiting.length === 1, 'ровно один лишний боец «ждёт»', 'ждёт=' + waiting.join(','));
const actedIds = [];
let g0 = 0;
while (eP.currentActor() && g0++ < 30) {
  const af = eP.currentActor(); actedIds.push(af.id);
  eP.submit(af.id, { attack: 'mid', block: 'low' }); eP.resolveActive(); eP.advance();
}
ok(!actedIds.includes(waiting[0]), 'ждущий боец не ходит в этом раунде', 'ходили=' + actedIds.join(','));

// 3) move.target ИГНОРИРУЕТСЯ: удар идёт назначенной паре, а не выбранному врагу.
const eT = newEngine();
eT.startRound();
const cur = eT.currentActor();                 // первый по инициативе из тех, кто в паре
const myOpp = eT.fighter(cur.id).opponentId;
const otherEnemy = ['X', 'Y'].find((id) => id !== myOpp);
eT.submit(cur.id, { attack: 'high', block: 'mid', target: otherEnemy });   // «обман» цели
const r = eT.resolveActive();
ok(r.strikes.length === 1 && r.strikes[0].defenderId === myOpp,
  'удар пришёл назначенной паре, move.target проигнорирован',
  'pair=' + myOpp + ' hit=' + (r.strikes[0] && r.strikes[0].defenderId));

// 4) Ротация: за несколько раундов КАЖДЫЙ из A,B,C успевает подраться (ждущий чередуется).
const eR = newEngine();
const fought = new Set();
let g1 = 0;
for (let round = 0; round < 4 && !eR.finished(); round++) {
  eR.startRound();
  while (eR.currentActor() && g1++ < 60) {
    const af = eR.currentActor(); fought.add(af.id);
    eR.submit(af.id, { attack: 'mid', block: 'low' }); eR.resolveActive(); eR.advance();
  }
}
ok(['A', 'B', 'C'].every((id) => fought.has(id)),
  'за ротацию все левые бойцы вступали в бой (ждущий чередуется)',
  'дрались=' + [...fought].join(','));

// 4.5) Пары НЕ меняются ВНУТРИ раунда: ход (размен пары) не прерывается ротацией.
// Снимок целей сразу после startRound держится, пока идут все суб-ходы раунда —
// пере-сватовство (assignTargets) случается только в СЛЕДУЮЩЕМ startRound.
const eW = newEngine();
eW.startRound();
const snapTargets = () => ['A', 'B', 'C', 'X', 'Y']
  .map((id) => id + '->' + (eW.fighter(id).opponentId || '∅')).join(' ');
const before = snapTargets();
let stable = true, g2 = 0;
while (eW.currentActor() && g2++ < 30) {
  const af = eW.currentActor();
  eW.submit(af.id, { attack: 'mid', block: 'low' });
  eW.resolveActive();
  if (snapTargets() !== before) stable = false;   // пары дрогнули посреди раунда — баг
  eW.advance();
  if (snapTargets() !== before) stable = false;
}
ok(stable, 'пары стабильны ВНУТРИ раунда (ход не прерывается сменой соперника)',
  before);

// 5) При смерти соперника пара пере-сватывается на живого (никто не целит труп).
const eD = newEngine();
eD.startRound();
const X = eD.fighter('X'); X.alive = false; X.hp = 0;     // X погиб
eD.startRound();                                          // следующий раунд — пере-сватовство
ok(['A', 'B', 'C'].every((id) => eD.fighter(id).opponentId !== 'X'),
  'после смерти X никто не целит труп');
ok(livingOpp(eD, 'Y') && mutual(eD, 'Y'), 'оставшийся враг Y в живой взаимной паре');

// 6) Врагов не осталось — ensureOpponent честно возвращает null (без падений).
const eE = newEngine();
for (const id of ['X', 'Y']) { const f = eE.fighter(id); f.alive = false; f.hp = 0; }
ok(eE.ensureOpponent('A') === null, 'нет живых врагов → соперника нет (null)');

console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пар пройдены');
process.exit(failed ? 1 : 0);
