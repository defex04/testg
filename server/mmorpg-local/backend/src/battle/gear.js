/**
 * Генерация шмота и сборка билда для треугольника «Натиск ▸ Уклон ▸ Оплот».
 *
 * Характеристики бойца СКЛАДЫВАЮТСЯ из трёх источников, и все они ПРОПОРЦИОНАЛЬНЫ
 * профилю школы (идентичность угла есть с 1 уровня, шмот/очки растят лишь ВЕЛИЧИНУ):
 *   contested = profile × (BASE_FRAC + GEAR_FRAC·надетость·качество + POINTS_FRAC·вложенность) × lf
 *   health    = profile.health × (HP_BASE + (1−HP_BASE)·надетость доспеха) × lf
 *   power     = profile.power  × (POW_BASE + (1−POW_BASE)·есть оружие) × lf
 *   % (Сила Крита / Блок урона) — как в профиле; качество множит лишь ШМОТ.
 *
 * Нормировка состязательных шансов идёт по ОЖИДАЕМОЙ укомплектованности уровня
 * (refCompleteness: сколько слотов открыто + сколько очков накоплено к этому ур.).
 * Поэтому НОРМАЛЬНО прокачанный боец на ЛЮБОМ уровне даёт ОДИН И ТОТ ЖЕ резкий
 * треугольник, а недо-экипированный/недо-вложенный честно слабее (вертикалка).
 *
 * Это «генерация в модели»: к БД/живому бою пока НЕ подключено (гоняется симулятором).
 */
import { STAT_META, STAT_DEFAULTS, SCHOOLS, QUALITY_MULT, CONTESTED, levelFactor, gearTier, DEFAULT_COEF }
  from './stats.js';

// Слоты и расписание открытия (под-уровень внутри 5-уровневого цикла; тир = ⌈lvl/5⌉).
// armor — даёт HP; weapon — даёт Мощь; contested — несут все слоты (тематика школы).
export const SLOTS = [
  { key: 'legs',      label: 'Поножи',   sub: 1, kind: 'armor'  },
  { key: 'chest',     label: 'Куртка',   sub: 1, kind: 'armor'  },
  { key: 'weapon',    label: 'Оружие',   sub: 2, kind: 'weapon' },
  { key: 'boots',     label: 'Ботинки',  sub: 3, kind: 'armor'  },
  { key: 'mail',      label: 'Кольчуга', sub: 3, kind: 'armor'  },
  { key: 'bracers',   label: 'Наручи',   sub: 4, kind: 'armor'  },
  { key: 'shoulders', label: 'Плечи',    sub: 4, kind: 'armor'  },
  { key: 'helmet',    label: 'Шлем',     sub: 5, kind: 'armor'  },
];
export const SLOT_KEYS = SLOTS.map((s) => s.key);
const ARMOR_KEYS = SLOTS.filter((s) => s.kind === 'armor').map((s) => s.key);
const N_SLOTS = SLOT_KEYS.length;

/** Слоты, открытые к уровню level (по под-расписанию, повторяется каждые 5 ур.). */
export function unlockedSlots(level) {
  const sub = ((Math.max(1, Number(level) || 1) - 1) % 5) + 1;  // 1..5 внутри тира
  const tier = gearTier(level);
  // в текущем тире открыты слоты с sub ≤ под-уровень; из прошлых тиров — все
  return SLOTS.filter((s) => tier > 1 || s.sub <= sub).map((s) => s.key);
}

// Доли источников состязательного слоя (сумма = 1) и базовые доли скелета.
const BASE_FRAC = 0.15, GEAR_FRAC = 0.45, POINTS_FRAC = 0.40;
const HP_BASE = 0.30, POW_BASE = 0.35;
export const POINTS_PER_LEVEL = 10;
const MAX_LEVEL = 15;
/** Накоплено очков к уровню (10/ур). */
export const pointsForLevel = (level) => POINTS_PER_LEVEL * Math.max(1, Number(level) || 1);
/** Ожидаемая доля вложенных очков к уровню (1.0 на максимуме). */
export const expectedAllocFrac = (level) => Math.min(1, Math.max(0, (Number(level) || 1) / MAX_LEVEL));

// Вес слота в HP (сумма по всем доспехам = 1): нательное больше, мелочёвка меньше.
const HP_WEIGHT = { legs: 0.15, chest: 0.22, boots: 0.08, mail: 0.22, bracers: 0.08, shoulders: 0.12, helmet: 0.13 };

