/**
 * Точка входа демо-игры: собирает модуль арены, боевую систему и UI,
 * плюс MMORPG-обвязку вокруг (локации, рюкзак; аукцион/чат/почта — заглушки).
 *
 * Два экрана главной панели:
 *  - «локация» (вне боя): картинка местности + кнопки переходов;
 *  - «бой»: 3D-арена, плашки бойцов, штурвал атаки/блока, слоты скиллов.
 * Нижняя панель с вкладками общая: в бою добавляются «Участники боя» и
 * «Лог боя», вне боя остаются «Чат» и «Список игроков в локации».
 *
 * Всё, что нужно менять при добавлении контента, находится в
 * FIGHTERS, LOCATIONS и ITEMS — см. README.md.
 */
import { Arena } from './arena/Arena.js';
import { BattleSystem } from './arena/BattleSystem.js';
import { BattleUI } from './arena/BattleUI.js';
import { DressingRoom } from './arena/DressingRoom.js';

// ---------------------------------------------------------------------------
// БИБЛИОТЕКА КОНТЕНТА — сюда добавляются новые модели, локации и предметы
// ---------------------------------------------------------------------------

const PLAYER = {
  name: 'ИгрокА',
  level: 15,
  money: 0,
  xp: 1240,    xpMax: 2000,    // опыт до следующего уровня
  pvpXp: 360,  pvpXpMax: 1000, // опыт PvP
};

const FIGHTERS = {
  brawler: {
    name: 'ИгрокА',
    level: 15,
    model: 'assets/models/fighter.fbx',
    height: 1.85,
    stats: { hp: 2330, damage: [160, 240], crit: 0.14, dodge: 0.07 },
    animations: {
      idle:   { file: 'assets/models/fighter.fbx' },
      // анимация из другого файла "надевается" на скелет модели
      attack: { file: 'assets/models/martelo2.fbx', hitTime: 0.58, reach: 1.25, inPlace: true },
      // боевой клич для примерочной; lazy — не грузится при старте боя
      taunt:  { file: 'assets/models/taunt.fbx', inPlace: true, lazy: true },
    },
  },
  // тот же меш, другие статы — пример того, что боец = конфиг
  brawlerElite: {
    name: 'ИгрокБ',
    level: 15,
    model: 'assets/models/fighter.fbx',
    height: 1.92,
    stats: { hp: 2600, damage: [140, 220], crit: 0.1, dodge: 0.05 },
    animations: {
      idle:   { file: 'assets/models/fighter.fbx' },
      attack: { file: 'assets/models/martelo2.fbx', hitTime: 0.58, reach: 1.25, inPlace: true },
      // боевой клич для примерочной; lazy — не грузится при старте боя
      taunt:  { file: 'assets/models/taunt.fbx', inPlace: true, lazy: true },
    },
  },
};

// Локация = картинка (или css-градиент) + три группы контента:
//   actions: { label, goto } — переход; { label, hunt } — бой;
//            { label } без флагов — действие-заглушка;
//   npc:     жители локации (диалоги подключаются отдельным модулем).
// Переходы, действия и NPC рендерятся отдельными секциями — локаций
// и действий может быть сколько угодно, секции просто растут.
const LOCATIONS = {
  village: {
    name: 'Деревня',
    image: 'assets/backgrounds/village.svg',
    actions: [
      { label: 'Войти в город', go: true },
      { label: 'Пройти к мосту', goto: 'canyon' },
      { label: 'Охота на разбойника', hunt: true },
      { label: 'Набрать воды из колодца' },
    ],
    npc: [
      { name: 'Торговец Глеб' },
      { name: 'Знахарка Мира' },
    ],
  },
  canyon: {
    name: 'Каньон',
    image: 'assets/backgrounds/canyon.svg',
    actions: [
      { label: 'Вернуться в деревню', goto: 'village' },
      { label: 'Спуститься в лощину', goto: 'night' },
      { label: 'Охота на разбойника', hunt: true },
      { label: 'Осмотреть обрыв' },
    ],
    npc: [
      { name: 'Старатель Бор' },
    ],
  },
  night: {
    name: 'Ночная лощина',
    css: 'linear-gradient(180deg,#0b1026 0%,#1b2a52 55%,#2c3e6b 78%,#15315c 100%)',
    actions: [
      { label: 'Подняться в каньон', goto: 'canyon' },
      { label: 'Охота на разбойника', hunt: true },
    ],
  },
};

