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
import { api, ServerBattle } from './net/net.js';
import { BattleUI } from './arena/BattleUI.js';
import { DressingRoom } from './arena/DressingRoom.js';

// ---------------------------------------------------------------------------
// БИБЛИОТЕКА КОНТЕНТА — сюда добавляются новые модели, локации и предметы
// ---------------------------------------------------------------------------

const PLAYER = {
  name: 'ИгрокА',
  level: 15,
  // кошелёк: медь / серебро / золото / бриллианты
  wallet: { copper: 0, silver: 0, gold: 0, diamond: 0 },
  xp: 1240,    xpMax: 2000,    // опыт до следующего уровня
  pvpXp: 360,  pvpXpMax: 1000, // опыт PvP
};

// ---------------------------------------------------------------------------
// Связь с сервером (см. js/net/net.js). Если сервер недоступен, игра остаётся
// в оффлайн-режиме: локации листаются, но бой/чат/игроки требуют подключения.
// ---------------------------------------------------------------------------

let online = false;
const SLOT_IDS = { torso: 1 };   // имя слота экипировки -> body_part в БД
const SLOT_NAMES = Object.fromEntries(
  Object.entries(SLOT_IDS).map(([k, v]) => [v, k]));
// неизвестные слоты получают синтетическое имя 'slotN' — вещь всё равно
// видна в рюкзаке и надевается (без 3D-модели)
const slotNameFor = (slotId) =>
  slotId == null ? null : (SLOT_NAMES[slotId] || 'slot' + slotId);
const slotIdFor = (slotName) =>
  SLOT_IDS[slotName] ?? Number(String(slotName).replace('slot', ''));
const LOC_BY_ID = { 1: 'village', 2: 'canyon', 3: 'night' };

/** Перенести персонажа с сервера в PLAYER и шапку. */
function applyCharacter(ch) {
  PLAYER.id = ch.id;
  PLAYER.name = ch.name;
  PLAYER.level = ch.level;
  PLAYER.wallet = { copper: 0, silver: 0, gold: 0, diamond: 0, ...ch.wallet };
  delete PLAYER.wallet.valor;    // доблесть показывается шкалой PvP, не монетой
  PLAYER.xp = ch.xp; PLAYER.xpMax = ch.xpMax;
  PLAYER.pvpXp = ch.pvpXp; PLAYER.pvpXpMax = ch.pvpXpMax;
  $('pp-name').textContent = PLAYER.name;
  $('pp-level').textContent = PLAYER.level;
  renderMoney();
  renderXP();
}

/** Переход между локациями: сначала подтверждение сервера, потом UI. */
async function gotoLocation(key) {
  if (!online) { setLocation(key); return; }
  try {
    await api.move(LOCATIONS[key].id);
    setLocation(key);
    refreshPlayers();
  } catch (e) {
    showToast('Туда не пройти: ' + e.message);
  }
}

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
    id: 1,
    name: 'Деревня',
    image: 'assets/backgrounds/village.webp',
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
    id: 2,
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
    id: 3,
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

function renderMoney() {
  for (const [cur, val] of Object.entries(PLAYER.wallet)) {
    $('pp-' + cur).textContent = val;
  }
}

