/**
 * Точка входа демо-игры: собирает модуль арены, боевую систему и UI,
 * плюс MMORPG-обвязку вокруг (локации, рюкзак; аукцион/чат/почта — заглушки).
 *
 * Контент (бойцы, локации, предметы) живёт в js/content.js — при добавлении
 * нового контента этот файл трогать не нужно (см. README.md).
 *
 * Два экрана главной панели:
 *  - «локация» (вне боя): фон/картинка местности + кнопки переходов;
 *  - «бой»: 3D-арена, плашки бойцов, штурвал атаки/блока, слоты скиллов.
 * На локациях layout: 'castle' нижняя панель (чат/игроки/участники/лог)
 * выдвигается иконками меню, на остальных — постоянные вкладки.
 */
import { Arena } from './arena/Arena.js';
import { api, ServerBattle } from './net/net.js';
import { BattleUI } from './arena/BattleUI.js';
import { DressingRoom } from './arena/DressingRoom.js';
import { FIGHTERS, LOCATIONS, ITEMS, SLOT_META } from './content.js';

// ---------------------------------------------------------------------------
// Утилиты и состояние игрока
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const esc = (v) => String(v ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PLAYER = {
  name: 'ИгрокА',
  level: 15,
  // кошелёк: медь / серебро / золото / бриллианты
  wallet: { copper: 0, silver: 0, gold: 0, diamond: 0 },
  xp: 1240,    xpMax: 2000,    // опыт до следующего уровня
  pvpXp: 360,  pvpXpMax: 1000, // опыт PvP
};

// Связь с сервером (см. js/net/net.js). Если сервер недоступен, игра остаётся
// в оффлайн-режиме: локации листаются, но бой/чат/игроки требуют подключения.
let online = false;

// имя слота экипировки <-> body_part в БД сервера
const SLOT_IDS = Object.fromEntries(
  Object.entries(SLOT_META).map(([k, m]) => [k, m.id]));
const SLOT_NAMES = Object.fromEntries(
  Object.entries(SLOT_IDS).map(([k, v]) => [v, k]));
// неизвестные слоты получают синтетическое имя 'slotN' — вещь всё равно
// видна в рюкзаке и надевается (без 3D-модели)
const slotNameFor = (slotId) =>
  slotId == null ? null : (SLOT_NAMES[slotId] || 'slot' + slotId);
const slotIdFor = (slotName) =>
  SLOT_IDS[slotName] ?? Number(String(slotName).replace('slot', ''));

// id локации в БД сервера -> ключ в LOCATIONS (клиентские локации без id)
const LOC_BY_ID = Object.fromEntries(
  Object.entries(LOCATIONS).filter(([, l]) => l.id).map(([k, l]) => [l.id, k]));

/** Перенести персонажа с сервера в PLAYER и шапку. */
function applyCharacter(ch) {
  PLAYER.id = ch.id;
  PLAYER.name = ch.name;
  PLAYER.level = ch.level;
  PLAYER.wallet = { copper: 0, silver: 0, gold: 0, diamond: 0, ...ch.wallet };
  delete PLAYER.wallet.valor;    // доблесть показывается шкалой PvP, не монетой
  PLAYER.xp = ch.xp; PLAYER.xpMax = ch.xpMax;
  PLAYER.pvpXp = ch.pvpXp; PLAYER.pvpXpMax = ch.pvpXpMax;
  renderPlayerPlate();
}

function renderPlayerPlate() {
  $('pp-name').textContent = PLAYER.name;
  $('pp-level').textContent = PLAYER.level;
  renderMoney();
  renderXP();
}

function renderMoney() {
  for (const [cur, val] of Object.entries(PLAYER.wallet)) {
    const cell = $('pp-' + cur);
    if (cell) cell.textContent = val;   // незнакомая серверу/клиенту валюта — молча пропускаем
  }
}

function renderXP() {
  $('pp-xp-fill').style.width = Math.min(100, (PLAYER.xp / PLAYER.xpMax) * 100) + '%';
  $('pp-xp-text').textContent = `${PLAYER.xp} / ${PLAYER.xpMax}`;
  $('pp-pvp-fill').style.width = Math.min(100, (PLAYER.pvpXp / PLAYER.pvpXpMax) * 100) + '%';
  $('pp-pvp-text').textContent = `${PLAYER.pvpXp} / ${PLAYER.pvpXpMax}`;
}

// ---------------------------------------------------------------------------
// Telegram WebApp (безопасно: в обычном браузере просто ничего не делает)
// ---------------------------------------------------------------------------

const TG_BOT = 'mymmorpg_defex_bot';

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
}