// Экипировка: предмет = модель + слот + настройки крепления к кости.
// Новый предмет — новая запись здесь, код трогать не нужно.
const ITEMS = {
  bronzeArmor: {
    name: 'Бронзовый доспех',
    icon: '🛡️',
    slot: 'torso',
    model: 'assets/models/bronze_armor.fbx',
    // у модели Meshy "перёд" вдоль локальной -X, поэтому доворот на 90°;
    // cover/offset подобраны в примерочной. Материал — родной из FBX:
    // с PBR-картами из архива металл пересвечивается (см. README).
    attach: { bone: /Spine1$/i, cover: 1.5, scale: 1, offset: [0.02, -0.02, 0], rotation: [0, 90, 0] },
  },
};

// ---------------------------------------------------------------------------
// Telegram WebApp (безопасно: в обычном браузере просто ничего не делает)
// ---------------------------------------------------------------------------

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const screenLocation = $('screen-location');
const screenBattle = $('screen-battle');
const arenaStage = $('arena-stage');
const loadingEl = $('arena-loading');
const locPicture = $('loc-picture');
const locActions = $('loc-actions');

// канвас живёт в скрытом до боя arena-stage; Arena сама подхватит размер,
// когда экран боя станет видимым (ResizeObserver)
const arena = new Arena(arenaStage);
window.__arena = arena; // отладочный доступ из консоли
window.__debug = () => ({ arena, dressing, ITEMS, equipState, fighters, battle, ui });

let mode = 'location';   // 'location' | 'battle'
let currentLoc = 'village';
let battle = null;
let ui = null;
let battleLoading = false;
let fighters = { left: null, right: null };
let totalDamage = 0;     // суммарный урон игрока за текущий бой

// --- панель персонажа (шапка): уровень, имя, опыт/PvP-опыт, медь ---

$('pp-name').textContent = PLAYER.name;
$('pp-level').textContent = PLAYER.level;

function setMoney(v) {
  PLAYER.money = v;
  $('pp-money').textContent = v;
}

function renderXP() {
  $('pp-xp-fill').style.width = Math.min(100, (PLAYER.xp / PLAYER.xpMax) * 100) + '%';
  $('pp-xp-text').textContent = `${PLAYER.xp} / ${PLAYER.xpMax}`;
  $('pp-pvp-fill').style.width = Math.min(100, (PLAYER.pvpXp / PLAYER.pvpXpMax) * 100) + '%';
  $('pp-pvp-text').textContent = `${PLAYER.pvpXp} / ${PLAYER.pvpXpMax}`;
}

// --- режимы главной панели ---

function setMode(next) {
  mode = next;
  screenLocation.classList.toggle('hidden', next !== 'location');
  screenBattle.classList.toggle('hidden', next !== 'battle');
  document.querySelectorAll('[data-battle-only]').forEach((t) =>
    t.classList.toggle('hidden', next !== 'battle'));
  activateTab(next === 'battle' ? 'members' : 'chat');
}

// --- локации ---

// иконки кнопок локации (inline-SVG — эмодзи в UI рендерятся нестабильно)
const ICON_GO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13.5 6.5 19 12l-5.5 5.5"/></svg>`;
const ICON_HUNT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 4.5 15.5 15.5M19.5 4.5 8.5 15.5"/><path d="M14 17.2 17.2 14M10 17.2 6.8 14"/><path d="M16.2 16.2 19 19M7.8 16.2 5 19"/></svg>`;
const ICON_ACT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l1.8 5.4L19 12l-5.2 2.6L12 20l-1.8-5.4L5 12l5.2-2.6L12 4Z"/></svg>`;