function addMoney(cur, v) {
  PLAYER.wallet[cur] += v;
  renderMoney();
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
  // в бою шапка персонажа и навигация скрываются (см. body.in-battle в CSS)
  document.body.classList.toggle('in-battle', next === 'battle');
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
      if (a.goto) gotoLocation(a.goto);
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

/** Возврат в идущий бой после F5/обрыва связи, либо на нас напали. */
async function resumeBattle(serverBattle) {
  console.log('Возврат в бой', serverBattle.battleId,
    'mode=', mode, 'loading=', battleLoading);
  if (mode === 'battle' || battleLoading) return;
  // нападение могло застать игрока в гардеробе — закрываем его
  if (!dressingEl.classList.contains('hidden')) {
    dressingEl.classList.add('hidden');
    dressing.stop();
  }
  setMode('battle');
  arena.setBackground(LOCATIONS[currentLoc]);
  showToast(serverBattle.fresh
    ? '⚔ На вас напали! Бой начинается'
    : 'Бой продолжается — возвращаемся');
  await initBattle(serverBattle);
}

async function startBattle() {
  if (mode === 'battle' || battleLoading) return;
  if (!online) { showToast('Бой требует подключения к серверу'); return; }
  setMode('battle');
  arena.setBackground(LOCATIONS[currentLoc]);
  await initBattle();
}

const BATTLE_ERRORS = {
  target_offline: 'игрок не в сети',
  target_busy: 'игрок уже в бою',
  already_in_battle: 'вы уже в бою',
  cannot_attack_self: 'нельзя напасть на себя',
  not_same_location: 'игрок в другой локации',
  no_hunt_here: 'здесь не на кого охотиться',
};

/** Дуэль PvP: нападение на игрока из «Списка игроков в локации». */
async function startPvp(target) {
  if (mode === 'battle' || battleLoading) { showToast('Вы уже в бою!'); return; }
  if (!online) { showToast('Бой требует подключения к серверу'); return; }
  setMode('battle');
  arena.setBackground(LOCATIONS[currentLoc]);
  await initBattle(null, () => ServerBattle.attack(target.id));
}

async function initBattle(resumedBattle = null, starter = null) {
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

  // бой создаёт и ведёт сервер: формулы те же (порт BattleSystem),
  // но урон, криты и награды решает только он
  try {
    battle = resumedBattle || await (starter || ServerBattle.hunt)();
  } catch (e) {
    showToast('Не удалось начать бой: ' + (BATTLE_ERRORS[e.message] || e.message));
    setMode('location');
    return;
  }

  ui = new BattleUI({
    head: $('battle-head'),
    stage: arenaStage,
    log: $('battle-log'),
    teams: { left: $('team-left'), right: $('team-right') },
    left:  { name: battle.sides.left.name,
             level: battle.sides.left.level ?? PLAYER.level },
    right: { name: battle.sides.right.name,
             level: battle.sides.right.level ?? '?' },
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
    if (e.detail.aborted) {
      showToast(e.detail.reason === 'admin'
        ? 'Бой прерван администратором' : 'Вы покинули бой');
      setTimeout(() => leaveBattle(true), 900);
      return;
    }
    const victory = e.detail.winner === 'left';
    if (victory) {
      // деньги, опыт и задания начислил сервер — просто обновляем шапку
      api.me().then(applyCharacter).catch(console.error);
    }
    ui.showEnd(victory, {
      // повторить можно только охоту; на дуэль соперника вызывают заново
      onRestart: battle.kind === 'pvp' ? null : () => initBattle(),
      onLeave: () => leaveBattle(true),
    });
  });

  battle.addEventListener('serverError', (e) => {
    const code = e.detail.error;
    showToast(code === 'no_escape_elixir'
      ? 'Покинуть бой можно только Эликсиром побега'
      : code === 'cannot_leave' ? 'Из боя нельзя просто уйти'
      : 'Сервер: ' + code);
  });

  battle.activate?.();   // воспроизвести события, накопленные пока грузились модели
}

function leaveBattle(force = false) {
  // идущий бой покидается только Эликсиром побега — решает сервер
  if (!force && battle && battle.phase !== 'ended' && online) {
    battle.requestEscape();
    return;
  }
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
  if (name === 'players') refreshPlayers();
}

document.querySelectorAll('.dock-tab').forEach((t) => {
  t.addEventListener('click', () => activateTab(t.dataset.pane));
});

// --- расширение нижнего окна жестом: зажать ручку (или ряд вкладок) и
// повести вверх — окно растёт; вниз или тап по ручке — исходная высота ---

const dockEl = $('bottom-dock');
const dockGrip = $('dock-grip');
const dockTabs = $('dock-tabs');
let dockExpanded = false;
let dockDrag = null;        // активный жест: { id, y, h, base, moved }
let dockClickGuard = false; // после перетаскивания гасим случайный клик

dockEl.classList.add('dock-anim');

/** Высота панели по умолчанию — из CSS (--dock-h), без инлайн-стиля. */
function dockBaseHeight() {
  const prev = dockEl.style.height;
  dockEl.style.height = '';
  const h = dockEl.getBoundingClientRect().height;
  dockEl.style.height = prev;
  return h;
}

const dockMaxHeight = () => Math.round(window.innerHeight * 0.72);

function dockSnap(expand) {
  dockExpanded = expand;
  dockEl.classList.add('dock-anim');
  dockEl.style.height = expand ? dockMaxHeight() + 'px' : '';
}

function dockPointerDown(e) {
  if (dockDrag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  dockDrag = {
    id: e.pointerId,
    y: e.clientY,
    h: dockEl.getBoundingClientRect().height,
    base: dockBaseHeight(),
    moved: false,
  };
}

function dockPointerMove(e) {
  if (!dockDrag || e.pointerId !== dockDrag.id) return;
  const dy = dockDrag.y - e.clientY; // вверх — положительное
  if (!dockDrag.moved) {
    if (Math.abs(dy) < 7) return;   // ещё не жест — не мешаем кликам
    dockDrag.moved = true;
    dockEl.classList.remove('dock-anim');
  }
  const h = Math.max(dockDrag.base, Math.min(dockMaxHeight(), dockDrag.h + dy));
  dockEl.style.height = h + 'px';
  if (e.cancelable) e.preventDefault();
}

function dockPointerUp(e) {
  if (!dockDrag || e.pointerId !== dockDrag.id) return;
  const drag = dockDrag;
  dockDrag = null;
  if (!drag.moved) return;
  // дотягиваем до ближайшего состояния (порог — треть пути)
  const h = dockEl.getBoundingClientRect().height;
  dockSnap(h - drag.base > (dockMaxHeight() - drag.base) / 3);
  dockClickGuard = true;
  setTimeout(() => { dockClickGuard = false; }, 50);
}

dockGrip.addEventListener('pointerdown', dockPointerDown);
dockTabs.addEventListener('pointerdown', dockPointerDown);
window.addEventListener('pointermove', dockPointerMove, { passive: false });
window.addEventListener('pointerup', dockPointerUp);
window.addEventListener('pointercancel', dockPointerUp);

// тап по ручке без движения — переключить развёрнутость
dockGrip.addEventListener('click', () => {
  if (!dockClickGuard) dockSnap(!dockExpanded);
});

// после жеста клик не должен переключать вкладку
dockTabs.addEventListener('click', (e) => {
  if (dockClickGuard) { e.stopPropagation(); e.preventDefault(); }
}, true);

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

// чат локации: отправка на сервер, своё сообщение возвращается из pub/sub
const chatLog = $('chat-log');

function chatMessage(author, text, system = false) {
  const line = document.createElement('div');
  line.className = 'chat-line' + (system || author === 'Система' ? ' system' : '');
  const b = document.createElement('b');
  b.textContent = system || author === 'Система' ? `[${author}]` : author;
  line.appendChild(b);
  line.appendChild(document.createTextNode(': '));
  // «Бой #N» в тексте — кликабельная ссылка на окно боя
  const str = String(text);
  const m = str.match(/Бой #(\d+)/);
  if (m) {
    line.appendChild(document.createTextNode(str.slice(0, m.index)));
    const a = document.createElement('a');
    a.className = 'battle-link';
    a.href = '#';
    a.textContent = m[0];
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openBattleInfo(Number(m[1]));
    });
    line.appendChild(a);
    line.appendChild(document.createTextNode(str.slice(m.index + m[0].length)));
  } else {
    line.appendChild(document.createTextNode(str));
  }
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (online) api.sendChat(text);        // вернётся всем в локации, включая нас
  else chatMessage(PLAYER.name, text);   // оффлайн: локальное эхо
  input.value = '';
});

