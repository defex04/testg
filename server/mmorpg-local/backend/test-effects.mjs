// Юнит-тест нового слоя эффектов движка: HoT/DoT по времени, мана, крит-баф, очищение.
// Гонять в контейнере: docker cp test-effects.mjs mmo-api:/app/ && docker exec mmo-api node /app/test-effects.mjs
import assert from 'assert';
import { Engine } from './src/battle/engine.js';

const mk = () => new Engine({
  left:  [{ id: 'A', name: 'A', hp: 1000, mp: 0, maxMp: 100, damage: [100, 100], crit: 0, dodge: 0 }],
  right: [{ id: 'B', name: 'B', hp: 1000, damage: [100, 100], crit: 0, dodge: 0 }],
}, { turnTime: 20 });

// Эффекты применяются ДИСКРЕТНЫМИ равными шагами каждые periodMs (по умолч. 5000),
// длительность делится на целое число тиков. Поэтому в тестах период задаём явно.

// 1. Лечение по времени (HoT): дробно по тикам, доигрывает до total
{
  const e = mk(); const A = e.fighter('A'); A.hp = 500;
  e.addOverTime('A', 'health', 300, 6000, null, false, 0, 3000); // 2 тика по 150
  e.tickEffects(3000);
  assert(Math.abs(A.hp - 650) < 1, 'HoT половина: ' + A.hp);
  e.tickEffects(3000);
  assert(Math.abs(A.hp - 800) < 1, 'HoT полностью: ' + A.hp);
  assert(A.effects.length === 0, 'HoT эффект снят после доигрыша');
}

// 2. HoT не выше maxHp
{
  const e = mk(); const A = e.fighter('A'); A.hp = 950;
  e.addOverTime('A', 'health', 300, 3000, null, false, 0, 3000);
  e.tickEffects(3000);
  assert(A.hp === 1000, 'HoT не превышает maxHp: ' + A.hp);
}

// 3. Яд (DoT) снимает % и может убить, смерть рапортуется
{
  const e = mk(); const B = e.fighter('B'); B.hp = 100;
  e.addOverTime('B', 'poison', 300, 3000, null, false, 0, 1500); // 2 тика по 150
  const r = e.tickEffects(1500);          // первый тик −150 → 0
  assert(!B.alive, 'яд убивает');
  assert(r.deaths.includes('B'), 'смерть от яда в списке');
}

// 3b. Дискретные тики «как часы»: между тиками HP не меняется (#3)
{
  const e = mk(); const A = e.fighter('A'); A.hp = 100;
  e.addOverTime('A', 'health', 400, 20000, null, false, 0, 5000); // 4 тика по 100
  e.tickEffects(5000); assert(A.hp === 200, 'тик 1: ' + A.hp);
  e.tickEffects(2000); assert(A.hp === 200, 'между тиками без изменений: ' + A.hp);
  e.tickEffects(3000); assert(A.hp === 300, 'тик 2 на 10с: ' + A.hp);
  e.tickEffects(10000); assert(A.hp === 500 && A.effects.length === 0, 'добор до конца: ' + A.hp);
}

// 4. Восстановление маны по времени
{
  const e = mk(); const A = e.fighter('A'); A.mp = 0;
  e.addOverTime('A', 'mana', 50, 5000);
  e.tickEffects(5000);
  assert(Math.abs(A.mp - 50) < 1, 'мана восстановлена: ' + A.mp);
}

// 5. Крит-баф («Эликсир крови»): поднимает шанс на 1 ход и гаснет
{
  const e = mk(); const A = e.fighter('A'); A.crit = 0;
  e.addCritBuff('A', 1.0, 1);             // +100 п.п. → гарантированный крит
  const s1 = e._strike(A, e.fighter('B'), 'high');
  assert(s1.crit === true, 'крит-баф форсит крит');
  assert(A.critBuffTurns === 0, 'крит-баф потрачен за ход');
  const s2 = e._strike(A, e.fighter('B'), 'high');
  assert(s2.crit === false, 'крит-баф больше не действует');
}

