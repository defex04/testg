/**
 * Проверка живого пути экипировки: реальные base_stats предметов должны складываться
 * в тот же школьный профиль, что и эталон composeBuild, а чужой класс вещей должен
 * переносить вклад шмота в чужие статы.
 */
import {
  composeBuild, composeFromEquipment, gearItemStats,
  GEAR_CLASSES, GEAR_PIECES, QUALITY_BY_RANK, POINTS_PER_LEVEL,
  GAME_SLOT_TO_TRI, SHIELD_SLOT, AMULET_SLOT,
} from './src/battle/gear.js';

const LEVELS = [1, 8, 15];
const CORE = GEAR_PIECES.filter(([, slot]) => slot !== SHIELD_SLOT && slot !== AMULET_SLOT);
const STAT_CHECK = ['health', 'accuracy', 'dodge', 'crit', 'critResist', 'defense', 'block', 'counter'];

const attrsFor = (cls, level) => ({
  str: cls === 'natisk' ? POINTS_PER_LEVEL * level : 0,
  agi: cls === 'uklon' ? POINTS_PER_LEVEL * level : 0,
  vit: cls === 'oplot' ? POINTS_PER_LEVEL * level : 0,
});

const itemsFor = (cls, level) => CORE.map(([, slot]) => ({
  slot,
  quality: 3,
  base_stats: { cls, ...gearItemStats(slot, { cls, level, quality: QUALITY_BY_RANK[2] }) },
}));

function near(a, b, pct = 0.025) {
  const d = Math.abs(Number(a) - Number(b));
  return d <= Math.max(2, Math.abs(Number(b)) * pct);
}

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) failed++;
};

for (const level of LEVELS) {
  for (const [cls, label] of GEAR_CLASSES) {
    const attrs = attrsFor(cls, level);
    const actual = composeFromEquipment(cls, { level, attrs, items: itemsFor(cls, level) }).stats;
    const expected = composeBuild(cls, {
      level,
      quality: 'blue',
      attrs,
      equipped: CORE.map(([, slot]) => GAME_SLOT_TO_TRI[slot]).filter(Boolean),
    }).stats;
    for (const key of STAT_CHECK) {
      ok(near(actual[key], expected[key]), `${label} ур.${level}: ${key}`, `${actual[key]} ~ ${expected[key]}`);
    }
    ok(near(actual.power, Math.round(expected.power * 1.10)), `${label} ур.${level}: power + двуручное`,
      `${actual.power} ~ ${Math.round(expected.power * 1.10)}`);
  }
}

const own = composeFromEquipment('natisk', { level: 8, attrs: attrsFor('natisk', 8), items: itemsFor('natisk', 8) }).stats;
const wrong = composeFromEquipment('natisk', { level: 8, attrs: attrsFor('natisk', 8), items: itemsFor('uklon', 8) }).stats;
ok(own.accuracy > wrong.accuracy, 'Натиск-вещи дают Натиску больше точности');
ok(wrong.dodge > own.dodge, 'Уклон-вещи реально несут уклонение даже на Натиске');

console.log(failed ? 'FAILED: ' + failed : 'ALL OK');
process.exit(failed ? 1 : 0);