// список игроков в локации — живой, из Redis-присутствия сервера
const playersList = $('players-list');

// меч возле ника: нападение на игрока (дуэль PvP)
const ICON_SWORD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/></svg>`;

async function refreshPlayers() {
  if (!online) return;
  try {
    const players = await api.players();
    playersList.innerHTML = '';
    for (const p of players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = p.name + ' ';
      const lvl = document.createElement('span');
      lvl.className = 'm-lvl';
      lvl.textContent = `[${p.level}]`;
      name.appendChild(lvl);
      row.appendChild(name);
      if (String(p.id) !== String(PLAYER.id)) {
        const atk = document.createElement('button');
        atk.className = 'pvp-btn';
        atk.title = `Напасть на ${p.name}`;
        atk.innerHTML = ICON_SWORD;
        atk.addEventListener('click', () => startPvp(p));
        row.appendChild(atk);
      }
      playersList.appendChild(row);
    }
  } catch (e) {
    console.error('Список игроков:', e);
  }
}

// ---------------------------------------------------------------------------
// Окно информации о бое (открывается ссылкой «Бой #N» из чата)
// ---------------------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const binfoEl = $('binfo');
const binfoTitle = $('binfo-title');
const binfoBody = $('binfo-body');
let binfoTimer = null;   // автообновление, пока бой идёт и окно открыто

function closeBattleInfo() {
  binfoEl.classList.add('hidden');
  clearInterval(binfoTimer);
  binfoTimer = null;
}
$('binfo-close').addEventListener('click', closeBattleInfo);
binfoEl.addEventListener('click', (e) => {
  if (e.target === binfoEl) closeBattleInfo();
});

const RESULT_LABELS = { 1: 'победа', 2: 'поражение', 3: 'ничья', 4: 'побег', 5: 'таймаут' };

async function openBattleInfo(id) {
  binfoTitle.textContent = `Бой #${id}`;
  binfoBody.innerHTML = '<div class="bi-empty">Загрузка…</div>';
  binfoEl.classList.remove('hidden');
  clearInterval(binfoTimer);
  binfoTimer = null;
  await renderBattleInfo(id);
}

