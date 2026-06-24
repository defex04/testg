// Юнит-проверка механики дуэлей (ЛоД) в неравном бою (1×N / N×1):
//  - строго 1:1 — одиночку за раунд бьёт лишь ОДИН враг (остальные «ждут»);
//  - за ротацию пар одиночка успевает подраться с КАЖДЫМ врагом (никто не «забыт»).
// Чистая логика движка (без сети/БД). Запуск: docker exec mmo-api node /app/test-distribute.mjs
import { Engine } from './src/battle/engine.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) failed++;
};

const mk = (id, ini) => ({ id, name: id, level: 10, hp: 100000,
  damage: [10, 10], crit: 0, dodge: 0, initiative: ini, isAI: false });

// Прогнать rounds раундов. Возвращает: с кем одиночка (soloId) дрался и сколько
// РАЗНЫХ врагов били его в один раунд (для проверки строгого 1:1).
function run(engine, soloId, rounds) {
  const foughtBySolo = new Set();   // кого бил одиночка
  let maxHitSolo = 0;               // максимум разных врагов, ударивших одиночку за раунд
  let g = 0;
  for (let r = 0; r < rounds && !engine.finished(); r++) {
    engine.startRound();
    const attackers = new Set();
    while (engine.currentActor() && g++ < 200) {
      const af = engine.currentActor();
      const oppId = af.opponentId;
      if (af.id === soloId && oppId) foughtBySolo.add(oppId);
      if (oppId === soloId) attackers.add(af.id);            // af бьёт одиночку
      engine.submit(af.id, { attack: 'mid', block: 'low' });
      engine.resolveActive();
      engine.advance();
    }
    maxHitSolo = Math.max(maxHitSolo, attackers.size);
  }
  return { foughtBySolo, maxHitSolo };
}

const opts = { turnTime: 20, pairRotate: { uneven: 1, even: 1 } };

// 1) 1×2: одиночку P за раунд бьёт максимум ОДИН враг; за ротацию P дерётся с обоими.
{
  const e = new Engine({ left: [mk('P', 100)], right: [mk('E1', 90), mk('E2', 80)] }, opts);
  const { foughtBySolo, maxHitSolo } = run(e, 'P', 6);
  ok(maxHitSolo <= 1, '1×2: одиночку за раунд бьёт максимум ОДИН враг (строго 1:1)',
    'макс. атакующих за раунд=' + maxHitSolo);
  ok(foughtBySolo.has('E1') && foughtBySolo.has('E2'),
    '1×2: за ротацию P подрался с ОБОИМИ врагами', 'дрался с=' + [...foughtBySolo].join(','));
}

// 2) 2×1: одиночка-враг X тоже по очереди дерётся с обоими противниками A,B.
{
  const e = new Engine({ left: [mk('A', 100), mk('B', 90)], right: [mk('X', 80)] }, opts);
  const { foughtBySolo, maxHitSolo } = run(e, 'X', 6);
  ok(maxHitSolo <= 1, '2×1: одиночку X за раунд бьёт максимум ОДИН (строго 1:1)',
    'макс. атакующих за раунд=' + maxHitSolo);
  ok(foughtBySolo.has('A') && foughtBySolo.has('B'),
    '2×1: за ротацию X подрался с ОБОИМИ', 'дрался с=' + [...foughtBySolo].join(','));
}

// 3) 1×3: за ротацию одиночка достаёт всех трёх врагов (никто не «забыт»).
{
  const e = new Engine({ left: [mk('P', 100)],
    right: [mk('E1', 90), mk('E2', 80), mk('E3', 70)] }, opts);
  const { foughtBySolo } = run(e, 'P', 8);
  ok(['E1', 'E2', 'E3'].every((id) => foughtBySolo.has(id)),
    '1×3: за ротацию P подрался со ВСЕМИ тремя', 'дрался с=' + [...foughtBySolo].join(','));
}

console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки дуэлей пройдены');
process.exit(failed ? 1 : 0);
