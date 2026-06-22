/**
 * Каноничная модель характеристик «Broken Sun» (как на экране параметров, без
 * «Водой») + боевые формулы. Используется СИМУЛЯТОРОМ; в живой бой пока не
 * подключено (engine.js берёт модель опционально и при её отсутствии работает
 * по-старому). Все коэффициенты формул вынесены в DEFAULT_COEF и переопределяются
 * из запроса — это и есть «крутилки баланса» для тестов.
 *
 * Производные исходы боя из статов:
 *  - Мощь        → базовый урон удара (powerToDamage);
 *  - Защита      → снижение урона с насыщением def/(def+K);
 *  - Точность vs Уклонение → шанс уворота;
 *  - Крит vs Сопр.Криту    → шанс крита;
 *  - Сила Крита  → множитель крит-урона (100% ⇒ ×2);
 *  - Блок        → шанс блока, Блок урона → насколько срезается урон при блоке;
 *  - Контратака  → шанс ответного удара;
 *  - Инициатива  → очередь хода (engine сортирует по ней);
 *  - Здоровье    → maxHp; Мана/Ярость — ресурсы (заготовка под способности).
 */

// key — поле в блоке stats бойца; pct — процентный стат (не растёт от уровня);
// resource — ресурс (мана/ярость), пока не влияет на базовый удар.
export const STAT_META = [
  { key: 'power',      label: 'Мощь',        def: 3618 },
  { key: 'health',     label: 'Здоровье',    def: 1213 },
  { key: 'mana',       label: 'Мана',        def: 94,  resource: true },
  { key: 'rage',       label: 'Ярость',      def: 82,  resource: true },
  { key: 'initiative', label: 'Инициатива',  def: 109 },
  { key: 'defense',    label: 'Защита',      def: 131 },
  { key: 'accuracy',   label: 'Точность',    def: 115 },
  { key: 'dodge',      label: 'Уклонение',   def: 66 },
  { key: 'crit',       label: 'Крит',        def: 49 },
  { key: 'critPower',  label: 'Сила Крита',  def: 100, pct: true },
  { key: 'critResist', label: 'Сопр. Криту', def: 27 },
  { key: 'block',      label: 'Блок',        def: 24 },
  { key: 'blockDmg',   label: 'Блок урона',  def: 50,  pct: true },
  { key: 'counter',    label: 'Контратака',  def: 49 },
];

export const STAT_DEFAULTS = Object.fromEntries(STAT_META.map((s) => [s.key, s.def]));

/** Коэффициенты формул (значения по умолчанию; всё переопределяемо из запроса). */
export const DEFAULT_COEF = {
  powerToDamage: 0.10,   // урон удара = Мощь × это
  damageVar:     0.15,   // ± разброс урона удара
  defenseK:      400,    // насыщение защиты: снижение = Защита/(Защита+K)
  baseDodge:     0.02,   // шанс уворота = base + Уклонение×scale − Точность×accScale
  dodgeScale:    0.0030,
  accScale:      0.0018,
  maxDodge:      0.60,
  baseCrit:      0.02,   // шанс крита = base + Крит×scale − Сопр.Криту×resScale
  critScale:     0.0040,
  critResScale:  0.0030,
  maxCrit:       0.75,
  blockScale:    0.0120, // шанс блока = Блок×scale
  maxBlock:      0.60,
  counterScale:  0.0040, // шанс контратаки = Контратака×scale
  maxCounter:    0.50,
  levelGrowth:   0.08,   // рост непроцентных статов: ×(1 + growth×(level−1))
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Боевая модель: чистые функции исходов по статам атакующего/защитника. */
export function makeModel(coefOverride = {}) {
  const c = { ...DEFAULT_COEF };
  for (const k in coefOverride) {
    const n = Number(coefOverride[k]);
    if (Number.isFinite(n)) c[k] = n;
  }
  return {
    coef: c,
    baseDamage: (A) => (A.power || 0) * c.powerToDamage,
    damageVariance: () => 1 + (Math.random() * 2 - 1) * c.damageVar,
    defenseMitigation: (D) => (D.defense || 0) / ((D.defense || 0) + c.defenseK),
    dodgeChance: (A, D) =>
      clamp(c.baseDodge + (D.dodge || 0) * c.dodgeScale - (A.accuracy || 0) * c.accScale, 0, c.maxDodge),
    critChance: (A, D) =>
      clamp(c.baseCrit + (A.crit || 0) * c.critScale - (D.critResist || 0) * c.critResScale, 0, c.maxCrit),
    critMult: (A) => 1 + (A.critPower || 0) / 100,
    blockChance: (A, D) => clamp((D.block || 0) * c.blockScale, 0, c.maxBlock),
    blockMitigation: (D) => clamp((D.blockDmg || 0) / 100, 0, 1),
    counterChance: (D, A) => clamp((D.counter || 0) * c.counterScale, 0, c.maxCounter),
  };
}

/** Множитель роста непроцентных статов на уровне level (1 = базовые значения). */
export const levelFactor = (level, growth = DEFAULT_COEF.levelGrowth) =>
  1 + Math.max(0, growth) * Math.max(0, (Number(level) || 1) - 1);