async function renderBattleInfo(id) {
  if (!online) { binfoBody.innerHTML = '<div class="bi-empty">Нет связи с сервером</div>'; return; }
  let d;
  try {
    d = await api.battleInfo(id);
  } catch (e) {
    clearInterval(binfoTimer); binfoTimer = null;
    binfoBody.innerHTML = `<div class="bi-empty">Не удалось загрузить: ${esc(e.message)}</div>`;
    return;
  }

  if (d.status === 'active') {
    binfoTitle.textContent = `Бой #${id} — идёт, ход ${d.turn}`;
    const bar = (cur, max, cls) => `
      <div class="bi-bar ${cls}">
        <div class="bi-fill" style="width:${max ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0}%"></div>
        <span>${cur} / ${max}</span>
      </div>`;
    const member = (p) => `
      <div class="bi-member">
        <div class="bi-name">${esc(p.name)} <span class="m-lvl">[${p.level ?? '?'}]</span></div>
        ${bar(p.hp, p.maxHp, 'bi-hp')}
        ${bar(p.mp, p.maxMp, 'bi-mp')}
      </div>`;
    binfoBody.innerHTML = `
      <div class="bi-teams">
        <div class="bi-team"><div class="bi-team-title">1я команда</div>
          ${d.teams.left.map(member).join('')}</div>
        <div class="bi-team"><div class="bi-team-title">2я команда</div>
          ${d.teams.right.map(member).join('')}</div>
      </div>`;
    // живой бой — обновляем картину раз в 2 секунды
    if (!binfoTimer) {
      binfoTimer = setInterval(() => {
        if (binfoEl.classList.contains('hidden')) closeBattleInfo();
        else renderBattleInfo(id);
      }, 2000);
    }
    return;
  }

  // бой завершён или прерван — таблица итогов
  clearInterval(binfoTimer);
  binfoTimer = null;
  binfoTitle.textContent = `Бой #${id} — ${d.status === 'aborted' ? 'прерван' : 'завершён'}`;
  const showValor = d.results.some((r) => Number(r.valor) > 0);
  const num = (v) => (v == null ? '—' : v);
  const rows = d.results.map((r) => `
    <tr>
      <td>${r.side}я</td>
      <td>${esc(r.name)} <span class="m-lvl">[${r.level ?? '?'}]</span></td>
      <td>${RESULT_LABELS[r.result] || '—'}</td>
      <td>${num(r.damage)}</td>
      <td>${num(r.kills)}</td>
      <td>${num(r.deaths)}</td>
      <td>${num(r.exp)}</td>
      ${showValor ? `<td>${num(r.valor)}</td>` : ''}
    </tr>`).join('');
  binfoBody.innerHTML = `
    <table class="bi-table">
      <thead><tr>
        <th>Команда</th><th>Имя</th><th>Итог</th><th>Урон</th>
        <th>Убийств</th><th>Смертей</th><th>Опыт</th>
        ${showValor ? '<th>Доблесть</th>' : ''}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// Инвентарь: рюкзак игрока, надеть/снять можно только своего персонажа
// ---------------------------------------------------------------------------

// последний снимок инвентаря с сервера: каждая вещь — отдельная строка
let serverInv = [];

/** Ключ шаблона предмета в ITEMS: знакомые получают 3D, остальные — без. */
const itemKeyFor = (it) => it.icon || 'srv' + it.templateId;

/**
 * Зарегистрировать вещи с сервера в ITEMS (для 3D и слотов) и привести
 * equipState игрока к серверному состоянию — сервер источник правды.
 */
function registerServerItems(inv) {
  serverInv = inv;
  const equippedBySlot = {};
  for (const it of inv) {
    const slotName = slotNameFor(it.slot);
    const key = itemKeyFor(it);
    if (!ITEMS[key]) {
      ITEMS[key] = { name: it.name, slot: slotName, icon: '📦', noModel: true };
    }
    if (it.equipped && slotName) equippedBySlot[slotName] = key;
  }
  for (const slot of new Set(
    [...Object.keys(equipState.left), ...Object.keys(equippedBySlot)])) {
    equipState.left[slot] = equippedBySlot[slot] || null;
  }
}

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
          if (key && ITEMS[key]?.noModel) continue;   // без 3D — только состояние
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
  const prev = equipState[side][item.slot] || null;
  const next = prev === itemKey ? null : itemKey;
  equipState[side][item.slot] = next;
  if (side === 'left') syncServerEquip(item.slot, next, prev); // правый — локальная кукла
  return syncEquipment(side);
}

const EQUIP_ERRORS = {
  injured: 'мешает травма',
  level_too_low: 'не хватает уровня',
  not_equippable: 'этот предмет нельзя надеть',
  not_found: 'предмета нет в инвентаре',
  conflict: 'предмет занят, попробуйте ещё раз',
};

/** Сервер хранит экипировку игрока (item_instances + item_ledger). */
async function syncServerEquip(slotName, itemKey, prevKey = null) {
  if (!online) return;
  try {
    if (itemKey) {
      const inv = await api.inventory();
      const it = inv.find((i) => itemKeyFor(i) === itemKey && !i.equipped)
        || inv.find((i) => itemKeyFor(i) === itemKey);
      if (!it) throw new Error('not_found');
      // equip/unequip возвращают свежий инвентарь — обновляем снимок
      serverInv = it.equipped ? inv : await api.equip(it.id);
    } else {
      serverInv = await api.unequip(slotIdFor(slotName));
    }
    renderInventory();
  } catch (e) {
    console.error('Экипировка на сервере:', e);
    showToast('Сервер отклонил экипировку: ' + (EQUIP_ERRORS[e.message] || e.message));
    // сервер — источник правды: откатываем локальное состояние и 3D
    equipState.left[slotName] = prevKey;
    syncEquipment('left');
    if (!dressingEl.classList.contains('hidden')) {
      syncDressing(false).catch(console.error);
    }
  }
}

// --- примерочная: только СВОЙ персонаж, вещи меряются на нём ---

const dressingEl = $('dressing');
const dressingItemsEl = $('dressing-items');
const dressing = new DressingRoom($('dressing-view'));
const dressingSide = 'left';   // одевать можно только себя
let dressingBusy = false;

async function openDressing() {
  dressingEl.classList.remove('hidden');
  dressing.start();
  dressingBusy = true;
  renderInventory();
  try {
    // свежий рюкзак с сервера: выданные/полученные вещи появляются сразу
    if (online) {
      try { registerServerItems(await api.inventory()); }
      catch (e) { console.error('Обновление рюкзака:', e); }
    }
    await dressing.show(FIGHTERS.brawler);
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
      if (key && ITEMS[key]?.noModel) continue;       // без 3D — только состояние
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
  // онлайн: каждая вещь рюкзака — отдельная строка (включая дубликаты и
  // предметы без 3D-модели); оффлайн — демо-набор из ITEMS
  const rows = online && serverInv.length
    ? serverInv.map((it) => ({ key: itemKeyFor(it), inst: it }))
    : Object.keys(ITEMS).map((key) => ({ key, inst: null }));
  for (const { key, inst } of rows) {
    const item = ITEMS[key]
      || { name: inst.name, icon: '📦', slot: slotNameFor(inst.slot) };
    const slotName = inst ? slotNameFor(inst.slot) : item.slot;
    const equipped = !!slotName && equipState[dressingSide][slotName] === key;
    const row = document.createElement('div');
    row.className = 'inv-item';
    const head = document.createElement('div');
    head.className = 'inv-item-head';
    const icon = document.createElement('span');
    icon.className = 'inv-icon';
    icon.textContent = item.icon || '📦';
    const name = document.createElement('span');
    name.className = 'inv-name';
    name.textContent = item.name
      + (inst && inst.quantity > 1 ? ` ×${inst.quantity}` : '');
    head.append(icon, name);
    const actions = document.createElement('div');
    actions.className = 'inv-actions';
    if (slotName) {       // вещь надевается — кнопка «Надеть/Снять»
      const b = document.createElement('button');
      b.className = 'inv-btn' + (equipped ? ' equipped' : '');
      b.disabled = dressingBusy;
      b.textContent = dressingBusy ? 'Загрузка…' : (equipped ? 'Снять' : 'Надеть');
      b.addEventListener('click', () => toggleDressingEquip(key));
      actions.appendChild(b);
    }
    row.append(head, actions);
    dressingItemsEl.appendChild(row);
  }
}

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

$('nav-bag').addEventListener('click', () => openDressing());

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

renderMoney();
renderXP();

// Боевой сервер пускает только через Telegram Mini App (dev-вход выключен).
// Если игру открыли в обычном браузере — показываем ссылку на бота.
const TG_BOT = 'mymmorpg_defex_bot';

function showTelegramGate() {
  const el = document.createElement('div');
  el.className = 'file-helper';
  el.innerHTML =
    '<div class="fh-card">' +
      '<div class="fh-title">⚜ DRAGON ARENA</div>' +
      '<p class="fh-sub">Регистрация и вход — только через Telegram. ' +
        'Откройте игру внутри Telegram-бота, и персонаж создастся автоматически.</p>' +
      '<a class="fh-link" href="https://t.me/' + TG_BOT + '" target="_blank" rel="noopener">' +
        'Открыть бота → @' + TG_BOT + '</a>' +
      '<p class="fh-note">Локальная разработка: запустите start.bat и выберите ' +
        '«Локальный сервер» — там вход по имени работает без Telegram.</p>' +
    '</div>';
  document.body.appendChild(el);
}

(async () => {
  // если на сервере остался идущий бой (после F5/обрыва) — вернёмся в него
  api.onBattleResume((b) => resumeBattle(b).catch((e) => {
    console.error('Возврат в бой не удался:', e);
    showToast('Не удалось вернуться в бой: ' + e.message);
  }));
  try {
    const ch = await api.login(PLAYER.name);
    online = true;
    applyCharacter(ch);

    // вещи с сервера: знакомым ключам — 3D-модели из ITEMS, остальные
    // добавляются без модели (noModel), чтобы видно было ВСЁ имущество
    registerServerItems(await api.inventory());

    // чат: история, затем живые сообщения
    api.onChat((m) => chatMessage(m.from, m.text));
    for (const h of await api.chatHistory()) chatMessage(h.sender_name, h.body);

    setLocation(LOC_BY_ID[ch.location_id] || 'village');
    refreshPlayers();
  } catch (e) {
    if (e.message === 'dev_auth_disabled') {
      showTelegramGate();
      setLocation('village');
      setMode('location');
      return;
    }
    console.error('Сервер недоступен, оффлайн-режим:', e);
    showToast('Сервер недоступен — игра в оффлайн-режиме');
    setLocation('village');
  }
  // если за время загрузки сервер вернул идущий бой (battleResume),
  // режим уже «бой» — не выкидываем игрока обратно в локацию
  if (mode !== 'battle' && !battleLoading) setMode('location');
})();