// ---------------------------------------------------------------------------
// Каркас: элементы, режимы экрана, layout «замок»
// ---------------------------------------------------------------------------

const screenLocation = $('screen-location');
const screenBattle = $('screen-battle');
const arenaStage = $('arena-stage');
const loadingEl = $('arena-loading');
const locPicture = $('loc-picture');
const locActions = $('loc-actions');
const locBody = $('loc-body');
const locSceneTitle = $('loc-scene-title');
const castleBg = $('castle-bg');
const castlePerimeter = $('castle-perimeter');
const castleMainMenu = $('castle-main-menu');
const dockEl = $('bottom-dock');

let mode = 'location';   // 'location' | 'battle'
let currentLoc = 'village';

// канвас живёт в скрытом до боя arena-stage; Arena сама подхватит размер,
// когда экран боя станет видимым (ResizeObserver). Рендер-цикл запускается
// только на время боя (setMode) — вне боя GPU не работает вхолостую.
const arena = new Arena(arenaStage, { autostart: false });

const isCastleLayout = () => LOCATIONS[currentLoc]?.layout === 'castle';

// --- состояние UI первой локации ---
let locPanelOpen = false;                 // всплывающая панель «Локация»
let castleDockPane = null;                // 'members'|'battlelog'|'players'|'chat'|null
const CASTLE_DOCK_PANES = new Set(['members', 'battlelog', 'chat', 'players']);
const BATTLE_ONLY_PANES = new Set(['members', 'battlelog']);

/** Применить layout текущей локации (замок: фон на весь экран + свои меню). */
function applyUILayout() {
  const castle = isCastleLayout();
  document.body.classList.toggle('loc-castle', castle);
  if (!castle) return;
  const loc = LOCATIONS[currentLoc];
  castleBg.style.background = loc.image
    ? `#0a0e07 url("${loc.image}") center / cover no-repeat`
    : (loc.css || '#0a0e07');
  locSceneTitle.textContent = loc.name;
  updateCastleMainMenu();
}

/** Подсветка активной иконки в нижнем меню замка. */
function updateCastleMainMenu() {
  castleMainMenu?.querySelectorAll('.sprite-main').forEach((b) => {
    const pane = b.dataset.mm;
    if (pane === 'location') b.classList.toggle('active', locPanelOpen);
    else if (CASTLE_DOCK_PANES.has(pane))
      b.classList.toggle('active', castleDockPane === pane);
  });
}

function toggleLocPanel(force) {
  if (!isCastleLayout()) return;
  locPanelOpen = force ?? !locPanelOpen;
  locBody.classList.toggle('open', locPanelOpen);
  if (locPanelOpen) closeCastleDock();
  updateCastleMainMenu();
}

function closeLocPanel() {
  if (!locPanelOpen) return;
  locPanelOpen = false;
  locBody.classList.remove('open');
  updateCastleMainMenu();
}

function openCastleDock(pane) {
  if (!isCastleLayout()) return;
  if (BATTLE_ONLY_PANES.has(pane) && mode !== 'battle') {
    showToast('Эта панель доступна только во время боя');
    return;
  }
  if (castleDockPane === pane) {   // повторный тап по иконке — закрыть
    closeCastleDock();
    return;
  }
  closeLocPanel();
  castleDockPane = pane;
  dockEl.classList.add('dock-open');
  dockEl.dataset.pane = pane;      // у чата/игроков панель выше, чем у участников
  dockEl.style.height = '';
  dockExpanded = false;
  activateTab(pane);
  updateCastleMainMenu();
}

