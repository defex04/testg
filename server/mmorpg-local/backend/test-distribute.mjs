// Юнит-проверка ТЗ #3: в неравном бою (1×N) одиночка распределяет урон по ВСЕМ
// врагам, а не молотит вечно одного. Чистая логика движка (без сети/БД).
// Запуск: docker exec mmo-api node /app/test-distribute.mjs
import { Engine } from './src/battle/engine.js';

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) failed++;
};

// Прогнать бой целиком как это делает manager: раунд → суб-ходы по инициативе →
// разыгрываем удар → дальше. Возвращает движок после N раундов (или конца боя).
function runBattle(engine, maxRounds = 40) {
  let rounds = 0;
  engine.startRound();
  while (rounds < maxRounds && !engine.finished()) {
    const af = engine.currentActor();
    if (!af) {
      const next = engine.advance();
      if (!next) { engine.startRound(); rounds++; }
      continue;
    }
    engine.submit(af.id, { attack: 'mid', block: 'low' });
    engine.resolveActive();
    engine.advance();
  }
  return engine;
}

const mk = (id, ini) => ({ id, name: id, level: 10, hp: 100000,
  damage: [10, 10], crit: 0, dodge: 0, initiative: ini, isAI: false });

// дефолтные параметры выбора цели (как на сервере)
const TARGET = { switchChance: 0.25, coldTurns: 2, coldWeight: 1.5 };

// 1) 1×2 — игрок слева, два врага справа. Оба должны получить урон.
{
  const e = new Engine({ left: [mk('P', 100)], right: [mk('E1', 90), mk('E2', 80)] },
    { turnTime: 20, target: TARGET });
  runBattle(e, 40);
  const e1 = e.fighter('E1'), e2 = e.fighter('E2');
  ok(e1.hp < e1.maxHp && e2.hp < e2.maxHp,
    '1×2: ОБА врага получили урон от одиночки',
    `E1=-${e1.maxHp - e1.hp} E2=-${e2.maxHp - e2.hp}`);
}

// 2) 1×3 — все три врага должны получить урон за разумное число раундов.
{
  const e = new Engine({ left: [mk('P', 100)],
    right: [mk('E1', 90), mk('E2', 80), mk('E3', 70)] }, { turnTime: 20, target: TARGET });
  runBattle(e, 60);
  const hit = ['E1', 'E2', 'E3'].filter((id) => e.fighter(id).hp < e.fighter(id).maxHp);
  ok(hit.length === 3, '1×3: урон достался ВСЕМ трём врагам', 'задеты=' + hit.join(','));
}

// 3) 2×1 — одиночка-враг тоже распределяет удары по обоим противникам.
{
  const e = new Engine({ left: [mk('A', 100), mk('B', 90)], right: [mk('X', 80)] },
    { turnTime: 20, target: TARGET });
  runBattle(e, 40);
  const a = e.fighter('A'), b = e.fighter('B');
  ok(a.hp < a.maxHp && b.hp < b.maxHp,
    '2×1: одиночка X задел ОБОИХ противников',
    `A=-${a.maxHp - a.hp} B=-${b.maxHp - b.hp}`);
}

console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки распределения пройдены');
process.exit(failed ? 1 : 0);
