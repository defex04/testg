/**
 * Проверка сборки из РЕАЛЬНОЙ экипировки (composeFromEquipment): слоты игры → статы,
 * щит → +блок/защита −Мощь, голый слабее полного сета. Плюс бой полный vs голый.
 *   node test-gear-equip.mjs
 */
import { composeFromEquipment } from './src/battle/gear.js';
import { Engine } from './src/battle/engine.js';
import { makeModel } from './src/battle/stats.js';

const model = makeModel();
const LEVEL = 8;
// игровые слоты: 1 торс,2 шлем,3 ноги,4 сапоги,5 перчатки,6 плечи,7 оружие,9 пояс; 8 щит
const FULL = [1, 2, 3, 4, 5, 6, 7, 9].map((slot) => ({ slot, quality: 3 }));   // синий
const SHIELD = [...FULL.filter((i) => i.slot !== 7), { slot: 7, quality: 3 }, { slot: 8, quality: 3 }];

const naked = composeFromEquipment('natisk', { level: LEVEL, items: [] });
const full = composeFromEquipment('natisk', { level: LEVEL, items: FULL });
const shield = composeFromEquipment('oplot', { level: LEVEL, items: SHIELD });
const oplotNoShield = composeFromEquipment('oplot', { level: LEVEL, items: FULL });

const pick = (b) => ({ power: b.stats.power, hp: b.stats.health, acc: b.stats.accuracy,
  block: b.stats.block, def: b.stats.defense, equipped: b.equippedCount, shield: b.shield });
console.log('Натиск голый: ', pick(naked));
console.log('Натиск полный:', pick(full));
console.log('Оплот без щита:', pick(oplotNoShield));
console.log('Оплот со щитом:', pick(shield));

// бой полный vs голый (зеркало Натиск) — экипировка должна решать
function def(id, name, b, ini) {
  return { id, charId: id, name, level: LEVEL, isAI: false,
    hp: b.stats.health, stats: b.stats, statNorm: b.statNorm, damage: [1, 1], mp: 0, maxMp: 100, initiative: ini };
}
let wins = 0; const N = 300;
for (let k = 0; k < N; k++) {
  const e = new Engine({ left: [def('a', 'Полный', full, 110)], right: [def('b', 'Голый', naked, 110)] },
    { turnTime: 20, model });
  let actor = e.startRound(), guard = 0;
  while (actor && e.turn <= 400 && !e.finished()) {
    const af = e.currentActor();
    if (af) { e.submit(af.id, e.aiMove()); e.resolveActive(); }
    let nx = e.advance(); if (!nx) { if (e.finished()) break; nx = e.startRound(); }
    actor = nx; if (++guard > 200000) break;
  }
  if (e.aliveOf('left').length && !e.aliveOf('right').length) wins++;
}

const ok = full.stats.power > naked.stats.power
  && shield.stats.block > oplotNoShield.stats.block
  && shield.stats.power < oplotNoShield.stats.power
  && wins / N > 0.85;
console.log(`\nПолный бьёт голого: ${(wins / N * 100).toFixed(1)}% (N=${N})`);
console.log(`ИТОГ: ${ok ? 'OK — экипировка решает, щит танковее' : 'ПРОВЕРИТЬ'}`);
process.exit(ok ? 0 : 1);