function closeCastleDock() {
  castleDockPane = null;
  dockEl.classList.remove('dock-open');
  delete dockEl.dataset.pane;
  dockEl.style.height = '';
  dockExpanded = false;
  updateCastleMainMenu();
}

/** Переключение «локация» ⇄ «бой». */
function setMode(next) {
  mode = next;
  const battle = next === 'battle';
  // в бою шапка персонажа и навигация скрываются (см. body.in-battle в CSS)
  document.body.classList.toggle('in-battle', battle);
  screenLocation.classList.toggle('hidden', battle);
  screenBattle.classList.toggle('hidden', !battle);
  document.querySelectorAll('[data-battle-only]').forEach((t) =>
    t.classList.toggle('hidden', !battle));
  // 3D-рендер работает только в бою
  if (battle) arena.start(); else arena.stop();
  if (isCastleLayout()) {
    closeLocPanel();
    if (battle) openCastleDock('members'); else closeCastleDock();
  } else {
    activateTab(battle ? 'members' : 'chat');
  }
  applyUILayout();
}

// ---------------------------------------------------------------------------
// Локации
// ---------------------------------------------------------------------------

// локация игрока в БД сервера; клиентские локации (Замок) её не меняют
let serverLocId = null;

/** Переход между локациями: серверные — после подтверждения сервера. */
async function gotoLocation(key) {
  const loc = LOCATIONS[key];
  // оффлайн, чисто клиентская локация или возврат из клиентской в свою
  // серверную (Замок → Город Надежды): сервер дёргать не нужно
  if (!online || !loc.id || loc.id === serverLocId) {
    setLocation(key);
    return;
  }
  try {
    await api.move(loc.id);
    serverLocId = loc.id;
    setLocation(key);
    refreshPlayers();
  } catch (e) {
    showToast('Туда не пройти: ' + e.message);
  }
}

// иконки кнопок локации (inline-SVG — эмодзи в UI рендерятся нестабильно)
const ICON_GO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13.5 6.5 19 12l-5.5 5.5"/></svg>`;
const ICON_HUNT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 4.5 15.5 15.5M19.5 4.5 8.5 15.5"/><path d="M14 17.2 17.2 14M10 17.2 6.8 14"/><path d="M16.2 16.2 19 19M7.8 16.2 5 19"/></svg>`;
const ICON_ACT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l1.8 5.4L19 12l-5.2 2.6L12 20l-1.8-5.4L5 12l5.2-2.6L12 4Z"/></svg>`;

function makeButton(className, html, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.innerHTML = html;
  b.addEventListener('click', onClick);
  return b;
}

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
  items.append(...buttons);
  group.append(head, items);
  locActions.appendChild(group);
}

function renderLocationActions(loc) {
  locActions.innerHTML = '';
  const transitions = loc.actions.filter((a) => a.goto);
  const acts = loc.actions.filter((a) => !a.goto);

  renderActionGroup('Переходы', transitions.map((a) =>
    makeButton('loc-chip',
      `<span class="lc-ico">${ICON_GO}</span><span>${esc(a.label)}</span>`,
      () => gotoLocation(a.goto))));

  renderActionGroup('Действия', acts.map((a) =>
    makeButton('loc-btn' + (a.hunt ? ' hunt' : ''),
      `<span class="lc-ico">${a.hunt ? ICON_HUNT : ICON_ACT}</span><span>${esc(a.label)}</span>`,
      () => {
        if (a.hunt) startBattle();
        else showToast(`«${a.label}» — заглушка: модуль действий подключается отдельно`);
      })));

  renderActionGroup('Жители', (loc.npc || []).map((n) =>
    makeButton('npc-chip',
      `<span class="npc-ava">${esc(n.name.trim()[0])}</span><span>${esc(n.name)}</span>`,
      () => showToast(`Диалог с «${n.name}» — заглушка: модуль NPC подключается отдельно`))));
}