/** Секция «Переходы»/«Действия»/«Жители»; пустые секции не рисуются. */
function renderActionGroup(title, buttons) {
  if (!buttons.length) return;
  const group = document.createElement('div');
  group.className = 'loc-group';
  const head = document.createElement('div');
  head.className = 'loc-group-title';
  head.textContent = title;
  const items = document.createElement('div');
  items.className = 'loc-group-items';
  for (const b of buttons) items.appendChild(b);
  group.appendChild(head);
  group.appendChild(items);
  locActions.appendChild(group);
}

function makeButton(className, html, onClick) {
  const b = document.createElement('button');
  b.className = className;
  b.innerHTML = html;
  b.addEventListener('click', onClick);
  return b;
}

function setLocation(key) {
  currentLoc = key;
  const loc = LOCATIONS[key];
  locPicture.style.background = loc.image
    ? `#111 url("${loc.image}") center / cover no-repeat`
    : loc.css;
  $('loc-name').textContent = loc.name;
  chatMessage('Система', `Вы вошли в локацию «${loc.name}».`, true);
  locActions.innerHTML = '';

  const transitions = loc.actions.filter((a) => a.goto || a.go);
  const acts = loc.actions.filter((a) => !a.goto && !a.go);

  renderActionGroup('Переходы', transitions.map((a) =>
    makeButton('loc-chip', `<span class="lc-ico">${ICON_GO}</span><span>${a.label}</span>`, () => {
      if (a.goto) setLocation(a.goto);
      else showToast(`«${a.label}» — заглушка: модуль локаций подключается отдельно`);
    })));

  renderActionGroup('Действия', acts.map((a) =>
    makeButton('loc-btn' + (a.hunt ? ' hunt' : ''),
      `<span class="lc-ico">${a.hunt ? ICON_HUNT : ICON_ACT}</span><span>${a.label}</span>`, () => {
        if (a.hunt) startBattle();
        else showToast(`«${a.label}» — заглушка: модуль действий подключается отдельно`);
      })));

  renderActionGroup('Жители', (loc.npc || []).map((n) =>
    makeButton('npc-chip',
      `<span class="npc-ava">${n.name.trim()[0]}</span><span>${n.name}</span>`,
      () => showToast(`Диалог с «${n.name}» — заглушка: модуль NPC подключается отдельно`))));
}

// ---------------------------------------------------------------------------
// Бой
// ---------------------------------------------------------------------------

async function startBattle() {
  if (mode === 'battle' || battleLoading) return;
  setMode('battle');
  arena.setBackground(LOCATIONS[currentLoc]);
  await initBattle();
}

