/**
 * Библиотека контента: бойцы, локации, предметы, слоты экипировки.
 *
 * Новый контент добавляется ТОЛЬКО здесь — код игры (js/main.js) трогать
 * не нужно. Формат записей описан в README.md («Как добавить бойца /
 * локацию», «Экипировка»).
 */

// ---------------------------------------------------------------------------
// Бойцы: модель + рост + статы + анимации (см. README «Как добавить бойца»)
// ---------------------------------------------------------------------------

// общий набор анимаций демо-бойцов (одна модель, разные статы)
const BRAWLER_ANIMS = {
  idle:   { file: 'assets/models/fighter.fbx' },
  // анимация из другого файла "надевается" на скелет модели
  attack: { file: 'assets/models/martelo2.fbx', hitTime: 0.58, reach: 1.25, inPlace: true },
  // боевой клич для примерочной; lazy — не грузится при старте боя
  taunt:  { file: 'assets/models/taunt.fbx', inPlace: true, lazy: true },
};

export const FIGHTERS = {
  brawler: {
    name: 'ИгрокА',
    level: 15,
    model: 'assets/models/fighter.fbx',
    height: 1.85,
    stats: { hp: 2330, damage: [160, 240], crit: 0.14, dodge: 0.07 },
    animations: BRAWLER_ANIMS,
  },
  // тот же меш, другие статы — пример того, что боец = конфиг
  brawlerElite: {
    name: 'ИгрокБ',
    level: 15,
    model: 'assets/models/fighter.fbx',
    // бойцы на арене одного роста (одинаковый размер моделей у обоих сторон)
    height: 1.85,
    stats: { hp: 1100, damage: [140, 220], crit: 0.1, dodge: 0.05 },
    animations: BRAWLER_ANIMS,
  },
};

// ---------------------------------------------------------------------------
// Локации. Запись = картинка (или css-градиент) + три группы контента:
//   actions: { label, goto } — переход; { label, hunt } — бой;
//            { label, soon } — переход-заглушка (пока недоступен);
//            { label } без флагов — действие-заглушка;
//   npc:     жители локации (диалоги подключаются отдельным модулем).
// id — локация в БД сервера.
// ---------------------------------------------------------------------------