function setLocation(key, { quiet = false } = {}) {
  currentLoc = key;
  const loc = LOCATIONS[key];
  locPicture.style.background = loc.image
    ? `#111 url("${loc.image}") center / cover no-repeat`
    : loc.css;
  $('loc-name').textContent = loc.name;
  if (!quiet) chatMessage('Система', `Вы вошли в локацию «${loc.name}».`, true);
  closeLocPanel();
  closeCastleDock();
  applyUILayout();
  renderLocationActions(loc);
}

// ---------------------------------------------------------------------------
// Бой
// ---------------------------------------------------------------------------

let battle = null;
let ui = null;
let battleLoading = false;
let fighters = { left: null, right: null };
let totalDamage = 0;     // суммарный урон игрока за текущий бой

const BATTLE_ERRORS = {
  target_offline: 'игрок не в сети',
  target_busy: 'игрок уже в бою',
  already_in_battle: 'вы уже в бою',
  cannot_attack_self: 'нельзя напасть на себя',
  not_same_location: 'игрок в другой локации',
  no_hunt_here: 'здесь не на кого охотиться',
};

/**
 * Единая точка входа в бой.
 *  - охота:  enterBattle()
 *  - PvP:    enterBattle({ starter: () => ServerBattle.attack(id) })
 *  - возврат после F5 / на нас напали: enterBattle({ resumed, notice })
 */
async function enterBattle({ starter = null, resumed = null, notice = null } = {}) {
  if (mode === 'battle' || battleLoading) {
    if (!resumed) showToast('Вы уже в бою!');
    return;
  }
  if (!resumed && !online) {
    showToast('Бой требует подключения к серверу');
    return;
  }
  // нападение могло застать игрока в гардеробе — закрываем его
  if (!dressingEl.classList.contains('hidden')) {
    dressingEl.classList.add('hidden');
    dressing.stop();
  }
  setMode('battle');
  arena.setBackground(LOCATIONS[currentLoc]);
  if (notice) showToast(notice);
  await initBattle(resumed, starter);
}

const startBattle = () => enterBattle();
const startPvp = (target) =>
  enterBattle({ starter: () => ServerBattle.attack(target.id) });

/** Возврат в идущий бой после F5/обрыва связи, либо на нас напали. */
function resumeBattle(serverBattle) {
  console.log('Возврат в бой', serverBattle.battleId,
    'mode=', mode, 'loading=', battleLoading);
  return enterBattle({
    resumed: serverBattle,
    notice: serverBattle.fresh
      ? '⚔ На вас напали! Бой начинается'
      : 'Бой продолжается — возвращаемся',
  });
}