async function initBattle() {
  if (battleLoading) return;
  battleLoading = true;
  loadingEl.classList.remove('hidden');
  if (ui) ui.destroy();
  if (battle) battle.destroy();

  const leftDef = FIGHTERS.brawler;
  const rightDef = FIGHTERS.brawlerElite;

  try {
    [fighters.left, fighters.right] = await Promise.all([
      arena.addFighter('left', leftDef),
      arena.addFighter('right', rightDef),
    ]);
    // надетое переживает перезапуск боя
    await Promise.all([syncEquipment('left'), syncEquipment('right')]);
  } finally {
    battleLoading = false;
    loadingEl.classList.add('hidden');
  }

  battle = new BattleSystem({
    left:  { name: leftDef.name,  isAI: false, ...leftDef.stats },
    right: { name: rightDef.name, isAI: true,  ...rightDef.stats },
  }, { turnTime: 20 });

  ui = new BattleUI({
    head: $('battle-head'),
    stage: arenaStage,
    log: $('battle-log'),
    teams: { left: $('team-left'), right: $('team-right') },
    left:  { name: leftDef.name,  level: leftDef.level },
    right: { name: rightDef.name, level: rightDef.level },
    onStrike: (move) => {
      ui.hideControls();
      battle.submitMove('left', move);
    },
  });
  ui.setHP('left', battle.sides.left.hp, battle.sides.left.maxHp);
  ui.setHP('right', battle.sides.right.hp, battle.sides.right.maxHp);
  totalDamage = 0;
  ui.setDamage(0);

  battle.addEventListener('turnStart', (e) => {
    ui.setTurn(e.detail.turn);
    ui.setTimer(e.detail.timeLeft);
    ui.showControls();
  });

  battle.addEventListener('timer', (e) => ui.setTimer(e.detail.timeLeft));

  battle.addEventListener('resolve', async (e) => {
    ui.hideControls(false);
    for (const side of e.detail.passed || []) {
      ui.log(`<b>${e.detail.sides[side].name}</b> пропускает ход`);
    }
    for (const s of e.detail.strikes) {
      await playStrike(s, e.detail.sides);
    }
    battle.finishTurn();
  });

  battle.addEventListener('battleEnd', (e) => {
    ui.hideControls(false);
    const victory = e.detail.winner === 'left';
    if (victory) {
      setMoney(PLAYER.money + 50);
      PLAYER.xp = Math.min(PLAYER.xpMax, PLAYER.xp + 120);
      renderXP();
    }
    ui.showEnd(victory, {
      onRestart: () => initBattle(),
      onLeave: () => leaveBattle(),
    });
  });

  battle.start();
}

function leaveBattle() {
  if (ui) { ui.destroy(); ui = null; }
  if (battle) { battle.destroy(); battle = null; }
  setMode('location');
}

const ZONE_LABELS = { high: 'голову', mid: 'корпус', low: 'ноги' };

async function playStrike(s, sides) {
  const attacker = fighters[s.attacker];
  const defender = fighters[s.defender];

  await attacker.strike(defender, () => {
    const pos = arena.worldToScreen(defender.headPoint());
    if (s.dodged) {
      ui.popup(pos, 'Уворот!', 'dodge');
    } else if (s.blocked && !s.crit) {
      defender.hitReact();
      ui.popup(pos, `Блок −${s.damage}`, 'block');
    } else {
      defender.hitReact();
      ui.popup(pos, `−${s.damage}`, s.crit ? 'crit' : 'dmg');
    }
    ui.setHP(s.defender, s.defenderHp, sides[s.defender].maxHp);
    // «Урон» в шапке — общий урон, нанесённый игроком за весь бой
    if (s.attacker === 'left' && !s.dodged) {
      totalDamage += s.damage;
      ui.setDamage(totalDamage);
    }

    const who = sides[s.attacker].name;
    const whom = sides[s.defender].name;
    const zone = ZONE_LABELS[s.zone] || s.zone;
    let text;
    if (s.dodged) text = `<b>${whom}</b> уклонился от удара`;
    else if (s.crit) text = `<b>${who}</b> наносит <span class="crit">критический удар</span> в ${zone}: −${s.damage}`;
    else if (s.blocked) text = `<b>${whom}</b> блокирует удар в ${zone}: −${s.damage}`;
    else text = `<b>${who}</b> бьёт в ${zone}: −${s.damage}`;
    ui.log(text);
  });

  if (s.killed) {
    await defender.die();
    ui.log(`<b>${sides[s.defender].name}</b> повержен!`);
  }
}

// ---------------------------------------------------------------------------
// Нижняя панель: вкладки
// ---------------------------------------------------------------------------

