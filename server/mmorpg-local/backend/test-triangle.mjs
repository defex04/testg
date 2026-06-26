/**
 * Проверка баланса треугольника школ (Натиск ▸ Уклон ▸ Оплот) через настоящий
 * headless-симулятор (src/battle/sim.js). DB/Redis не нужны.
 *   node test-triangle.mjs
 * Ждём: цикл Натиск>Уклон>Оплот>Натиск (каждое ребро ~60–68%), зеркала ~50%,
 * винрейты СТАБИЛЬНЫ по уровням (нормировка состязательных шансов по уровню).
 * Плюс контроль «разброса по качеству»: оранж vs серый в зеркале — мягкий перевес.
 */
import { runSimulation } from './src/battle/sim.js';

const SCHOOLS = ['natisk', 'uklon', 'oplot'];
const NAME = { natisk: 'Натиск', uklon: 'Уклон', oplot: 'Оплот' };
const LEVELS = [1, 8, 15];
const BATTLES = 600;

async function duel(a, b, level, qa = 'blue', qb = 'blue') {
  const r = await runSimulation({
    battles: BATTLES, maxTurns: 400,
    left:  { count: 1, level, school: a, quality: qa, varPct: 0.05 },
    right: { count: 1, level, school: b, quality: qb, varPct: 0.05 },
  });
  return r.balance.winRateLeft; // % побед школы a (left)
}

for (const level of LEVELS) {
  console.log(`\n=== Уровень ${level} (винрейт строки против столбца, %) ===`);
  console.log(['        ', ...SCHOOLS.map((s) => NAME[s].padStart(8))].join(' '));
  for (const a of SCHOOLS) {
    const cells = [];
    for (const b of SCHOOLS) cells.push(String((a === b ? 50 : await duel(a, b, level)).toFixed(1)).padStart(8));
    console.log([NAME[a].padStart(8), ...cells].join(' '));
  }
}

console.log('\n=== Разброс по качеству (оранж vs серый, зеркало, 8 ур.) ===');
for (const s of SCHOOLS) {
  const wr = await duel(s, s, 8, 'orange', 'gray');
  console.log(`${NAME[s].padStart(8)}: оранж бьёт серый в ${wr.toFixed(1)}% (мягкий перевес — цвет решает мало)`);
}