// 6. Очищение снимает яд и исцеление, но не трогает эликсир жизни/маны
{
  const e = mk(); const A = e.fighter('A');
  e.addOverTime('A', 'poison', 100, 5000);
  e.addOverTime('A', 'heal_scroll', 100, 5000);
  e.addOverTime('A', 'health', 100, 5000);
  e.addOverTime('A', 'mana', 100, 5000);
  const removed = e.cleanse('A', ['poison', 'heal_scroll']);
  assert(removed.includes('poison') && removed.includes('heal_scroll'), 'очищение сняло яд/исцеление');
  const kinds = A.effects.map((x) => x.kind).sort().join(',');
  assert(kinds === 'health,mana', 'очищение сохранило жизнь/ману: ' + kinds);
}

// 7. Тот же вид эффекта рефрешится (без стопок)
{
  const e = mk(); const A = e.fighter('A'); A.hp = 500;
  e.addOverTime('A', 'health', 100, 4000, null, false, 0, 2000);
  e.tickEffects(2000);                    // +50
  e.addOverTime('A', 'health', 200, 4000, null, false, 0, 2000); // рефреш: новый эффект 200/4000
  assert(A.effects.filter((x) => x.kind === 'health').length === 1, 'health не дублируется');
}

// 8. Свитки СТАКАЮТСЯ (stack=true), эликсиры — нет (stack=false)
{
  const e = mk(); const B = e.fighter('B'); B.hp = 1000;
  e.addOverTime('B', 'poison', 100, 5000, 'A', true);
  e.addOverTime('B', 'poison', 100, 5000, 'C', true);   // второй источник яда
  assert(B.effects.filter((x) => x.kind === 'poison').length === 2, 'два яда стакаются');
  e.tickEffects(5000);
  assert(Math.abs(B.hp - 800) < 1, 'оба яда сняли по 100 (итого 200): ' + B.hp);
  // health (эликсир) НЕ стакается
  const A = e.fighter('A');
  e.addOverTime('A', 'health', 100, 5000, 'A', false);
  e.addOverTime('A', 'health', 100, 5000, 'A', false);
  assert(A.effects.filter((x) => x.kind === 'health').length === 1, 'эликсир жизни не стакается');
}

// 9. Атрибуция яда: урон и скальп засчитываются ИСТОЧНИКУ (srcId), #1
{
  const e = mk(); const B = e.fighter('B'); B.hp = 100;
  e.addOverTime('B', 'poison', 300, 3000, 'A', true, 0, 1500); // источник — A, 2 тика по 150
  const r = e.tickEffects(1500);                          // 150, но HP только 100 → dealt=100
  assert(r.damageBySrc.get('A') === 100, 'урон ядом засчитан A: ' + r.damageBySrc.get('A'));
  assert(r.kills.length === 1 && r.kills[0].killerId === 'A' && r.kills[0].victimId === 'B',
    'скальп B за A');
}

// 10. Два источника яда — каждому свой урон в статистику
{
  const e = mk(); const B = e.fighter('B'); B.hp = 1000;
  e.addOverTime('B', 'poison', 100, 5000, 'A', true);
  e.addOverTime('B', 'poison', 100, 5000, 'C', true);
  const r = e.tickEffects(5000);
  assert(r.damageBySrc.get('A') === 100 && r.damageBySrc.get('C') === 100,
    'оба источника по 100: A=' + r.damageBySrc.get('A') + ' C=' + r.damageBySrc.get('C'));
}

// 11. dHp — чистое изменение HP от эффекта за тик (для всплывашек, #2)
{
  const e = mk(); const A = e.fighter('A'); A.hp = 500;
  e.addOverTime('A', 'health', 300, 6000, 'A', false, 0, 3000); // 2 тика по 150
  const r = e.tickEffects(3000);
  const me = r.changed.find((f) => f.id === 'A');
  assert(Math.abs(me._effDelta - 150) < 1, 'dHp лечения за тик ≈ +150: ' + me._effDelta);
  // удар (минус HP вне эффектов) НЕ должен попасть в dHp следующего тика
  A.hp -= 200;                                            // имитируем удар между тиками
  const r2 = e.tickEffects(3000);                         // долечивает оставшиеся 150
  const me2 = r2.changed.find((f) => f.id === 'A');
  assert(me2._effDelta > 0 && me2._effDelta <= 160, 'dHp учитывает только эффект, не удар: ' + me2._effDelta);
}

console.log('test-effects: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ (12/12)');
