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

// Аффинити слотов к состязательным статам (какой слот «несёт» какой стат). СУММА веса
// каждого стата по всем слотам нормируется к 1 → полный сет даёт ту же суммарную долю
// шмота, что и раньше (баланс треугольника НЕ меняется), но предметы становятся
// различимыми (у шлема — Точность/Сопр.Криту, у ботинок — Уклонение, и т.д.).
const AFFINITY_RAW = {
  weapon:    { accuracy: 2, crit: 3 },
  helmet:    { accuracy: 2, critResist: 2 },
  chest:     { defense: 3, block: 1 },
  mail:      { defense: 2, block: 2, counter: 1 },
  legs:      { defense: 2, dodge: 2 },
  boots:     { dodge: 3 },
  bracers:   { accuracy: 2, crit: 2 },
  shoulders: { defense: 1, block: 1, counter: 2, critResist: 1 },
};
// нормировка по столбцам (для каждого стата сумма долей по слотам = 1)
const SLOT_AFFINITY = (() => {
  const col = {}; for (const k of CONTESTED) col[k] = 0;
  for (const slot of SLOT_KEYS) for (const [k, w] of Object.entries(AFFINITY_RAW[slot] || {})) col[k] += w;
  const out = {};
  for (const slot of SLOT_KEYS) {
    out[slot] = {};
    for (const [k, w] of Object.entries(AFFINITY_RAW[slot] || {})) out[slot][k] = col[k] ? w / col[k] : 0;
  }
  return out;
})();
/** Суммарная доля шмота по стату для надетых слотов (полный сет → 1). */
const gearShare = (stat, slots) => {
  let sum = 0;
  for (const slot of slots) sum += SLOT_AFFINITY[slot]?.[stat] || 0;
  return sum;
};
// нейтральный профиль (среднее школ) — для «ориентировочных» характеристик на вещах
const NEUTRAL = {};
for (const key of [...CONTESTED, 'power', 'health', 'critPower', 'blockDmg']) {
  NEUTRAL[key] = Math.round(((SCHOOLS.natisk[key] ?? 0) + (SCHOOLS.uklon[key] ?? 0) + (SCHOOLS.oplot[key] ?? 0)) / 3);
}

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
    const v = (s[key] ?? STAT_DEFAULTS[key]) * GEAR_FRAC * (SLOT_AFFINITY[slotKey]?.[key] || 0) * q * lf;
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
 * «Ориентировочные» характеристики предмета по слоту ИГРЫ (для витрины магазина и
 * рюкзака): нейтральный профиль (среднее школ) × аффинити слота. Фиксированные, не
 * зависят от носителя; в бою вклад масштабируется реальной школой (composeFromEquipment).
 * Возвращает плоский объект статов модели (accuracy/defense/health/power/…).
 */
export function gearItemStats(gameSlot, { level = 1, quality = 'blue', growth = DEFAULT_COEF.levelGrowth } = {}) {
  const lf = levelFactor(level, growth);
  const q = QUALITY_MULT[quality] ?? 1;
  const out = {};
  if (Number(gameSlot) === SHIELD_SLOT) {        // щит — танковость (бонус к блоку/защите)
    out.block = Math.round(NEUTRAL.block * GEAR_FRAC * 0.5 * q * lf) + 4;
    out.defense = Math.round(NEUTRAL.defense * GEAR_FRAC * 0.5 * q * lf) + 6;
    return out;
  }
  if (Number(gameSlot) === AMULET_SLOT) {        // амулет — бонус крита/силы крита
    out.crit = Math.round((NEUTRAL.crit || 0) * GEAR_FRAC * 0.5 * q * lf) + 2;
    out.critPower = 8 * q;                        // +Сила Крита, %
    return out;
  }
  const tri = GAME_SLOT_TO_TRI[Number(gameSlot)];
  if (!tri) return out;
  for (const key of CONTESTED) {
    const v = (NEUTRAL[key] || 0) * GEAR_FRAC * (SLOT_AFFINITY[tri]?.[key] || 0) * q * lf;
    if (v >= 0.5) out[key] = Math.round(v);
  }
  const slotMeta = SLOTS.find((sm) => sm.key === tri);
  if (slotMeta?.kind === 'weapon') out.power = Math.round((NEUTRAL.power || 0) * (1 - POW_BASE) * lf);
  else out.health = Math.round((NEUTRAL.health || 0) * (1 - HP_BASE) * (HP_WEIGHT[tri] || 0) * lf);
  return out;
}

// Карта слотов экипировки игры (SLOT_META.id) → слоты треугольника. Щит (8) и амулет
// (10) — не из восьмёрки: щит даёт бонус Оплота (ниже), амулет пока не учитываем.
export const GAME_SLOT_TO_TRI = {
  2: 'helmet', 6: 'shoulders', 7: 'weapon', 1: 'chest',
  5: 'bracers', 3: 'legs', 4: 'boots', 9: 'mail',
};
export const SHIELD_SLOT = 8;       // offhand «Щит» — уклон в Оплот
export const WEAPON_SLOT = 7;       // mainhand «Оружие»
export const AMULET_SLOT = 10;      // амулет — небольшой бонус крита
export const QUALITY_BY_RANK = ['gray', 'green', 'blue', 'purple', 'orange'];  // quality 1..5

/**
 * Боевой блок из РЕАЛЬНОЙ экипировки: items = [{ slot, quality }] (slot — id игры).
 * Надетые слоты → укомплектованность; среднее качество → множитель шмота; щит →
 * крепче блок/защита и чуть меньше Мощи (1H+щит), без щита но с оружием → +Мощь (2H).
 */
export function composeFromEquipment(school, { level = 1, items = [], allocFrac = null, growth = DEFAULT_COEF.levelGrowth } = {}) {
  const equipped = new Set();
  let qSum = 0, qN = 0, shield = false, weapon = false, amulet = false;
  for (const it of items || []) {
    const tri = GAME_SLOT_TO_TRI[it.slot];
    if (tri) equipped.add(tri);
    if (it.slot === SHIELD_SLOT) shield = true;
    if (it.slot === WEAPON_SLOT) weapon = true;
    if (it.slot === AMULET_SLOT) amulet = true;
    if (it.quality != null) { qSum += Math.min(5, Math.max(1, Number(it.quality) || 1)); qN++; }
  }
  const quality = QUALITY_BY_RANK[Math.round(qN ? qSum / qN : 3) - 1] || 'blue';
  const built = composeBuild(school, { level, equipped: [...equipped], quality, allocFrac, growth });
  const s = built.stats;
  if (shield) {                      // 1H + щит: танковее (уклон в Оплот)
    s.block = Math.max(1, Math.round(s.block * 1.25));
    s.defense = Math.max(1, Math.round(s.defense * 1.15));
    s.power = Math.max(1, Math.round(s.power * 0.92));
  } else if (weapon) {               // двуручное: больше Мощи
    s.power = Math.max(1, Math.round(s.power * 1.10));
  }
  if (amulet) {                      // амулет — бонус крита/силы крита
    s.crit = Math.max(1, Math.round(s.crit * 1.12));
    s.critPower = (s.critPower || 0) + 10;
  }
  return { stats: s, statNorm: built.statNorm, school, equippedCount: equipped.size, quality, shield, amulet };
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
      // БОЙ: равномерная доля шмота (баланс проверен на 1–15). Аффинити слотов — только
      // для ВИТРИНЫ (gearItemStats), чтобы предметы различались, не трогая баланс.
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