export const LOCATIONS = {
  village: {
    id: 1,
    name: 'Город Надежды',
    image: 'assets/backgrounds/prigorod.webp',
    actions: [
      { label: 'Охота на разбойника', hunt: true },
      { label: 'Охота на шайку разбойников', hunt: true, npc: 2 },
      { label: 'Магазин эликсиров', shop: true },
      { label: 'Испить живой воды', drink: 'livingWater' },
      { label: 'Подняться в замок', soon: true },
      { label: 'Поселение Зеленое', goto: 'derevna' },
    ],
    npc: [
      { name: 'Ворчливый старик' },
    ],
  },
  derevna: {
    id: 2,
    name: 'Поселение Зеленое',
    image: 'assets/backgrounds/derevna.webp',
    actions: [
      { label: 'Охота на разбойника', hunt: true },
      { label: 'Охота на шайку разбойников', hunt: true, npc: 2 },
      { label: 'Войти в трактир' },
      { label: 'Город Надежды', goto: 'village' },
    ],
    npc: [
      { name: 'Фермер Дрю' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Экипировка: предмет = слот + иконка (+ опционально 3D-модель и attach).
// В рантайме сюда же дописываются вещи с сервера (registerServerItems).
//
//   noModel: true — вещь без 3D: занимает слот куклы и виден в рюкзаке,
//            но на персонаже не отображается;
//   demo: true    — локальная демо-вещь: не синхронизируется с сервером
//            (надевается мгновенно, живёт только в этой сессии).
//
// 3D bronze_armor.fbx временно отключена (28 МБ — тяжела для телефонов).
// Вернуть: убрать noModel и добавить model + attach — рабочий конфиг
// сохранён в README, раздел «Экипировка».
// ---------------------------------------------------------------------------

export const ITEMS = {
  bronzeArmor: {
    name: 'Бронзовый доспех',
    icon: '🛡️',
    slot: 'torso',
    noModel: true,
  },
  // демо-набор: по вещи на каждый слот куклы
  recruitHelm:    { name: 'Шлем рекрута',          icon: '🪖', slot: 'head',      noModel: true, demo: true },
  wandererPads:   { name: 'Наплечники странника',  icon: '🧥', slot: 'shoulders', noModel: true, demo: true },
  militiaSword:   { name: 'Меч ополченца',         icon: '🗡️', slot: 'mainhand',  noModel: true, demo: true },
  leatherBelt:    { name: 'Кожаный пояс',          icon: '🥋', slot: 'belt',      noModel: true, demo: true },
  dragonAmulet:   { name: 'Амулет дракона',        icon: '📿', slot: 'amulet',    noModel: true, demo: true },
  archerGloves:   { name: 'Перчатки лучника',      icon: '🧤', slot: 'hands',     noModel: true, demo: true },
  oakenShield:    { name: 'Дубовый щит',           icon: '🛡️', slot: 'offhand',   noModel: true, demo: true },
  mercenaryPants: { name: 'Штаны наёмника',        icon: '👖', slot: 'legs',      noModel: true, demo: true },
  courierBoots:   { name: 'Сапоги гонца',          icon: '🥾', slot: 'feet',      noModel: true, demo: true },

  // Эликсиры — расходники для боевого пояса (не надеваются в слот куклы).
  //   type:'elixir'  — кладётся в пояс, а не в слот экипировки;
  //   kind:'health'  — лечит potency·100% от макс. HP за глоток;
  //   kind:'power'   — повышает урон игрока на potency·100% на turns ходов.
  // Заряд тратится в бою (см. пояс эликсиров в main.js).
  healthElixir: { name: 'Эликсир здоровья', icon: '🧪', type: 'elixir', kind: 'health', potency: 0.30, demo: true },
  powerElixir:  { name: 'Эликсир мощи',     icon: '⚗️', type: 'elixir', kind: 'power',  potency: 0.30, turns: 3, demo: true },
};

// Заклинания — ровно 3 слота в нижнем ряду (без листания).
export const SPELLS = {
  spark:    { name: 'Искра',        icon: '✨' },
  fireball: { name: 'Огненный шар', icon: '🔥' },
  frost:    { name: 'Мороз',        icon: '❄️' },
};

export const SPELL_SLOTS = 3;            // ровно 3 слота заклинаний (нижняя панель)
export const ELIXIR_SLOTS = 6;           // 6 эликсиров (нижняя панель, листаются стрелками)

// Сколько зарядов ОДНОГО расходника помещается в ОДНУ ячейку пояса (#1).
// Точное значение задаёт шаблон (base_stats.belt_max) — сервер шлёт его как cap;
// здесь только дефолты по виду. ДОЛЖНО совпадать с сервером (backend/src/belt.js).
export const ELIXIR_BELT_CAP = { health: 1, power: 10, mana: 1, blood: 3,
  escape: 1, poison: 1, heal_scroll: 1, cleanse: 1 };
export const beltCapFor = (kind, stats) => {
  const m = stats && stats.belt_max;
  if (m != null) return Math.max(1, Number(m) || 1);
  return ELIXIR_BELT_CAP[kind] ?? 1;
};

// ---------------------------------------------------------------------------
// Кукла экипировки: какие слоты есть, как зовутся и с какой стороны от
// персонажа рисуются. id = body_part в БД сервера (slot в item_templates);
// сервер пока знает только торс (1), остальные зарезервированы.
// ---------------------------------------------------------------------------

export const SLOT_META = {
  head:      { id: 2,  name: 'Шлем',       side: 'left'  },
  shoulders: { id: 6,  name: 'Наплечники', side: 'left'  },
  mainhand:  { id: 7,  name: 'Оружие',     side: 'left'  },
  torso:     { id: 1,  name: 'Доспех',     side: 'left'  },
  belt:      { id: 9,  name: 'Пояс',       side: 'left'  },
  amulet:    { id: 10, name: 'Амулет',     side: 'right' },
  hands:     { id: 5,  name: 'Перчатки',   side: 'right' },
  offhand:   { id: 8,  name: 'Щит',        side: 'right' },
  legs:      { id: 3,  name: 'Штаны',      side: 'right' },
  feet:      { id: 4,  name: 'Сапоги',     side: 'right' },
};