function activateTab(name) {
  document.querySelectorAll('.dock-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.pane === name));
  document.querySelectorAll('.dock-pane').forEach((p) =>
    p.classList.toggle('active', p.id === 'pane-' + name));
}

document.querySelectorAll('.dock-tab').forEach((t) => {
  t.addEventListener('click', () => activateTab(t.dataset.pane));
});

// «Показать/Скрыть убитых» во вкладке участников
const membersGrid = $('members-grid');
$('show-dead').addEventListener('click', () => {
  membersGrid.classList.toggle('hide-dead');
  $('show-dead').textContent =
    membersGrid.classList.contains('hide-dead') ? 'Показать убитых' : 'Скрыть убитых';
});

// подвкладки чата — заглушка
document.querySelectorAll('.chat-tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.chat-tab').forEach((x) => x.classList.toggle('active', x === t));
  });
});

// чат — заглушка с локальным эхом: настоящий чат подключается отдельным модулем
const chatLog = $('chat-log');

function chatMessage(author, text, system = false) {
  const line = document.createElement('div');
  line.className = 'chat-line' + (system ? ' system' : '');
  const b = document.createElement('b');
  b.textContent = system ? `[${author}]` : author;
  line.appendChild(b);
  line.appendChild(document.createTextNode(': ' + text));
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  chatMessage(PLAYER.name, text);
  input.value = '';
});

// список игроков в локации — заглушка
const playersList = $('players-list');
for (const p of [{ name: 'ИгрокА', level: 15 }, { name: 'ИгрокБ', level: 15 }]) {
  const row = document.createElement('div');
  row.className = 'player-row';
  row.innerHTML = `${p.name} <span class="m-lvl">[${p.level}]</span>`;
  playersList.appendChild(row);
}

// ---------------------------------------------------------------------------
// Инвентарь: надеть/снять предметы на любого из бойцов
// ---------------------------------------------------------------------------

// Желаемое состояние экипировки. Единственный источник правды:
// UI меняет его, а syncEquipment приводит бойцов в соответствие.
// Так нет гонок между кликами и пересозданием бойцов при рестарте боя.
const equipState = { left: {}, right: {} };   // side -> slot -> itemKey | null
const syncLocks = { left: Promise.resolve(), right: Promise.resolve() };
const busySides = new Set();

function syncEquipment(side) {
  // очередь на бойца: одновременные вызовы выполняются по одному
  syncLocks[side] = syncLocks[side].then(async () => {
    busySides.add(side);
    renderInventory();
    try {
      // всегда берём АКТУАЛЬНОГО бойца — он мог быть пересоздан
      const fighter = fighters[side];
      if (!fighter) return;
      for (const [slot, key] of Object.entries(equipState[side])) {
        try {
          if (key && !fighter.hasEquipped(slot)) await fighter.equip(ITEMS[key]);
          else if (!key && fighter.hasEquipped(slot)) fighter.unequip(slot);
        } catch (e) {
          // предмет не загрузился — откатываем желаемое состояние,
          // иначе каждый рестарт боя будет повторять ошибку
          console.error(`Не удалось надеть «${ITEMS[key]?.name || key}»:`, e);
          equipState[side][slot] = null;
        }
      }
    } finally {
      busySides.delete(side);
      renderInventory();
    }
  }).catch((e) => console.error('Ошибка экипировки:', e));
  return syncLocks[side];
}

function toggleEquip(side, itemKey) {
  const item = ITEMS[itemKey];
  equipState[side][item.slot] = equipState[side][item.slot] === itemKey ? null : itemKey;
  return syncEquipment(side);
}

// --- примерочная: персонаж лицом к камере, вещи меряются на нём ---

const dressingEl = $('dressing');
const dressingItemsEl = $('dressing-items');
const dressing = new DressingRoom($('dressing-view'));
let dressingSide = 'left';
let dressingBusy = false;