async function initBattle(resumedBattle = null, starter = null) {
  if (battleLoading) return;
  battleLoading = true;
  loadingEl.classList.remove('hidden');
  if (ui) ui.destroy();
  if (battle) battle.destroy();

  try {
    [fighters.left, fighters.right] = await Promise.all([
      arena.addFighter('left', FIGHTERS.brawler),
      arena.addFighter('right', FIGHTERS.brawlerElite),
    ]);
    // надетое переживает перезапуск боя
    await Promise.all([syncEquipment('left'), syncEquipment('right')]);
  } catch (e) {
    console.error('Загрузка бойцов:', e);
    showToast('Не удалось загрузить бойцов: ' + e.message);
    setMode('location');
    return;
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
    if (battle.kind === 'pvp' && e.detail.canAct === false) ui.showWaitTimer();
    else ui.showControls();
  });

  battle.addEventListener('timer', (e) => ui.setTimer(e.detail.timeLeft));

  battle.addEventListener('resolve', async (e) => {
    if (battle.kind === 'pvp') ui.showWaitTimer();
    else ui.hideControls(false);
    for (const side of e.detail.passed || []) {
      ui.log(`<b>${esc(e.detail.sides[side].name)}</b> пропускает ход`);
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

    const who = esc(sides[s.attacker].name);
    const whom = esc(sides[s.defender].name);
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
    ui.log(`<b>${esc(sides[s.defender].name)}</b> повержен!`);
  }
}

// ---------------------------------------------------------------------------
// Нижняя панель: вкладки и жест расширения
// ---------------------------------------------------------------------------

/** Переключить активную вкладку/панель (только DOM, без состояния дока). */
function activateTab(name) {
  document.querySelectorAll('.dock-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.pane === name));
  document.querySelectorAll('.dock-pane').forEach((p) =>
    p.classList.toggle('active', p.id === 'pane-' + name));
  if (name === 'players') refreshPlayers();
  // пока панель была скрыта, scrollTop не применялся — догоняем при открытии
  if (name === 'chat') scrollChatToBottom();
}

document.querySelectorAll('.dock-tab').forEach((t) => {
  t.addEventListener('click', () => {
    if (isCastleLayout()) openCastleDock(t.dataset.pane);
    else activateTab(t.dataset.pane);
  });
});

$('loc-scene-close')?.addEventListener('click', () => closeLocPanel());

// --- расширение нижнего окна жестом: зажать ручку (или ряд вкладок) и
// повести вверх — окно растёт; вниз или тап по ручке — исходная высота ---

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

const dockMaxHeight = () => {
  if (isCastleLayout()) {
    const menuH = castleMainMenu?.getBoundingClientRect().height ?? 100;
    return Math.max(140, Math.round(window.innerHeight * 0.52 - menuH));
  }
  return Math.round(window.innerHeight * 0.72);
};

function dockSnap(expand) {
  dockExpanded = expand;
  dockEl.classList.add('dock-anim');
  dockEl.style.height = expand ? dockMaxHeight() + 'px' : '';
}

function dockPointerDown(e) {
  if (dockDrag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (isCastleLayout() && !dockEl.classList.contains('dock-open')) return;
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
const dockBodyEl = dockEl.querySelector('.dock-body');
dockBodyEl?.addEventListener('pointerdown', (e) => {
  if (!isCastleLayout() || !dockEl.classList.contains('dock-open')) return;
  if (e.target.closest('input, button, a, .chat-input-row, .pvp-btn')) return;
  dockPointerDown(e);
});
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

// ---------------------------------------------------------------------------
// Чат локации: отправка на сервер, своё сообщение возвращается из pub/sub
// ---------------------------------------------------------------------------

const chatLog = $('chat-log');
const MAX_CHAT_LINES = 150;   // история не растёт бесконечно

/** Системный шум из истории — не показываем при входе (объявления боёв и т.п.). */
function isChatJunk(sender, body) {
  const s = String(body || '').trim();
  if (!s) return true;
  if (sender !== 'Система') return false;
  return /^⚔\s*Бой #\d+/.test(s) || /^Вы вошли в локацию/.test(s);
}

/** Прокрутить чат к последним сообщениям (после загрузки истории / открытия). */
function scrollChatToBottom() {
  requestAnimationFrame(() => {
    chatLog.scrollTop = chatLog.scrollHeight;
    requestAnimationFrame(() => { chatLog.scrollTop = chatLog.scrollHeight; });
  });
}

/** История чата локации: только сообщения игроков и полезные системные. */
function loadChatHistory(rows) {
  chatLog.innerHTML = '';
  for (const h of rows) {
    if (isChatJunk(h.sender_name, h.body)) continue;
    appendChatLine(h.sender_name, h.body, h.sender_name === 'Система');
  }
  scrollChatToBottom();
}

function appendChatLine(author, text, system = false) {
  const line = document.createElement('div');
  line.className = 'chat-line' + (system || author === 'Система' ? ' system' : '');
  const b = document.createElement('b');
  b.textContent = system || author === 'Система' ? `[${author}]` : author;
  line.appendChild(b);
  line.appendChild(document.createTextNode(': '));
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
  while (chatLog.children.length > MAX_CHAT_LINES) chatLog.firstChild.remove();
}

function chatMessage(author, text, system = false) {
  appendChatLine(author, text, system);
  scrollChatToBottom();
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

// ---------------------------------------------------------------------------
// Список игроков в локации — живой, из Redis-присутствия сервера
// ---------------------------------------------------------------------------

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
        atk.type = 'button';
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
    // надетая демо-вещь живёт локально — серверный снимок её не сбрасывает
    const cur = equipState.left[slot];
    if (cur && ITEMS[cur]?.demo && !equippedBySlot[slot]) continue;
    equipState.left[slot] = equippedBySlot[slot] || null;
  }
}

// Желаемое состояние экипировки. Единственный источник правды:
// UI меняет его, а syncEquipment приводит бойцов в соответствие.
// Так нет гонок между кликами и пересозданием бойцов при рестарте боя.
const equipState = { left: {}, right: {} };   // side -> slot -> itemKey | null
const syncLocks = { left: Promise.resolve(), right: Promise.resolve() };

function syncEquipment(side) {
  // очередь на бойца: одновременные вызовы выполняются по одному
  syncLocks[side] = syncLocks[side].then(async () => {
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
      renderDressingUI();
    }
  }).catch((e) => console.error('Ошибка экипировки:', e));
  return syncLocks[side];
}

function toggleEquip(side, itemKey) {
  const item = ITEMS[itemKey];
  const prev = equipState[side][item.slot] || null;
  const next = prev === itemKey ? null : itemKey;
  equipState[side][item.slot] = next;
  // на сервер уходит только своё и только реальные вещи: демо-вещи и правая
  // кукла живут локально
  if (side === 'left' && !item.demo && !(prev && ITEMS[prev]?.demo)) {
    syncServerEquip(item.slot, next, prev);
  }
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
    renderDressingUI();
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

// ---------------------------------------------------------------------------
// Гардероб (примерочная): только СВОЙ персонаж, вещи меряются на нём
// ---------------------------------------------------------------------------

const dressingEl = $('dressing');
const dressingItemsEl = $('dressing-items');
const dressing = new DressingRoom($('dressing-view'));
const dressingSide = 'left';   // одевать можно только себя
let dressingBusy = false;
let selectedSlot = null;       // клик по пустому слоту куклы подсвечивает вещи

// иконки-призраки пустых слотов куклы (inline-SVG в стиле остального UI)
const SLOT_ICONS = {
  head: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 14a7 7 0 0 1 14 0v4h-3l-1-3h-6l-1 3H5v-4Z"/><path d="M12 4v3"/></svg>`,
  shoulders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a5 5 0 0 1 5-5l1 3-2 6a6 6 0 0 1-4-4Z"/><path d="M20 12a5 5 0 0 0-5-5l-1 3 2 6a6 6 0 0 0 4-4Z"/></svg>`,
  mainhand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 4.5 8 15M18.5 4.5l1 .0-0.5 3L9.5 16.5"/><path d="m7 14 3 3-2.5 2.5L5 17l2-3Z"/></svg>`,
  torso: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 5.5 6.5 7 11l2-1v9h6v-9l2 1 1.5-4.5L15 4l-3 2-3-2Z"/></svg>`,
  belt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h18v4H3z"/><rect x="9.5" y="8.5" width="5" height="7" rx="1"/></svg>`,
  amulet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4c2 3 4.5 4.5 7 4.5S17 7 19 4"/><path d="M12 8.5v3"/><path d="M12 11.5 9.8 14l2.2 4 2.2-4-2.2-2.5Z"/></svg>`,
  hands: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20V9.5M8 9.5V5a1.2 1.2 0 0 1 2.4 0v4M10.4 9V4a1.2 1.2 0 0 1 2.4 0v5M12.8 9V5a1.2 1.2 0 0 1 2.4 0v6.5l2-2a1.4 1.4 0 0 1 2 2L15.5 16v4"/></svg>`,
  offhand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c2.5 1.5 5 2.2 7 2.2 0 7-2.5 11.5-7 14.8-4.5-3.3-7-7.8-7-14.8 2 0 4.5-.7 7-2.2Z"/></svg>`,
  legs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8l1 16h-4.5L12 12l-.5 8H7L8 4Z"/></svg>`,
  feet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v8l-4 3v3h9l5-2c0-2-1.5-3.5-4-4l-2-1V4H9Z"/></svg>`,
};

/** Кукла и рюкзак рисуются всегда вместе — состояние у них общее. */
function renderDressingUI() {
  renderDoll();
  renderInventory();
}

/** Кукла: ячейки слотов в колонках слева/справа от 3D-окна. */
function renderDoll() {
  for (const side of ['left', 'right']) {
    const col = $('doll-' + side);
    col.innerHTML = '';
    for (const [slot, meta] of Object.entries(SLOT_META)) {
      if (meta.side !== side) continue;
      const key = equipState[dressingSide][slot] || null;
      const item = key ? ITEMS[key] : null;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'doll-cell' + (item ? ' filled' : '')
        + (selectedSlot === slot ? ' selected' : '');
      cell.title = item ? `${meta.name}: ${item.name} (клик — снять)` : meta.name;
      cell.innerHTML = item
        ? `<span class="dc-item">${item.icon || '📦'}</span>`
        : `<span class="dc-ghost">${SLOT_ICONS[slot] || ''}</span>`;
      cell.addEventListener('click', () => {
        if (item) {                       // надето — клик снимает
          selectedSlot = null;
          toggleDressingEquip(key);
        } else {                          // пусто — подсветить подходящие вещи
          selectedSlot = selectedSlot === slot ? null : slot;
          renderDressingUI();
          if (selectedSlot && !dressingItemsEl.querySelector('.inv-item.match')) {
            showToast(`Нет вещей в слот «${meta.name}»`);
          }
        }
      });
      col.appendChild(cell);
    }
  }
}

function renderInventory() {
  dressingItemsEl.innerHTML = '';
  // онлайн: каждая вещь рюкзака с сервера — отдельная строка (включая
  // дубликаты и предметы без 3D) + локальные демо-вещи в конце;
  // оффлайн — весь набор из ITEMS
  const demoRows = Object.keys(ITEMS)
    .filter((k) => ITEMS[k].demo)
    .map((key) => ({ key, inst: null }));
  const rows = online && serverInv.length
    ? [...serverInv.map((it) => ({ key: itemKeyFor(it), inst: it })), ...demoRows]
    : Object.keys(ITEMS).map((key) => ({ key, inst: null }));
  for (const { key, inst } of rows) {
    const item = ITEMS[key]
      || { name: inst.name, icon: '📦', slot: slotNameFor(inst.slot) };
    const slotName = inst ? slotNameFor(inst.slot) : item.slot;
    const equipped = !!slotName && equipState[dressingSide][slotName] === key;
    const row = document.createElement('div');
    row.className = 'inv-item';
    // выбран пустой слот куклы: подходящие вещи подсвечиваются, прочие гаснут
    if (selectedSlot) {
      row.classList.add(slotName === selectedSlot ? 'match' : 'dim');
    }
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
    if (slotName) {       // бейдж слота: понятно, куда вещь надевается
      const badge = document.createElement('span');
      badge.className = 'inv-slot';
      badge.textContent = SLOT_META[slotName]?.name || slotName;
      head.appendChild(badge);
    }
    const actions = document.createElement('div');
    actions.className = 'inv-actions';
    if (slotName) {       // вещь надевается — кнопка «Надеть/Снять»
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'inv-btn' + (equipped ? ' equipped' : '');
      b.disabled = dressingBusy;
      b.textContent = dressingBusy ? 'Загрузка…' : (equipped ? 'Снять' : 'Надеть');
      b.addEventListener('click', () => {
        selectedSlot = null;
        toggleDressingEquip(key);
      });
      actions.appendChild(b);
    }
    row.append(head, actions);
    dressingItemsEl.appendChild(row);
  }
}

async function openDressing() {
  dressingEl.classList.remove('hidden');
  $('doll-level').textContent = PLAYER.level;
  dressing.start();
  dressingBusy = true;
  selectedSlot = null;
  renderDressingUI();
  try {
    // свежий рюкзак с сервера: выданные/полученные вещи появляются сразу
    if (online) {
      try { registerServerItems(await api.inventory()); }
      catch (e) { console.error('Обновление рюкзака:', e); }
    }
    await dressing.show(FIGHTERS.brawler);
    // автоскиннинг тяжёлых FBX — в фоне, пока смотрим рюкзак
    dressing.prefetchItems(Object.values(ITEMS).filter((i) => i.model));
    await syncDressing(false);
  } finally {
    dressingBusy = false;
    renderDressingUI();
  }
}

$('doll-zoom-in').addEventListener('click', () => dressing.zoom(1.2));
$('doll-zoom-out').addEventListener('click', () => dressing.zoom(1 / 1.2));

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
  renderDressingUI();
  try {
    toggleEquip(dressingSide, itemKey);   // состояние + бойцы на арене (очередь)
    await syncDressing();                 // персонаж в примерочной
  } finally {
    dressingBusy = false;
    renderDressingUI();
  }
}

$('dressing-close').addEventListener('click', () => {
  dressingEl.classList.add('hidden');
  dressing.stop(); // рендер-цикл примерочной не жрёт GPU, пока она закрыта
});

// ---------------------------------------------------------------------------
// Навигация: круглые кнопки + заглушки + меню первой локации
// ---------------------------------------------------------------------------

const toast = $('toast');
let toastTimer = null;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

const CASTLE_STUBS = {
  mail: 'Почта',
  auction: 'Аукцион',
};

castlePerimeter?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-castle]');
  if (!btn) return;
  const id = btn.dataset.castle;
  if (id === 'bag') openDressing();
  else if (id === 'hunt') startBattle();
  else if (CASTLE_STUBS[id]) {
    showToast(`Модуль «${CASTLE_STUBS[id]}» подключается отдельно — пока заглушка`);
  }
});

