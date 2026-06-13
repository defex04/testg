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
    height: 1.92,
    stats: { hp: 2600, damage: [140, 220], crit: 0.1, dodge: 0.05 },
    animations: BRAWLER_ANIMS,
  },
};

// ---------------------------------------------------------------------------
// Локации. Запись = картинка (или css-градиент) + три группы контента:
//   actions: { label, goto } — переход; { label, hunt } — бой;
//            { label } без флагов — действие-заглушка;
//   npc:     жители локации (диалоги подключаются отдельным модулем).
// id — локация в БД сервера; без id переход чисто клиентский (сервер о нём
// не знает, чат и список игроков остаются от последней серверной локации).
// layout: 'castle' — полноэкранный фон + меню «замка» (см. README).
// ---------------------------------------------------------------------------

export const LOCATIONS = {
  village: {
    id: 1,
    name: 'Город Надежды',
    layout: 'castle',
    image: 'assets/backgrounds/before_the_castle.png',
    actions: [
      { label: 'Войти в замок', goto: 'castle' },
      { label: 'Покинуть город', goto: 'canyon' },
      { label: 'Охота на разбойника', hunt: true },
      { label: 'Набрать воды из колодца' },
    ],
    npc: [
      { name: 'Торговец Глеб' },
      { name: 'Знахарка Мира' },
    ],
  },
  castle: {
    // клиентская локация (без id): для сервера игрок остаётся в Городе Надежды
    name: 'Замок',
    layout: 'castle',
    image: 'assets/backgrounds/castle_hall.svg',
    actions: [
      { label: 'Выйти в город', goto: 'village' },
      { label: 'Подняться на крепостную стену' },
      { label: 'Осмотреть тронный зал' },
    ],
    npc: [
      { name: 'Страж ворот Ансель' },
      { name: 'Казначей Орвин' },
    ],
  },
  canyon: {
    id: 2,
    name: 'Предместье',
    image: 'assets/backgrounds/canyon.svg',
    actions: [
      { label: 'Вернуться в город', goto: 'village' },
      { label: 'Спуститься в лощину', goto: 'night' },
      { label: 'Охота на разбойника', hunt: true },
      { label: 'Осмотреть обрыв' },
    ],
    npc: [
      { name: 'Старатель Бор' },
    ],
  },
  night: {
    id: 3,
    name: 'Ночная лощина',
    css: 'linear-gradient(180deg,#0b1026 0%,#1b2a52 55%,#2c3e6b 78%,#15315c 100%)',
    actions: [
      { label: 'Подняться в предместье', goto: 'canyon' },
      { label: 'Охота на разбойника', hunt: true },
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

// Ячеек в боевом поясе эликсиров (пряжка + 4 слота на арт-макете).
// Каждая заполненная ячейка = один заряд на бой, поэтому число доступных
// в бою эликсиров ограничено вместимостью пояса.
export const ELIXIR_SLOTS = 4;

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
