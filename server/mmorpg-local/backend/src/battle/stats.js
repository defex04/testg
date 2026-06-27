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
  critBlockPierce: 0.26, // крит «вскрывает» блок: при крите блок-митигация ×это (ребро Крит→Блок)
  levelGrowth:   0.08,   // рост непроцентных статов: ×(1 + growth×(level−1))
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Отдельная шкала для "скелета" боя: HP и Мощь. Состязательные статы не трогаем,
// чтобы сохранить треугольник, но опустить числа: ~200 HP на старте и ~3000 HP
// в среднем у 15 уровня в синем полном комплекте.
export const SKELETON_SCALE_START = 0.1325;
export const SKELETON_SCALE_END = 0.524;
export const SKELETON_SCALE_MAX_LEVEL = 15;
export const skeletonScale = (level) => {
  const n = Math.max(1, Math.min(SKELETON_SCALE_MAX_LEVEL, Number(level) || 1));
  const t = (n - 1) / Math.max(1, SKELETON_SCALE_MAX_LEVEL - 1);
  return SKELETON_SCALE_START + (SKELETON_SCALE_END - SKELETON_SCALE_START) * t;
};

/**
 * Боевая модель: чистые функции исходов по статам атакующего/защитника.
 *
 * Нормировка по уровню (n): состязательные статы растут ×levelFactor, поэтому их
 * РАЗНОСТЬ к высоким уровням упирается в потолки (maxDodge/maxCrit/…) и треугольник
 * «схлопывается». Делим переменную часть шанса (и K митигации) на n = levelFactor
 * защитника → шанс зависит только от ПРОФИЛЯ сборки, а не от уровня. В равном по
 * уровню бою n у обоих одинаков, значит ребра треугольника держат винрейт на 1–15.
 * n по умолчанию 1 (боец без statNorm) — поведение как раньше.
 */
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
    defenseMitigation: (D, n = 1) => (D.defense || 0) / ((D.defense || 0) + c.defenseK * (n || 1)),
    dodgeChance: (A, D, n = 1) =>
      clamp(c.baseDodge + ((D.dodge || 0) * c.dodgeScale - (A.accuracy || 0) * c.accScale) / (n || 1), 0, c.maxDodge),
    critChance: (A, D, n = 1) =>
      clamp(c.baseCrit + ((A.crit || 0) * c.critScale - (D.critResist || 0) * c.critResScale) / (n || 1), 0, c.maxCrit),
    critMult: (A) => 1 + (A.critPower || 0) / 100,
    blockChance: (A, D, n = 1) => clamp((D.block || 0) * c.blockScale / (n || 1), 0, c.maxBlock),
    blockMitigation: (D) => clamp((D.blockDmg || 0) / 100, 0, 1),
    counterChance: (D, A, n = 1) => clamp((D.counter || 0) * c.counterScale / (n || 1), 0, c.maxCounter),
  };
}

/** Множитель роста непроцентных статов на уровне level (1 = базовые значения). */
export const levelFactor = (level, growth = DEFAULT_COEF.levelGrowth) =>
  1 + Math.max(0, growth) * Math.max(0, (Number(level) || 1) - 1);

// ─── Экипировка и сборки (треугольник «Натиск ▸ Уклон ▸ Оплот») ───────────────

/**
 * Качество шмота (серый…оранжевый) — множитель СОСТЯЗАТЕЛЬНОГО слоя. Разброс
 * СЖАТЫЙ: цвет решает мало (оранж ≈ +10% к серому), а уровень/тир — главное. Так
 * удача в дропе не ломает треугольник и не обгоняет прокачку по уровням.
 */
export const QUALITY = ['gray', 'green', 'blue', 'purple', 'orange'];
export const QUALITY_MULT = { gray: 0.97, green: 0.985, blue: 1.00, purple: 1.015, orange: 1.03 };

/** Поколение шмота: тир задаёт ПОТОЛОК бойца; T = ⌈level/5⌉ (T1:1–5, T2:6–10, T3:11–15). */
export const gearTier = (level) => Math.min(3, Math.max(1, Math.ceil((Number(level) || 1) / 5)));

/** Состязательный слой (на него влияет качество); остальное — «скелет» (Мощь/HP/%). */
export const CONTESTED = ['accuracy', 'dodge', 'crit', 'critResist', 'defense', 'block', 'counter'];

/**
 * Три угла треугольника: профили на 1 ур., синее качество (как в дизайне). Это
 * ЦЕЛЬ, к которой боец приходит, вложив очки + тематический шмот в свой угол.
 * Скелет (power/health) сопоставим — исход решает состязательный слой.
 */
export const SCHOOLS = {
  // Натиск: точный, стойкий бугай. Высокая Точность снимает уворот Уклона, высокий
  // Сопр.Криту гасит его взрыв → бьёт Уклон. Крит низкий → против Оплота фулл-блок.
  natisk: { label: 'Натиск', power: 3850, health: 2800, accuracy: 210, dodge: 30,  crit: 45,
            critPower: 100, critResist: 38, defense: 165, block: 22, blockDmg: 50, counter: 30, initiative: 110 },
  // Уклон: стекло. Высокий Уклон уходит от Оплота, высокий Крит пробивает его блок →
  // бьёт Оплот. Против Точности Натиска уворот снят → быстро умирает.
  uklon:  { label: 'Уклон',  power: 3200, health: 2050, accuracy: 70,  dodge: 200, crit: 130,
            critPower: 120, critResist: 25, defense: 70,  block: 10, blockDmg: 50, counter: 20, initiative: 120 },
  // Оплот: стена с контрой. Блок+Защита+Контра перетягивают точного без крита (Натиск)
  // и Сопр.Криту глушит его крит. Низкая Точность → не может приколоть Уклон.
  oplot:  { label: 'Оплот',  power: 2700, health: 2900, accuracy: 100, dodge: 30,  crit: 25,
            critPower: 90,  critResist: 85, defense: 230, block: 60, blockDmg: 62, counter: 26, initiative: 95 },
};

/**
 * Собрать блок статов бойца для школы на уровне level и качестве quality.
 * Непроцентные статы растут ×levelFactor (скелет и состязательные одинаково),
 * качество множит ТОЛЬКО состязательный слой. Возвращает 14-стат блок Broken Sun;
 * рядом боец должен нести statNorm = levelFactor(level) для нормировки шансов.
 */
export function composeFighter(school, { level = 1, quality = 'blue', growth = DEFAULT_COEF.levelGrowth } = {}) {
  const s = SCHOOLS[school] || SCHOOLS.natisk;
  const lf = levelFactor(level, growth);
  const sk = skeletonScale(level);
  const q = QUALITY_MULT[quality] ?? 1;
  const contested = new Set(CONTESTED);
  const out = {};
  for (const m of STAT_META) {
    const base = s[m.key] ?? STAT_DEFAULTS[m.key];
    if (m.pct) { out[m.key] = base; continue; }          // % (Сила Крита/Блок урона) — без уровня/качества
    let v = base * lf;
    if (m.key === 'power' || m.key === 'health') v *= sk;
    if (contested.has(m.key)) v *= q;                     // качество — только состязательный слой
    out[m.key] = Math.max(1, Math.round(v));
  }
  return out;
}
