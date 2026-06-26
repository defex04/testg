/**
 * Smoke-проверка подключения модели к бою (без БД): собираем бойцов в ТОЙ ЖЕ форме,
 * что строит manager.playerDef/withNpcModel (combatModelFor = composeBuild), создаём
 * Engine С МОДЕЛЬЮ и прогоняем бой до конца. Ждём: бой завершается победителем,
 * модель активна (встречаются crit/blocked/counter), исключений нет.
 *   node test-live-wiring.mjs
 */
import { Engine } from './src/battle/engine.js';
import { makeModel } from './src/battle/stats.js';
import { composeBuild } from './src/battle/gear.js';

const model = makeModel();

// как combatModelFor: школа → нормальная сборка уровня; форма дефа — как в manager
function playerDef(id, name, school, level, initiative) {
  const b = composeBuild(school, { level });
  return { id, charId: id, name, level, isAI: false,
    hp: b.stats.health, stats: b.stats, statNorm: b.statNorm, school,
    damage: [1, 1], mp: 0, maxMp: 100, initiative };
}
// как withNpcModel: NPC с ai*-полями + модельные статы
function npcDef(id, name, school, level) {
  const b = composeBuild(school, { level });
  return { id, name, level, isAI: true,
    hp: b.stats.health, stats: b.stats, statNorm: b.statNorm,
    damage: [1, 1], crit: 0.1, dodge: 0.05, aiPowerUses: 1, aiPowerMult: 1.4, aiPowerTurns: 3 };
}

function run(left, right, label) {
  const engine = new Engine({ left, right }, { turnTime: 20, model });
  let actor = engine.startRound();
  let crit = 0, blocked = 0, counter = 0, strikes = 0, guard = 0;
  while (actor && engine.turn <= 300 && !engine.finished()) {
    const af = engine.currentActor();
    if (af) {
      engine.submit(af.id, engine.aiMove());
      const r = engine.resolveActive();
      for (const s of r.strikes) { strikes++; if (s.crit) crit++; if (s.blocked) blocked++; if (s.counter) counter++; }
    }
    let next = engine.advance();
    if (!next) { if (engine.finished()) break; next = engine.startRound(); }
    actor = next;
    if (++guard > 200000) { console.log('GUARD'); break; }
  }
  const winner = engine.aliveOf('left').length && !engine.aliveOf('right').length ? 'left'
    : engine.aliveOf('right').length && !engine.aliveOf('left').length ? 'right' : null;
  console.log(`${label}: winner=${winner ?? 'ничья'} turns=${engine.turn} strikes=${strikes} crit=${crit} blocked=${blocked} counter=${counter}`);
  return { winner, strikes, modelActive: crit + blocked + counter > 0 };
}

console.log('=== PvP (обе стороны игроки, модель активна обеими) ===');
const a = run(
  [playerDef('p1', 'Натиск-боец', 'natisk', 8, 110)],
  [playerDef('p2', 'Уклон-боец', 'uklon', 8, 120)], 'PvP Натиск vs Уклон');

console.log('\n=== Охота (игрок vs NPC, оба с модельными статами) ===');
const h = run(
  [playerDef('p1', 'Игрок', 'natisk', 8, 110)],
  [npcDef('npc1', 'Разбойник', 'oplot', 8)], 'Hunt Натиск vs NPC-Оплот');

const ok = a.winner && a.modelActive && h.winner && h.modelActive;
console.log(`\nИТОГ: ${ok ? 'OK — бой завершается, модель активна' : 'ПРОВЕРИТЬ — что-то не сошлось'}`);
process.exit(ok ? 0 : 1);
