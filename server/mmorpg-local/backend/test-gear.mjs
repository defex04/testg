/**
 * Проверка генерации шмота + очков через симулятор (режим composeBuild).
 *   node test-gear.mjs
 * Ждём:
 *  A) полная сборка (все слоты, синее, очки вложены) воспроизводит треугольник;
 *  B) разброс по качеству ещё мягче (качество множит лишь шмот, не очки/базу);
 *  C) прогрессия: полный сет/очки бьют неполный и голого (вертикальная прокачка),
 *     при этом треугольник между РАВНО одетыми держится.
 */
import { runSimulation } from './src/battle/sim.js';

const SCHOOLS = ['natisk', 'uklon', 'oplot'];
const NAME = { natisk: 'Натиск', uklon: 'Уклон', oplot: 'Оплот' };
const BATTLES = 600;

// gear:{} → режим composeBuild (полная сборка по умолчанию)
async function duel(L, R, level = 8) {
  const r = await runSimulation({
    battles: BATTLES, maxTurns: 400,
    left:  { count: 1, level, varPct: 0.05, gear: {}, ...L },
    right: { count: 1, level, varPct: 0.05, gear: {}, ...R },
  });
  return r.balance.winRateLeft;
}

console.log('=== A. Полная сборка (шмот+очки): матрица по уровням ===');
for (const level of [1, 8, 15]) {
  console.log(`-- ур. ${level} --`);
  console.log(['        ', ...SCHOOLS.map((s) => NAME[s].padStart(8))].join(' '));
  for (const a of SCHOOLS) {
    const cells = [];
    for (const b of SCHOOLS) {
      const wr = a === b ? 50 : await duel({ school: a, quality: 'blue' }, { school: b, quality: 'blue' }, level);
      cells.push(String(wr.toFixed(1)).padStart(8));
    }
    console.log([NAME[a].padStart(8), ...cells].join(' '));
  }
}

console.log('\n=== B. Разброс по качеству (полный сет, оранж vs серый, зеркало, ур.8) ===');
for (const s of SCHOOLS) {
  const wr = await duel({ school: s, quality: 'orange' }, { school: s, quality: 'gray' });
  console.log(`${NAME[s].padStart(8)}: оранж бьёт серый ${wr.toFixed(1)}%`);
}

console.log('\n=== C. Прогрессия (зеркало Натиск, ур.8; «нормальный для уровня» vs недо-сборка) ===');
const normal = { school: 'natisk', quality: 'blue', gear: {} };           // эталон уровня
const naked = { school: 'natisk', quality: 'blue', gear: { equipped: [], allocFrac: 0 } };
const fewerPts = { school: 'natisk', quality: 'blue', gear: { allocFrac: 0.2 } };  // мало очков
const noWeapon = { school: 'natisk', quality: 'blue',
  gear: { equipped: ['legs', 'chest', 'boots', 'mail', 'bracers', 'shoulders', 'helmet'] } };
console.log(`нормальный vs голый:        ${(await duel(normal, naked)).toFixed(1)}%`);
console.log(`нормальный vs мало очков:   ${(await duel(normal, fewerPts)).toFixed(1)}%`);
console.log(`нормальный vs без оружия:   ${(await duel(normal, noWeapon)).toFixed(1)}%`);