castleMainMenu?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mm]');
  if (!btn || btn.disabled) return;
  const id = btn.dataset.mm;
  if (id === 'location') toggleLocPanel();
  else if (CASTLE_DOCK_PANES.has(id)) openCastleDock(id);
  else if (id === 'clan') showToast('Модуль «Клан» подключается отдельно — пока заглушка');
});

$('nav-bag').addEventListener('click', () => openDressing());
$('nav-hunt').addEventListener('click', () => startBattle());

document.querySelectorAll('[data-stub]').forEach((btn) => {
  btn.addEventListener('click', () => {
    showToast(`Модуль «${btn.dataset.stub}» подключается отдельно — пока заглушка`);
  });
});

// ---------------------------------------------------------------------------
// Старт: игрок появляется в Городе Надежды
// ---------------------------------------------------------------------------

renderPlayerPlate();

// отладочный доступ из консоли
window.__arena = arena;
window.__debug = () => ({ arena, dressing, ITEMS, equipState, fighters, battle, ui });

// Боевой сервер пускает только через Telegram Mini App (dev-вход выключен).
// Если игру открыли в обычном браузере — показываем ссылку на бота.
const setBoot = (text) => window.setBootStatus?.(text);
const finishBoot = () => window.finishBoot?.();

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
    setBoot('Вход в игру…');
    const ch = await api.login(PLAYER.name);
    online = true;
    applyCharacter(ch);

    setBoot('Загрузка рюкзака…');
    // вещи с сервера: знакомым ключам — 3D-модели из ITEMS, остальные
    // добавляются без модели (noModel), чтобы видно было ВСЁ имущество
    registerServerItems(await api.inventory());

    setBoot('Загрузка чата…');
    // чат: история без системного шума, затем живые сообщения
    api.onChat((m) => chatMessage(m.from, m.text));
    loadChatHistory(await api.chatHistory());

    serverLocId = ch.location_id;
    setLocation(LOC_BY_ID[ch.location_id] || 'village', { quiet: true });
    refreshPlayers();
  } catch (e) {
    if (e.message === 'dev_auth_disabled') {
      document.querySelector('.game')?.classList.add('hidden');
      showTelegramGate();
      return;
    }
    console.error('Сервер недоступен, оффлайн-режим:', e);
    showToast('Сервер недоступен — игра в оффлайн-режиме');
    setLocation('village', { quiet: true });
  } finally {
    // если за время загрузки сервер вернул идущий бой (battleResume),
    // режим уже «бой» — не выкидываем игрока обратно в локацию
    if (mode !== 'battle' && !battleLoading) setMode('location');
    finishBoot();
    scrollChatToBottom();
  }
})();