async function openDressing(side) {
  dressingSide = side;
  document.querySelectorAll('.dressing-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.side === side));
  dressingEl.classList.remove('hidden');
  dressing.start();
  dressingBusy = true;
  renderInventory();
  try {
    await dressing.show(side === 'left' ? FIGHTERS.brawler : FIGHTERS.brawlerElite);
    await syncDressing(false);
  } finally {
    dressingBusy = false;
    renderInventory();
  }
}

/** Привести персонажа в примерочной к equipState (желаемому состоянию). */
async function syncDressing(withTaunt = true) {
  const f = dressing.fighter;
  if (!f) return;
  for (const [slot, key] of Object.entries(equipState[dressingSide])) {
    try {
      if (key && !f.hasEquipped(slot)) {
        if (withTaunt) await dressing.equip(ITEMS[key]);
        else await f.equip(ITEMS[key]);
      } else if (!key && f.hasEquipped(slot)) {
        dressing.unequip(slot);
      }
    } catch (e) {
      console.error(`Примерочная: не удалось надеть «${ITEMS[key]?.name || key}»:`, e);
      equipState[dressingSide][slot] = null;
    }
  }
}

async function toggleDressingEquip(itemKey) {
  if (dressingBusy) return;
  dressingBusy = true;
  renderInventory();
  try {
    toggleEquip(dressingSide, itemKey);   // состояние + бойцы на арене (очередь)
    await syncDressing();                 // персонаж в примерочной
  } finally {
    dressingBusy = false;
    renderInventory();
  }
}

function renderInventory() {
  dressingItemsEl.innerHTML = '';
  for (const [key, item] of Object.entries(ITEMS)) {
    const equipped = equipState[dressingSide][item.slot] === key;
    const row = document.createElement('div');
    row.className = 'inv-item';
    row.innerHTML = `
      <div class="inv-item-head">
        <span class="inv-icon">${item.icon || '📦'}</span>
        <span class="inv-name">${item.name}</span>
      </div>
      <div class="inv-actions"></div>`;
    const b = document.createElement('button');
    b.className = 'inv-btn' + (equipped ? ' equipped' : '');
    b.disabled = dressingBusy;
    b.textContent = dressingBusy ? 'Загрузка…' : (equipped ? 'Снять' : 'Надеть');
    b.addEventListener('click', () => toggleDressingEquip(key));
    row.querySelector('.inv-actions').appendChild(b);
    dressingItemsEl.appendChild(row);
  }
}

document.querySelectorAll('.dressing-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (!dressingBusy && tab.dataset.side !== dressingSide) openDressing(tab.dataset.side);
  });
});
$('dressing-close').addEventListener('click', () => {
  dressingEl.classList.add('hidden');
  dressing.stop(); // рендер-цикл примерочной не жрёт GPU, пока она закрыта
});

// ---------------------------------------------------------------------------
// Навигация: круглые кнопки + заглушки
// ---------------------------------------------------------------------------

const toast = $('toast');
let toastTimer = null;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

$('nav-location').addEventListener('click', () => {
  if (mode === 'battle') showToast('Сначала закончите бой!');
  else showToast(`Вы в локации «${LOCATIONS[currentLoc].name}»`);
});

$('nav-bag').addEventListener('click', () => openDressing(dressingSide));

$('nav-hunt').addEventListener('click', () => {
  if (mode === 'battle') showToast('Вы уже в бою!');
  else startBattle();
});

document.querySelectorAll('[data-stub]').forEach((btn) => {
  btn.addEventListener('click', () => {
    showToast(`Модуль «${btn.dataset.stub}» подключается отдельно — пока заглушка`);
  });
});

// ---------------------------------------------------------------------------
// Старт: игрок появляется в деревне
// ---------------------------------------------------------------------------

setMoney(0);
renderXP();
setLocation('village');
setMode('location');

// пара реплик, чтобы чат не выглядел пустым (заглушка до настоящего модуля)
chatMessage('ИгрокБ', 'Всем привет! Как охота?');
chatMessage('Друид', 'Продам травы маны, недорого.');
