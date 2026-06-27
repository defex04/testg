import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAT_META } from '../src/battle/stats.js';
import {
  GEAR_CLASSES, GEAR_LEVELS, GEAR_PIECES, QUALITY_BY_RANK,
  POINTS_PER_LEVEL, composeBuild, gearItemStats, sumItemStatBonuses,
} from '../src/battle/gear.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../docs/balance-1-15.md');
const STATS = STAT_META.map((m) => [m.key, m.label]);

function attrsFor(cls, level) {
  const points = POINTS_PER_LEVEL * level;
  return {
    str: cls === 'natisk' ? points : 0,
    agi: cls === 'uklon' ? points : 0,
    vit: cls === 'oplot' ? points : 0,
  };
}

function statCells(stats) {
  return STATS.map(([key]) => String(Math.round(Number(stats[key]) || 0)));
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function characterRows() {
  const rows = [];
  for (const level of GEAR_LEVELS) {
    for (const [cls, label] of GEAR_CLASSES) {
      const built = composeBuild(cls, {
        level,
        quality: 'blue',
        attrs: attrsFor(cls, level),
      });
      rows.push([level, label, ...statCells(built.stats)]);
    }
  }
  return rows;
}

function itemSetRows() {
  const rows = [];
  for (const level of GEAR_LEVELS) {
    for (const [cls, label] of GEAR_CLASSES) {
      const items = GEAR_PIECES.map(([, slot]) => ({
        base_stats: {
          cls,
          ...gearItemStats(slot, { cls, level, quality: QUALITY_BY_RANK[2] }),
        },
      }));
      const stats = sumItemStatBonuses(items) || {};
      rows.push([level, label, ...statCells(stats)]);
    }
  }
  return rows;
}

function pieceRows(level) {
  const rows = [];
  for (const [cls, label] of GEAR_CLASSES) {
    for (const [piece, slot] of GEAR_PIECES) {
      const stats = gearItemStats(slot, { cls, level, quality: QUALITY_BY_RANK[2] });
      rows.push([level, label, piece, ...statCells(stats)]);
    }
  }
  return rows;
}

const headers = ['Ур.', 'Класс', ...STATS.map(([, label]) => label)];
const pieceHeaders = ['Ур.', 'Класс', 'Предмет', ...STATS.map(([, label]) => label)];
const md = [
  '# Баланс классов и вещей 1-15',
  '',
  'Цифры сгенерированы из `src/battle/gear.js` и `src/battle/stats.js`, поэтому таблица совпадает с расчетами боя и магазина.',
  '',
  '## Персонажи',
  '',
  table(headers, characterRows()),
  '',
  '## Вещи',
  '',
  'Сумма синего комплекта из 10 слотов: 8 основных вещей, щит и амулет. В каждой строке есть общий скелет предметов и школьные статы класса вещи.',
  '',
  table(headers, itemSetRows()),
  '',
  '## Примеры предметов',
  '',
  'Синие предметы на контрольных уровнях 1, 8 и 15.',
  '',
  table(pieceHeaders, [1, 8, 15].flatMap(pieceRows)),
  '',
].join('\n');

if (process.argv.includes('--write')) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, md, 'utf8');
  console.log(OUT);
} else {
  console.log(md);
}