/**
 * Ожидаемая укомплектованность нормально прокачанного бойца на уровне level:
 * BASE + GEAR·(доля открытых слотов) + POINTS·(доля накопленных очков). Это эталон
 * для нормировки шансов (statNorm = refCompleteness·lf).
 */
export function refCompleteness(level) {
  const equippedFrac = unlockedSlots(level).length / N_SLOTS;
  return BASE_FRAC + GEAR_FRAC * equippedFrac + POINTS_FRAC * expectedAllocFrac(level);
}

/**
 * Вклад одного предмета (slot) школы/качества на уровне — для генерации/инспекции.
 * Состязательный слой: profile·GEAR_FRAC·(1/N)·качество·lf. Скелет: оружие — Мощь,
 * доспех — HP (по весу слота); качество скелет не трогает.
 */
export function genItem(slotKey, { school = 'natisk', level = 1, quality = 'blue', growth = DEFAULT_COEF.levelGrowth } = {}) {
  const slot = SLOTS.find((s) => s.key === slotKey);
  if (!slot) throw new Error(`unknown slot: ${slotKey}`);
  const s = SCHOOLS[school] || SCHOOLS.natisk;
  const lf = levelFactor(level, growth);
  const q = QUALITY_MULT[quality] ?? 1;
  const stats = {};
  for (const key of CONTESTED) {
    const v = (s[key] ?? STAT_DEFAULTS[key]) * GEAR_FRAC * (1 / N_SLOTS) * q * lf;
    if (v >= 0.5) stats[key] = Math.round(v);
  }
  if (slot.kind === 'weapon') {
    stats.power = Math.round((s.power ?? 0) * (1 - POW_BASE) * lf);
  } else {
    stats.health = Math.round((s.health ?? 0) * (1 - HP_BASE) * (HP_WEIGHT[slotKey] || 0) * lf);
  }
  return { slot: slotKey, label: slot.label, tier: gearTier(level), quality, school, stats };
}

/**
 * Собрать боевой блок (14 статов) из базы + шмота + очков. По умолчанию — НОРМАЛЬНО
 * прокачанный для уровня боец (надеты открытые слоты, очки вложены по графику).
 *  - equipped: какие слоты надеты (по умолчанию — открытые к уровню);
 *  - allocFrac: доля вложенных очков [0..1] (по умолчанию — ожидаемая для уровня);
 *  - quality: качество шмота (множит только состязательный слой шмота).
 * statNorm = refCompleteness(level)·lf — нормальный билд даёт профильные шансы.
 */
export function composeBuild(school, {
  level = 1, quality = 'blue', equipped = null, allocFrac = null, growth = DEFAULT_COEF.levelGrowth,
} = {}) {
  const s = SCHOOLS[school] || SCHOOLS.natisk;
  const lf = levelFactor(level, growth);
  const q = QUALITY_MULT[quality] ?? 1;
  const slots = new Set(equipped || unlockedSlots(level));
  const alloc = allocFrac == null ? expectedAllocFrac(level) : Math.min(1, Math.max(0, allocFrac));
  const equippedFrac = slots.size / N_SLOTS;
  const hpFrac = ARMOR_KEYS.reduce((a, k) => a + (slots.has(k) ? (HP_WEIGHT[k] || 0) : 0), 0);
  const hasWeapon = slots.has('weapon');

  const out = {};
  for (const m of STAT_META) {
    const key = m.key;
    if (m.pct) { out[key] = s[key] ?? STAT_DEFAULTS[key]; continue; }       // % — как в профиле
    if (CONTESTED.includes(key)) {
      const frac = BASE_FRAC + GEAR_FRAC * equippedFrac * q + POINTS_FRAC * alloc;
      out[key] = Math.max(1, Math.round((s[key] ?? STAT_DEFAULTS[key]) * frac * lf));
      continue;
    }
    if (key === 'power') {
      out.power = Math.max(1, Math.round((s.power ?? 0) * (POW_BASE + (1 - POW_BASE) * (hasWeapon ? 1 : 0)) * lf));
      continue;
    }
    if (key === 'health') {
      out.health = Math.max(1, Math.round((s.health ?? 0) * (HP_BASE + (1 - HP_BASE) * hpFrac) * lf));
      continue;
    }
    out[key] = Math.max(1, Math.round((s[key] ?? STAT_DEFAULTS[key]) * lf));   // мана/ярость/инициатива
  }
  return { stats: out, statNorm: refCompleteness(level) * lf };
}
