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
 * На локациях нижняя панель (чат/игроки/участники/лог)
 * выдвигается иконками меню, на остальных — постоянные вкладки.
 */
import { Arena } from './arena/Arena.js';
import { api, ServerBattle } from './net/net.js';
import { BattleUI } from './arena/BattleUI.js';
import { DressingRoom } from './arena/DressingRoom.js';
import { FIGHTERS, LOCATIONS, ITEMS, SLOT_META, SPELLS, SPELL_SLOTS, ELIXIR_SLOTS } from './content.js';

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

// --- Полноэкранный режим (по умолчанию включён) -----------------------------
// Выбор хранится локально; requestFullscreen/exitFullscreen появились в Bot API
// 8.0 — в старых клиентах их нет, тогда просто разворачиваем (expand).
const FS_KEY = 'arena.fullscreen';
const fullscreenPref = () => {
  try { return localStorage.getItem(FS_KEY) !== '0'; } catch { return true; }
};
// методы Telegram объявлены всегда, но в старых клиентах лишь логируют «not
// supported» — поэтому проверяем версию, а не наличие метода.
const tgSupports = (v) => !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v));
function applyFullscreen(on) {
  if (!tgSupports('8.0')) return;   // fullscreen API — Bot API 8.0+
  try { if (on) tg.requestFullscreen(); else tg.exitFullscreen(); } catch {}
}
function setFullscreenPref(on) {
  try { localStorage.setItem(FS_KEY, on ? '1' : '0'); } catch {}
  applyFullscreen(on);
  window.dispatchEvent(new Event('arena:viewportModeChanged'));
}

// --- Подсказки в бою (по умолчанию включены) --------------------------------
// Класс body.hints-off гасит мигание секторов/щитов на колесе (см. game.css).
const HINTS_KEY = 'arena.hints';
const hintsPref = () => {
  try { return localStorage.getItem(HINTS_KEY) !== '0'; } catch { return true; }
};
function applyHints(on) { document.body.classList.toggle('hints-off', !on); }
function setHintsPref(on) {
  try { localStorage.setItem(HINTS_KEY, on ? '1' : '0'); } catch {}
  applyHints(on);
}
applyHints(hintsPref());

// --- Показывать «Участников» при старте боя (по умолчанию да) ----------------
const MEMBERS_START_KEY = 'arena.membersOnStart';
const membersOnStartPref = () => {
  try { return localStorage.getItem(MEMBERS_START_KEY) !== '0'; } catch { return true; }
};
function setMembersOnStartPref(on) {
  try { localStorage.setItem(MEMBERS_START_KEY, on ? '1' : '0'); } catch {}
}

// Безопасные зоны: device (safeAreaInset: вырез/статус-бар) + контентная
// (contentSafeAreaInset: место под плавающими кнопками Telegram ✕/⋯ сверху).
// Кладём суммой в CSS-переменные --tg-inset-* — по ним бокс игры вписывается в
// безопасную область (см. game.css). Вне Telegram остаются нули.
function syncTgInsets() {
  if (!tg) return;
  const sa = tg.safeAreaInset || {};
  const ca = tg.contentSafeAreaInset || {};
  const s = document.documentElement.style;
  const px = (a, b) => Math.max(0, Math.round((a || 0) + (b || 0))) + 'px';
  s.setProperty('--tg-inset-top', px(sa.top, ca.top));
  s.setProperty('--tg-inset-bottom', px(sa.bottom, ca.bottom));
  s.setProperty('--tg-inset-left', px(sa.left, ca.left));
  s.setProperty('--tg-inset-right', px(sa.right, ca.right));
  s.setProperty('--tg-safe-top', px(sa.top, 0));   // только устройство — для строки сети
  // строка сети показывается только в полноэкранном режиме (есть верхняя полоса)
  document.body.classList.toggle('tg-fullscreen', !!tg.isFullscreen);
}

if (tg) {
  tg.ready();
  tg.expand();
  if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
  // предупреждение при выходе (свайп вниз / нативная кнопка ✕ «Закрыть»)
  if (tgSupports('6.2') && tg.enableClosingConfirmation) tg.enableClosingConfirmation();
  applyFullscreen(fullscreenPref());
  syncTgInsets();
  ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged'].forEach((ev) => {
    try { tg.onEvent(ev, syncTgInsets); } catch {}
  });
}

// --- Выход из игры (с подтверждением) ---------------------------------------
function closeApp() {
  if (tg) {
    // мы уже спросили подтверждение сами — снимаем нативное, чтобы не спрашивали дважды
    try { tg.disableClosingConfirmation && tg.disableClosingConfirmation(); } catch {}
    if (tg.close) { tg.close(); return; }
  }
  window.close();
}
function confirmExit() {
  const msg = 'Выйти из игры?';
  if (tgSupports('6.2') && tg.showConfirm) tg.showConfirm(msg, (ok) => { if (ok) closeApp(); });
  else if (window.confirm(msg)) closeApp();
}

// --- Окно настроек (шестерёнка в шапке) -------------------------------------
(() => {
  const el = $('settings');
  if (!el) return;
  const fsInput = $('set-fullscreen');
  const hintsInput = $('set-hints');
  const membersStartInput = $('set-members-start');
  const open = () => {
    if (fsInput) fsInput.checked = fullscreenPref();
    if (hintsInput) hintsInput.checked = hintsPref();
    if (membersStartInput) membersStartInput.checked = membersOnStartPref();
    el.classList.remove('hidden');
  };
  const close = () => el.classList.add('hidden');
  $('pp-settings')?.addEventListener('click', open);
  $('settings-close')?.addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  fsInput?.addEventListener('change', () => setFullscreenPref(fsInput.checked));
  hintsInput?.addEventListener('change', () => setHintsPref(hintsInput.checked));
  membersStartInput?.addEventListener('change', () => setMembersOnStartPref(membersStartInput.checked));
  $('settings-exit')?.addEventListener('click', confirmExit);

  // Принудительный сброс кэша: Telegram WebView держит старые index.html/js/css
  // и ES-модули. Перекачиваем все app-файлы мимо кэша (cache:'reload') и
  // перезагружаемся — после обновления игрок видит свежую версию без чистки
  // кэша в настройках Telegram. vendor/ (three.js) и картинки не трогаем.
  const refreshBtn = $('settings-refresh');
  refreshBtn?.addEventListener('click', async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    const nameEl = refreshBtn.querySelector('.settings-action-name');
    if (nameEl) nameEl.textContent = 'Обновление…';
    try {
      const urls = performance.getEntriesByType('resource').map((e) => e.name)
        .filter((u) => u.startsWith(location.origin)
          && /\.(m?js|css)(\?|$)/.test(u)
          && !/\/vendor\//.test(u));
      urls.push(location.href);
      await Promise.allSettled(urls.map((u) => fetch(u, { cache: 'reload' })));
    } catch {}
    location.reload();
  });
})();

// --- Строка сети: пинг до сервера + полоска загрузки данных ------------------
// Видна в полноэкранном режиме (CSS: body.tg-fullscreen) — по центру вверху,
// между кнопками Telegram «Закрыть» и «свернуть». Полоска загорается, пока есть
// активные сетевые запросы (REST-данные); пинг меряем лёгким /api/health.
(() => {
  const apiBase = window.API_URL || 'http://localhost:8080';
  const dot = $('net-dot');
  const val = $('net-ping-val');
  const bar = $('net-loadbar');
  const rawFetch = window.fetch.bind(window);

  // индикатор загрузки: считаем активные запросы, оборачивая fetch
  let pending = 0;
  const isHealth = (u) => /\/api\/health(\?|$)/.test(u);
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (isHealth(u)) return rawFetch(input, init);   // пинг бар не мигает
    pending++;
    bar?.classList.add('busy');
    return rawFetch(input, init).finally(() => {
      if (--pending <= 0) { pending = 0; bar?.classList.remove('busy'); }
    });
  };

  const show = (ms) => {
    if (!dot || !val) return;
    if (ms == null) { val.textContent = '—'; dot.dataset.q = 'bad'; return; }
    val.textContent = ms + ' мс';
    dot.dataset.q = ms < 120 ? 'good' : ms < 300 ? 'ok' : 'bad';
  };
  const ping = async () => {
    // в фоне (Mini App свёрнут / экран погашен) не шлём health-запросы:
    // setInterval в фоне не останавливается сам, а сеть/радио зря не будим
    if (document.hidden) return;
    const t0 = performance.now();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    try {
      await rawFetch(apiBase + '/api/health', { cache: 'no-store', signal: ctrl.signal });
      show(Math.round(performance.now() - t0));
    } catch { show(null); } finally { clearTimeout(to); }
  };
  ping();
  setInterval(ping, 5000);
})();

// ---------------------------------------------------------------------------
// Каркас: элементы, режимы экрана, UI локации
// ---------------------------------------------------------------------------

const screenLocation = $('screen-location');
const screenBattle = $('screen-battle');
const arenaStage = $('arena-stage');
const loadingEl = $('arena-loading');
// заставку загрузки переносим в <body>: внутри .arena-stage она в стек-контексте
// .game-mid (z1) и НИЖЕ нижнего дока (.castle-bottom z5) — док «мелькал» поверх
// неё, пока гас по opacity на входе в бой (#2). В body (fixed, z120) кроет всё.
document.body.appendChild(loadingEl);
const locActions = $('loc-actions');
const locBody = $('loc-body');
const battlesBody = $('battles-body');
const battlesList = $('battles-list');
const locSceneTitle = $('loc-scene-title');
const castleBg = $('castle-bg');
const castlePerimeter = $('castle-perimeter');
const castleMainMenu = $('castle-main-menu');
const dockEl = $('bottom-dock');
const battleForeground = $('battle-foreground');

let mode = 'location';   // 'location' | 'battle'
let currentLoc = 'village';

// канвас живёт в скрытом до боя arena-stage; Arena сама подхватит размер,
// когда экран боя станет видимым (ResizeObserver). Рендер-цикл запускается
// только на время боя (setMode) — вне боя GPU не работает вхолостую.
const arena = new Arena(arenaStage, { autostart: false });

// --- состояние UI локации ---
let locPanelOpen = false;                 // всплывающая панель «Локация»
let battlesPanelOpen = false;             // панель «Текущие бои»
let battlesTimer = null;
let castleDockPane = null;                // 'members'|'battlelog'|'players'|'chat'|null
const CASTLE_DOCK_PANES = new Set(['members', 'battlelog', 'chat', 'players']);
const BATTLE_ONLY_PANES = new Set(['members', 'battlelog']);

/** Применить фон и подписи текущей локации. */
function applyUILayout() {
  const loc = LOCATIONS[currentLoc];
  // в бою фон — общая 9:16 арена (back_arena): её центральный круг приходится
  // на бойцов, нижняя часть — под окна (участники/лог/чат). Вне боя — фон локации.
  // `auto 108% bottom`: низ (камень/колонны) прижат к низу, картинка чуть
  // увеличена и поднята — круг встаёт под ноги бойцов (крутить % высоты тут).
  castleBg.style.background = mode === 'battle'
    ? '#0a0e07 url("assets/fight/back_arena2.webp") center bottom / auto 108% no-repeat'
    : (loc.image
        ? `#0a0e07 url("${loc.image}") center / cover no-repeat`
        : (loc.css || '#0a0e07'));
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
  locPanelOpen = force ?? !locPanelOpen;
  locBody.classList.toggle('open', locPanelOpen);
  if (locPanelOpen) { closeBattlesPanel(); closeCastleDock(); }
  updateCastleMainMenu();
}

function closeLocPanel() {
  if (!locPanelOpen) return;
  locPanelOpen = false;
  locBody.classList.remove('open');
  updateCastleMainMenu();
}

function closeBattlesPanel() {
  battlesPanelOpen = false;
  battlesBody?.classList.remove('open');
  clearInterval(battlesTimer);
  battlesTimer = null;
  castlePerimeter?.querySelector('[data-castle="battles"]')
    ?.classList.remove('active');
}

async function toggleBattlesPanel(force) {
  if (mode === 'battle') {
    showToast('Список боёв доступен вне боя');
    return;
  }
  battlesPanelOpen = force ?? !battlesPanelOpen;
  battlesBody?.classList.toggle('open', battlesPanelOpen);
  castlePerimeter?.querySelector('[data-castle="battles"]')
    ?.classList.toggle('active', battlesPanelOpen);
  if (battlesPanelOpen) {
    closeLocPanel();
    closeCastleDock();
    await refreshBattles();
    clearInterval(battlesTimer);
    battlesTimer = setInterval(() => {
      if (!battlesPanelOpen) { closeBattlesPanel(); return; }
      if (document.hidden) return;   // в фоне список боёв не опрашиваем
      refreshBattles();
    }, 2000);
  } else {
    closeBattlesPanel();
  }
}

function openCastleDock(pane) {
  if (BATTLE_ONLY_PANES.has(pane) && mode !== 'battle') {
    showToast('Эта панель доступна только во время боя');
    return;
  }
  if (castleDockPane === pane) {   // повторный тап по иконке — закрыть
    closeCastleDock();
    return;
  }
  closeLocPanel();
  closeBattlesPanel();
  castleDockPane = pane;
  dockEl.classList.add('dock-open');
  dockEl.dataset.pane = pane;      // у чата/игроков панель выше, чем у участников
  dockEl.style.height = '';
  dockExpanded = false;
  activateTab(pane);
  updateCastleMainMenu();
  updateBattleDockState();
  // запоминаем выбранное окно боя — чтобы восстановить его после F5/реконнекта
  if (mode === 'battle') saveBattlePane(pane);
}

/** Сохранить последнее выбранное окно боя (переживает перезагрузку страницы). */
function saveBattlePane(pane) {
  try { localStorage.setItem('arena.battlePane', pane); } catch {}
}
function loadBattlePane() {
  let pane = 'members';
  try { pane = localStorage.getItem('arena.battlePane') || 'members'; } catch {}
  return CASTLE_DOCK_PANES.has(pane) ? pane : 'members';
}

function closeCastleDock() {
  castleDockPane = null;
  dockEl.classList.remove('dock-open');
  delete dockEl.dataset.pane;
  dockEl.style.height = '';
  dockExpanded = false;
  updateCastleMainMenu();
  updateBattleDockState();
}

// какое окно открыть при входе в бой: свежий бой — всегда «Участники»;
// возврат в идущий бой (F5/реконнект) — последнее выбранное окно (см. enterBattle)
let battleEntryPane = 'members';

function updateBattleDockState() {
  const battleMode = mode === 'battle';
  const open = battleMode && dockEl.classList.contains('dock-open');
  document.body.classList.toggle('battle-dock-open', open);
  document.body.classList.toggle('battle-dock-closed', battleMode && !open);
  document.body.classList.toggle('battle-dock-expanded', open && dockExpanded);
  updateBattleInfo();            // освежить «Сводку боя» (видна, когда окна скрыты)
  window.dispatchEvent(new Event('arena:layoutChanged'));
}

// --- «Сводка боя»: пассивная инфо-панель в нижней зоне, когда все окна скрыты --
// Стоит на месте окон — поэтому скрытие/показ окна не двигает сцену и слоты.
const BATTLE_TIPS = [
  'Выберите щит — заблокируете удар в эту зону.',
  'Бейте в зону, которую враг не закрыл щитом.',
  'Эликсир мощи усиливает удары на несколько ходов.',
  'Эликсир здоровья восстанавливает HP прямо в бою.',
  'Тапните по участнику — выберете цель для эликсира.',
  'Окна боя открываются кнопками в нижнем меню.',
];
let biEls = null;
function ensureBattleInfo() {
  if (!battleForeground) return null;
  if (biEls && battleForeground.contains(biEls.root)) return biEls;
  battleForeground.innerHTML = `
    <div class="binfo-panel" aria-hidden="true">
      <div class="binfo-panel-head">Сводка боя</div>
      <div class="binfo-stats">
        <div class="bis"><span class="bis-k">Ход</span><span class="bis-v" data-bi="turn">1</span></div>
        <div class="bis"><span class="bis-k">Урон</span><span class="bis-v" data-bi="dmg">0</span></div>
        <div class="bis ally"><span class="bis-k">Союзники</span><span class="bis-v" data-bi="ally">—</span></div>
        <div class="bis enemy"><span class="bis-k">Противники</span><span class="bis-v" data-bi="enemy">—</span></div>
      </div>
      <div class="binfo-tip" data-bi="tip"></div>
    </div>`;
  const q = (s) => battleForeground.querySelector(s);
  biEls = {
    root: battleForeground.firstElementChild,
    turn: q('[data-bi="turn"]'), dmg: q('[data-bi="dmg"]'),
    ally: q('[data-bi="ally"]'), enemy: q('[data-bi="enemy"]'), tip: q('[data-bi="tip"]'),
  };
  return biEls;
}
function aliveCount(side) {
  const list = (battle && battle.roster && battle.roster[side]) || [];
  let alive = 0;
  for (const f of list) if (f.alive !== false && (f.hp == null || f.hp > 0)) alive++;
  return { alive, total: list.length };
}
function updateBattleInfo() {
  if (mode !== 'battle') return;
  const e = ensureBattleInfo();
  if (!e) return;
  const turn = lastTurnShown || 1;
  e.turn.textContent = turn;
  e.dmg.textContent = totalDamage;
  const a = aliveCount('left');
  const en = aliveCount('right');
  e.ally.textContent = `${a.alive}/${a.total}`;
  e.enemy.textContent = `${en.alive}/${en.total}`;
  e.tip.textContent = BATTLE_TIPS[(turn - 1) % BATTLE_TIPS.length];
}
function clearBattleInfo() {
  if (battleForeground) battleForeground.innerHTML = '';
  biEls = null;
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
  closeLocPanel();
  closeBattlesPanel();
  // в бою открываем стартовое окно, если оно задано (настройка «Участники при
  // старте боя» может его отключить → battleEntryPane=null → док закрыт)
  if (battle && battleEntryPane
      && (BATTLE_ONLY_PANES.has(battleEntryPane) || CASTLE_DOCK_PANES.has(battleEntryPane))) {
    openCastleDock(battleEntryPane);
  } else {
    closeCastleDock();
  }
  updateBattleDockState();
  applyUILayout();
  renderCombatBar();
  if (!battle) clearBattleInfo();   // вышли из боя — убрать «Сводку боя»
}

// ---------------------------------------------------------------------------
// Локации
// ---------------------------------------------------------------------------

// локация игрока в БД сервера
let serverLocId = null;

/** Переход между локациями: серверные — после подтверждения сервера. */
async function gotoLocation(key) {
  const loc = LOCATIONS[key];
  // оффлайн или уже в целевой локации — без запроса к серверу
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
  const transitions = loc.actions.filter((a) => a.goto || a.soon);
  const acts = loc.actions.filter((a) => !a.goto && !a.soon);

  renderActionGroup('Переходы', transitions.map((a) =>
    makeButton('loc-chip',
      `<span class="lc-ico">${ICON_GO}</span><span>${esc(a.label)}</span>`,
      () => {
        if (a.goto) gotoLocation(a.goto);
        else showToast(`«${a.label}» — пока недоступно`);
      })));

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
  if (!quiet) chatMessage('Система', `Вы вошли в локацию «${loc.name}».`, true);
  closeLocPanel();
  closeBattlesPanel();
  // при старте/F5 возврат в идущий бой и эта установка локации идут параллельно;
  // в бою НЕ закрываем док — иначе последнее открытое окно боя гаснет (#5)
  if (mode !== 'battle') closeCastleDock();
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
let lastTurnShown = 0;   // чтобы не дублировать «ход N» на sub-turn'ах раунда
let currentFocusId = null;   // id сфокусированного соперника — чтобы не пересобирать шапку зря

const BATTLE_ERRORS = {
  target_offline: 'игрок не в сети',
  target_busy: 'игрок уже в бою',
  already_in_battle: 'вы уже в бою',
  cannot_attack_self: 'нельзя напасть на себя',
  not_same_location: 'игрок в другой локации',
  no_hunt_here: 'здесь не на кого охотиться',
  intervention_closed: 'в этот бой нельзя вмешаться',
  battle_not_found: 'бой уже завершён',
  side_full: 'в команде нет места',
  bad_side: 'неверная сторона',
  not_your_turn: 'сейчас не ваш ход',
  invalid_move: 'ход невозможен',
};

/**
 * Единая точка входа в бой.
 *  - охота:  enterBattle()
 *  - PvP:    enterBattle({ starter: () => ServerBattle.attack(id) })
 *  - возврат после F5 / на нас напали: enterBattle({ resumed, notice })
 */
async function enterBattle({ starter = null, resumed = null, notice = null, pvpTarget = null } = {}) {
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
  // свежий бой открывает «Участники», если включена настройка (по умолчанию да);
  // возврат в идущий бой (F5/реконнект) — последнее выбранное окно (точки 6 и 7 ТЗ)
  battleEntryPane = resumed
    ? loadBattlePane()
    : (membersOnStartPref() ? 'members' : null);
  setMode('battle');
  // фон арены боя — assets/fight/background.webp (задаётся в CSS .in-battle .arena-stage);
  // отдельная картинка локации в бою не используется
  if (notice) showToast(notice);
  await initBattle(resumed, starter, pvpTarget);
}

const startBattle = () => enterBattle();
const startPvp = (target) =>
  enterBattle({ starter: () => ServerBattle.attack(target.id), pvpTarget: target });

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

/** Завершить «подготовку боя» (#3): показать собранный UI и убрать заставку. */
function endBattlePrep() {
  document.body.classList.remove('battle-prep');
  loadingEl.classList.add('fade-out');
  setTimeout(() => loadingEl.classList.add('hidden'), 340);
}

async function initBattle(resumedBattle = null, starter = null, pvpTarget = null) {
  if (battleLoading) return;
  battleLoading = true;
  // #3: прячем весь боевой UI за заставкой, пока всё не соберётся и не разместится
  document.body.classList.add('battle-prep');
  loadingEl.classList.remove('hidden', 'fade-out');
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
    endBattlePrep();
    setMode('location');
    return;
  } finally {
    battleLoading = false;
  }

  // бой создаёт и ведёт сервер: формулы те же (порт BattleSystem),
  // но урон, криты и награды решает только он
  try {
    battle = resumedBattle || await (starter || ServerBattle.hunt)();
  } catch (e) {
    if (e.message === 'target_busy' && e.battleId && pvpTarget) {
      showTargetBusyPrompt(pvpTarget, e);
    } else {
      showToast('Не удалось начать бой: ' + (BATTLE_ERRORS[e.message] || e.message));
    }
    if (battle) { battle.destroy(); battle = null; }
    endBattlePrep();
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
    selfId: PLAYER.id ?? battle.sides.left.id,   // себя не прячем при смерти (#2)
    onStrike: (move) => {
      ui.hideControls();
      setBeltLive(false);          // удар завершает ввод хода — пояс блокируется
      battle.submitMove('left', move);
    },
    onInfo: (side) => showFighterInfo(side),
    onMemberInfo: (id) => showMemberInfo(id),
  });
  await loadBelt();                // состав пояса с сервера (он его помнит)
  resetElixirBattle();             // эффекты с нуля; пояс уже загружен
  lastTurnShown = 0;
  currentFocusId = battle.focus ? (battle.focus.id ?? null) : null;
  showHP('left', battle.sides.left.hp, battle.sides.left.maxHp);
  showHP('right', battle.sides.right.hp, battle.sides.right.maxHp);
  ui.setRoster(battle.roster);
  ui.setOpponent(battle.focus);
  totalDamage = 0;
  ui.setDamage(0);
  ui.setEffects('left', []);
  ui.setEffects('right', []);
  // энергия пока без серверной механики — показываем пустые полосы
  ui.setEnergy('left', 0, 0);
  ui.setEnergy('right', 0, 0);
  updateBattleInfo();              // наполнить «Сводку боя» начальными данными

  // колесо ставим ровно между бойцами и пересчитываем при каждом ресайзе сцены;
  // заодно пересчитываем нижнюю панель (страницы эликсиров под ширину экрана)
  const layoutWheel = () => { if (ui) ui.placeWheel(arena.wheelLayout()); };
  arena.onResize = () => { layoutWheel(); layoutCombatBar(); };
  layoutWheel();
  requestAnimationFrame(layoutWheel);

  battle.addEventListener('turnStart', (e) => {
    const d = e.detail;
    if (d.turn !== lastTurnShown) { ui.setTurn(d.turn); lastTurnShown = d.turn; }
    ui.setTimer(d.timeLeft);
    if (d.roster) ui.setRoster(d.roster);
    updateBattleInfo();
    if (d.canAct) {                // мой ход
      applyFocus(d.focus);
      ui.setTargets();             // сохранить ручную цель эффекта (если есть)
      ui.showControls();
      setBeltLive(true);
    } else if (d.waiting) {        // ходит союзник — ждём своего соперника
      setOpponentVisible(false);
      ui.showWait();
      setBeltLive(false);
    } else {                       // ходит враг — смотрим на него
      applyFocus(d.focus);
      ui.showWaitTimer();
      setBeltLive(false);
    }
  });

  battle.addEventListener('timer', (e) => ui.setTimer(e.detail.timeLeft));

  battle.addEventListener('rosterUpdate', (e) => {
    if (e.detail.roster) ui.setRoster(e.detail.roster);
    updateBattleInfo();
  });

  battle.addEventListener('resolve', async (e) => {
    const d = e.detail;
    setBeltLive(false);            // ход разыгрывается — пояс блокируется
    ui.showResolving();            // колесо скрыто, баннер убран — видна анимация
    if (d.roster) ui.setRoster(d.roster);
    if (d.focus) applyFocus(d.focus);
    updateBattleInfo();
    // в журнал — только удары (#10): пропуски ход не логируем
    try {
      for (const s of d.strikes || []) {
        if (s.offscreen) {         // удар между другими бойцами — только в журнал
          ui.log(offscreenLog(s));
          continue;
        }
        await playStrike(s, d.sides);
      }
    } catch (err) {
      // анимация не должна «подвесить» бой — досрочно отдаём ход дальше
      console.error('Ошибка анимации удара:', err);
    } finally {
      // серверный счётчик «Эликсира мощи» убывает с каждым ударом — синхронизируем чип
      if (d.sides && d.sides.left && d.sides.left.buffTurns != null) {
        selfBuffTurns = d.sides.left.buffTurns;
        refreshSelfEffects();
      }
      battle.finishTurn();
    }
  });

  // Эликсир применил и СПИСАЛ сервер: обновляем ростер, остаток ячейки у пьющего,
  // и (если эффект пришёлся на меня) — HP/всплывашку/чип эффекта.
  battle.addEventListener('elixir', (e) => {
    const d = e.detail;
    if (d.roster) ui.setRoster(d.roster);
    updateBattleInfo();
    // остаток заряда в моей ячейке (пил я) — пояс авторитетно с сервера
    if (d.isUser && d.slot != null && elixirBelt[d.slot]) {
      if (d.slotQty != null && d.slotQty <= 0) elixirBelt[d.slot] = null;  // слот опустел (#2)
      else elixirBelt[d.slot].qty = d.slotQty;
      renderCombatBar();
    }
    // лог «кто что выпил» — пишет только пьющий у себя (избегаем дублей)
    if (d.isUser) {
      const name = esc(battle.sides.left.name);
      if (d.kind === 'health') ui.log(`<b>${name}</b> восстанавливает ${d.heal} HP`);
      else ui.log(`<b>${name}</b> усиливает удары на +${Math.round((d.mult - 1) * 100)}% (${d.turns} х.)`);
    }
    if (!d.onSelf) return;                   // эффект на союзника — дальше только ростер
    showHP('left', d.hp, d.maxHp);
    const pos = fighters.left
      ? arena.worldToScreen(fighters.left.headPoint()) : { x: 70, y: 90 };
    if (d.kind === 'health' && d.heal > 0) {
      ui.popup(pos, `+${d.heal}`, 'heal');
    } else if (d.kind === 'power') {
      const pct = Math.round((d.mult - 1) * 100);
      selfBuffPct = pct;
      ui.popup(pos, `Мощь +${pct}%`, 'crit');
    }
    selfBuffTurns = d.buffTurns || 0;
    refreshSelfEffects();
    renderCombatBar();         // мощь активна → её слот уходит на «перезарядку» (#3)
  });

  battle.addEventListener('battleEnd', (e) => {
    ui.hideControls();
    setBeltLive(false);
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
    ui.showEnd(victory, { onLeave: () => leaveBattle(true) });
  });

  battle.addEventListener('serverError', (e) => {
    const code = e.detail.error;
    if (code === 'not_your_turn' || code === 'invalid_move') {
      ui?.releasePendingStrike();
      showToast(BATTLE_ERRORS[code] || code);
      return;
    }
    showToast(code === 'no_escape_elixir'
      ? 'Покинуть бой можно только Эликсиром побега'
      : code === 'cannot_leave' ? 'Из боя нельзя просто уйти'
      : code === 'elixir_active' ? 'Эликсир мощи ещё действует'
      : code === 'belt_empty' ? 'Ячейка эликсира пуста'
      : 'Сервер: ' + code);
  });

  battle.activate?.();   // воспроизвести события, накопленные пока грузились модели

  // всё собрано и размещено — плавно показываем бой (сборку UI пользователь
  // не видел, элементы не «прыгают» по местам, #3)
  requestAnimationFrame(() => {
    layoutWheel();
    layoutCombatBar();
    endBattlePrep();
  });
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
  // 3D-модель не загрузилась — не валим розыгрыш, показываем удар в журнале
  if (!attacker || !defender) { ui.log(offscreenLog(s)); return; }

  // Урон (в т.ч. усиление «Эликсиром мощи») считает СЕРВЕР — s.damage уже итоговый.
  const dmg = s.damage;

  await attacker.strike(defender, () => {
    const pos = arena.worldToScreen(defender.headPoint());
    if (s.dodged) {
      ui.popup(pos, 'Уворот!', 'dodge');
    } else if (s.blocked && !s.crit) {
      defender.hitReact();
      ui.popup(pos, `Блок −${dmg}`, 'block');
    } else {
      defender.hitReact();
      ui.popup(pos, `−${dmg}`, s.crit ? 'crit' : 'dmg');
    }
    // бьют игрока — запоминаем зону на колесе (метка видна в следующий свой ход)
    if (s.defender === 'left' && !s.dodged) {
      ui.showIncoming(s.zone);
    }
    showHP(s.defender, s.defenderHp, sides[s.defender].maxHp);
    // «Урон» в шапке — общий урон, нанесённый игроком за весь бой
    if (s.attacker === 'left' && !s.dodged) {
      totalDamage += dmg;
      ui.setDamage(totalDamage);
      updateBattleInfo();
    }

    const who = esc(sides[s.attacker].name);
    const whom = esc(sides[s.defender].name);
    const zone = ZONE_LABELS[s.zone] || s.zone;
    let text;
    if (s.dodged) text = `<b>${whom}</b> уклонился от удара`;
    else if (s.crit) text = `<b>${who}</b> наносит <span class="crit">критический удар</span> в ${zone}: −${dmg}`;
    else if (s.blocked) text = `<b>${whom}</b> блокирует удар в ${zone}: −${dmg}`;
    else text = `<b>${who}</b> бьёт в ${zone}: −${dmg}`;
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

/** Переключить активную панель нижнего дока. */
function activateTab(name) {
  document.querySelectorAll('.dock-pane').forEach((p) =>
    p.classList.toggle('active', p.id === 'pane-' + name));
  if (name === 'players') refreshPlayers();
  // пока панель была скрыта, scrollTop не применялся — догоняем при открытии
  if (name === 'chat') scrollChatToBottom();
}

$('loc-scene-close')?.addEventListener('click', () => closeLocPanel());
$('battles-close')?.addEventListener('click', () => closeBattlesPanel());

// --- расширение нижнего окна жестом ---
// повести вверх — окно растёт; вниз или тап по ручке — исходная высота ---

const dockGrip = $('dock-grip');
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
  const menuH = castleMainMenu?.getBoundingClientRect().height ?? 100;
  return Math.max(140, Math.round(window.innerHeight * 0.52 - menuH));
};

function dockSnap(expand) {
  dockExpanded = expand;
  dockEl.classList.add('dock-anim');
  dockEl.style.height = expand ? dockMaxHeight() + 'px' : '';
  updateBattleDockState();
}

function dockPointerDown(e) {
  if (dockDrag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (!dockEl.classList.contains('dock-open')) return;
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
const dockBodyEl = dockEl.querySelector('.dock-body');
dockBodyEl?.addEventListener('pointerdown', (e) => {
  if (!dockEl.classList.contains('dock-open')) return;
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

// тап ВНЕ окна (по сцене/слотам) возвращает развёрнутое окно в исходную высоту —
// окна не «залипают» раскрытыми (улучшенное поведение расширения, см. ТЗ).
document.addEventListener('pointerdown', (e) => {
  if (mode !== 'battle' || !dockExpanded) return;
  if (!dockEl.classList.contains('dock-open')) return;
  if (e.target.closest('#bottom-dock') || e.target.closest('.castle-main-menu')) return;
  dockSnap(false);
}, true);

// Инструменты вкладки «Участники»: показать убитых, сортировка, поиск по нику
const membersGrid = $('members-grid');
const showDeadBtn = $('show-dead');
showDeadBtn.addEventListener('click', () => {
  membersGrid.classList.toggle('hide-dead');
  const showing = !membersGrid.classList.contains('hide-dead');
  showDeadBtn.classList.toggle('active', showing);
  showDeadBtn.title = showing ? 'Скрыть убитых' : 'Показать убитых';
});

const membersSearch = $('members-search');
const membersSearchToggle = $('members-search-toggle');
membersSearch?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); membersSearch.blur(); }  // Enter — скрыть клавиатуру
});
membersSearch?.addEventListener('input', () => {
  if (ui) ui.setRosterFilter({ search: membersSearch.value });
});
// поиск по нику спрятан за лупой (#6.1): тап разворачивает поле и фокусирует его;
// повторный тап — прячет и сбрасывает фильтр
membersSearchToggle?.addEventListener('click', () => {
  const show = membersSearch.classList.contains('hidden');
  membersSearch.classList.toggle('hidden', !show);
  membersSearchToggle.classList.toggle('active', show);
  if (show) {
    membersSearch.focus();
  } else {
    membersSearch.value = '';
    if (ui) ui.setRosterFilter({ search: '' });
  }
});

// сортировка по HP/энергии: повторный тап по той же кнопке меняет направление
let memberSort = { key: null, dir: 1 };
function applyMemberSort(key) {
  if (memberSort.key === key) memberSort.dir = -memberSort.dir;
  else { memberSort.key = key; memberSort.dir = 1; }
  if (ui) ui.setRosterFilter({ sortKey: memberSort.key, sortDir: memberSort.dir });
  for (const [id, k] of [['sort-hp', 'hp'], ['sort-en', 'en']]) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle('active', memberSort.key === k);
    const dir = b.querySelector('.mtool-dir');
    if (dir) dir.textContent = memberSort.key === k ? (memberSort.dir < 0 ? '▼' : '▲') : '';
  }
}
$('sort-hp')?.addEventListener('click', () => applyMemberSort('hp'));
$('sort-en')?.addEventListener('click', () => applyMemberSort('en'));

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

/** Системный шум из истории — не показываем при входе. Объявления боёв оставляем — по ним вмешиваются. */
function isChatJunk(sender, body) {
  const s = String(body || '').trim();
  if (!s) return true;
  if (sender !== 'Система') return false;
  return /^Вы вошли в локацию/.test(s);
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
  input.value = '';
  input.blur();                          // Enter — отправили и скрыли клавиатуру
  if (!text) return;
  if (online) api.sendChat(text);        // вернётся всем в локации, включая нас
  else chatMessage(PLAYER.name, text);   // оффлайн: локальное эхо
});

// ---------------------------------------------------------------------------
// Мобильная клавиатура. В Telegram WebView (особенно iOS) выехавшая клавиатура
// ужимает ВЕСЬ вьюпорт — и vw, и vh/dvh. Если привязать размер игры к видимой
// высоте, она масштабируется (сжимается с чёрными полями). Поэтому игру держим
// в ПОЛНОЙ (stable) высоте и НЕ меняем её размер. Сам экран не двигаем: клавиатура
// накрывает нижнее меню, а над ней поднимается только док с полем ввода чата
// (transform на .bottom-dock в CSS, на (--kb − --menu-h)).
//   --app-h  — полная высота (tg.viewportStableHeight | window.innerHeight)
//   --kb     — высота клавиатуры (полная − видимая)
//   --menu-h — высота нижнего меню «замка» (его клавиатура накрывает снизу)
// ---------------------------------------------------------------------------
(() => {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const tgApp = window.Telegram && window.Telegram.WebApp;

  // Открыта ли мобильная клавиатура (сфокусировано текстовое поле). Пока да —
  // НЕ пересчитываем «полную» высоту: иначе сигналы вьюпорта/safe-area, которые
  // Telegram шлёт при выезде клавиатуры, схлопнули бы --app-h до высоты без
  // клавиатуры и весь UI прыгал бы с ресайзом. Клавиатуру отрабатывает только
  // подъём дока (--kb); полную высоту перемеряем уже после расфокуса поля.
  const keyboardOpen = () => {
    const a = document.activeElement;
    if (!a) return false;
    const tag = a.tagName;
    if (tag === 'TEXTAREA') return true;
    return tag === 'INPUT'
      && a.type !== 'checkbox' && a.type !== 'radio' && a.type !== 'range' && a.type !== 'button';
  };

  // «Полную» высоту НИ ОДНОМУ сигналу доверять как абсолюту нельзя: при
  // клавиатуре window.innerHeight ужимается на Android, а tg.viewportStableHeight
  // «дышит» на iOS. Поэтому полная высота = МАКСИМУМ виденного при текущей ширине,
  // и сбрасываем его только при смене ширины (поворот экрана). Клавиатура может
  // высоту лишь уменьшить — это уменьшение игнорируем и уводим его в --kb (подъём
  // translateY), а сам размер игры не трогаем (иначе сжатие с чёрными полями).
  let baseFull = 0;
  let baseWidth = window.innerWidth;

  const heights = () => {
    // сброс «полной» высоты только при реальной смене ширины (поворот экрана),
    // и НЕ во время ввода — клавиатура иногда дёргает ширину на пиксель
    if (window.innerWidth !== baseWidth && !keyboardOpen()) {
      baseWidth = window.innerWidth; baseFull = 0;
    }

    // видимая часть — наименьший из доступных сигналов (ловит клавиатуру)
    let seen = window.innerHeight;
    if (tgApp && tgApp.viewportHeight) seen = Math.min(seen, tgApp.viewportHeight);
    if (vv) seen = Math.min(seen, vv.height);

    // полная — наибольший из доступных сигналов, зафиксированный как максимум
    let full = window.innerHeight;
    if (tgApp && tgApp.viewportStableHeight) full = Math.max(full, tgApp.viewportStableHeight);
    if (vv) full = Math.max(full, vv.height);
    baseFull = Math.max(baseFull, full, seen);
    full = baseFull;

    return { full, seen: Math.min(seen, full) };
  };

  let raf = 0;
  const apply = () => {
    raf = 0;
    const { full, seen } = heights();
    const kb = Math.max(0, Math.round(full - seen));
    root.style.setProperty('--app-h', Math.round(full) + 'px');
    root.style.setProperty('--kb', kb + 'px');
    // высота нижнего меню — на неё клавиатура накрывает его снизу, поэтому док
    // поднимается на (--kb − --menu-h), а не на всю высоту клавиатуры (см. CSS)
    const menuH = castleMainMenu ? Math.round(castleMainMenu.getBoundingClientRect().height) : 0;
    root.style.setProperty('--menu-h', menuH + 'px');
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  const resetStableHeight = () => {
    // во время ввода (клавиатура открыта) не трогаем «полную» высоту — иначе
    // safe-area/viewport-событие от клавиатуры схлопнет --app-h и UI прыгнет (#)
    if (keyboardOpen()) return;
    const resetAndSchedule = () => {
      baseFull = 0;
      schedule();
      window.dispatchEvent(new Event('arena:layoutChanged'));
    };
    resetAndSchedule();
    setTimeout(resetAndSchedule, 60);
    setTimeout(resetAndSchedule, 260);
    setTimeout(resetAndSchedule, 600);
  };

  if (tgApp && tgApp.onEvent) tgApp.onEvent('viewportChanged', schedule);
  if (tgApp && tgApp.onEvent) {
    ['fullscreenChanged', 'safeAreaChanged', 'contentSafeAreaChanged'].forEach((ev) => {
      try { tgApp.onEvent(ev, resetStableHeight); } catch {}
    });
  }
  if (vv) { vv.addEventListener('resize', schedule); vv.addEventListener('scroll', schedule); }
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', resetStableHeight);
  window.addEventListener('arena:viewportModeChanged', resetStableHeight);
  apply();

  // фокус/расфокус поля чата: пересчитать после анимации клавиатуры и подвести
  // последние сообщения к низу (скролл внутри чат-лога, не документа)
  const onChatFocus = (e, scroll) => {
    if (!e.target.closest('.chat-input-row')) return;
    setTimeout(() => { schedule(); if (scroll) scrollChatToBottom(); }, 300);
  };
  document.addEventListener('focusin', (e) => onChatFocus(e, true));
  document.addEventListener('focusout', (e) => onChatFocus(e, false));

  // Тап в ЛЮБОЕ место вне текстового поля снимает фокус → клавиатура скрывается.
  // (на тач-устройствах сцена/кнопки сами фокус не сбрасывают — делаем явно).
  // Тап по другому полю не трогаем: браузер сам переведёт фокус.
  document.addEventListener('pointerdown', (e) => {
    const ae = document.activeElement;
    if (!ae || !ae.matches || !ae.matches('input, textarea')) return;
    if (e.target.closest && e.target.closest('input, textarea')) return;
    ae.blur();
  }, true);
})();

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

/** Список идущих боёв в локации — панель «Текущие бои». */
async function refreshBattles() {
  if (!online || !battlesList) return;
  try {
    const battles = await api.locationBattles();
    battlesList.innerHTML = '';
    if (!battles.length) {
      battlesList.innerHTML = '<div class="bi-empty">В локации нет идущих боёв</div>';
      return;
    }
    for (const b of battles) {
      const row = document.createElement('div');
      row.className = 'battle-row';
      const label = document.createElement('span');
      label.className = 'battle-row-label';
      const kind = b.kind === 'pvp' ? 'дуэль' : 'охота';
      const left = (b.teams?.left || []).join(', ') || '—';
      const right = (b.teams?.right || []).join(', ') || '—';
      label.innerHTML = `<b>Бой #${b.battleId}</b> <span class="m-lvl">(${kind}, ход ${b.turn})</span>`
        + `<span class="battle-row-teams">${esc(left)} vs ${esc(right)}</span>`;
      row.appendChild(label);
      const info = document.createElement('button');
      info.type = 'button';
      info.className = 'pvp-btn';
      info.title = b.allowJoin ? 'Вмешаться' : 'Смотреть состав';
      info.textContent = b.allowJoin ? '⚔' : 'ℹ';
      info.addEventListener('click', () => {
        closeBattlesPanel();
        openBattleInfo(b.battleId);
      });
      row.appendChild(info);
      battlesList.appendChild(row);
    }
  } catch (e) {
    console.error('Список боёв:', e);
    battlesList.innerHTML = '<div class="bi-empty">Не удалось загрузить список боёв</div>';
  }
}

// ---------------------------------------------------------------------------
// Окно информации о бое (открывается ссылкой «Бой #N» из чата)
// ---------------------------------------------------------------------------

const binfoEl = $('binfo');
const binfoTitle = $('binfo-title');
const binfoBody = $('binfo-body');
const binfoCopyBtn = $('binfo-copy');
let binfoTimer = null;   // автообновление, пока бой идёт и окно открыто
let binfoId = null;      // id боя, открытого в окне (для «скопировать ссылку»)

function closeBattleInfo() {
  binfoEl.classList.add('hidden');
  clearInterval(binfoTimer);
  binfoTimer = null;
  binfoId = null;
}
$('binfo-close').addEventListener('click', closeBattleInfo);
binfoEl.addEventListener('click', (e) => {
  if (e.target === binfoEl) closeBattleInfo();
});

/** Постоянная ссылка на бой: открывается через ?battle=N при загрузке игры. */
function battleLink(id) {
  return `${location.origin}${location.pathname}?battle=${id}`;
}

/** Положить текст в буфер обмена: Clipboard API → execCommand → false. */
async function writeClipboard(text) {
  // Clipboard API часто запрещён (Telegram WebView, iframe, http) — на отказе
  // НЕ сдаёмся, а пробуем execCommand под тем же кликом пользователя
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* падаем в execCommand ниже */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Скопировать ссылку на открытый бой (#9 — кнопка в окне статистики боя). */
async function copyBattleLink() {
  if (binfoId == null) return;
  const link = battleLink(binfoId);
  if (await writeClipboard(link)) {
    showToast('Ссылка на бой скопирована');
  } else {
    // последний рубеж: показать ссылку, чтобы скопировать вручную
    showToast('Скопируйте ссылку вручную');
    window.prompt('Ссылка на бой:', link);
  }
}
binfoCopyBtn?.addEventListener('click', copyBattleLink);

const RESULT_LABELS = { 1: 'победа', 2: 'поражение', 3: 'ничья', 4: 'побег', 5: 'таймаут' };

/** Вмешаться в идущий бой #id на сторону side — войти как в свой бой. */
function intervene(id, side) {
  closeBattleInfo();
  enterBattle({ starter: () => ServerBattle.join(id, side) });
}

/** Цель в бою: простой вопрос «Вмешаться в бой «Бой #N»?» + да/нет (#8). */
function showTargetBusyPrompt(target, detail) {
  const battleId = detail.battleId;
  // вмешиваемся ПРОТИВ цели — на сторону, противоположную её стороне
  const oppose = detail.targetSide === 'left' ? 'right' : 'left';
  clearInterval(binfoTimer);
  binfoTimer = null;
  binfoId = battleId;
  binfoTitle.textContent = 'Игрок в бою';
  binfoBody.innerHTML = detail.allowJoin ? `
    <div class="busy-pvp">
      <p class="busy-pvp-q">Вмешаться в бой <a href="#" class="battle-link busy-battle-link">«Бой #${battleId}»</a>?</p>
      <div class="bi-join">
        <button type="button" class="bi-join-btn busy-join-yes">Да</button>
        <button type="button" class="bi-join-btn busy-join-no">Нет</button>
      </div>
    </div>` : `
    <div class="busy-pvp">
      <p><b>${esc(target.name)}</b> уже в бою <a href="#" class="battle-link busy-battle-link">«Бой #${battleId}»</a>.</p>
      <p class="bi-join-closed">Вмешательство в этот бой закрыто.</p>
      <div class="bi-join"><button type="button" class="bi-join-btn busy-join-no">Закрыть</button></div>
    </div>`;
  binfoEl.classList.remove('hidden');
  // ссылка «Бой #N» — открыть состав боя
  binfoBody.querySelectorAll('.busy-battle-link').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); renderBattleInfo(battleId); }));
  binfoBody.querySelector('.busy-join-yes')?.addEventListener('click', () => {
    closeBattleInfo();
    intervene(battleId, oppose);
  });
  binfoBody.querySelector('.busy-join-no')?.addEventListener('click', () => closeBattleInfo());
}

async function openBattleInfo(id) {
  binfoId = id;
  binfoTitle.textContent = `Бой #${id}`;
  binfoBody.innerHTML = '<div class="bi-empty">Загрузка…</div>';
  if (binfoCopyBtn) binfoCopyBtn.style.display = '';   // вернуть «скопировать ссылку»
  binfoEl.classList.remove('hidden');
  clearInterval(binfoTimer);
  binfoTimer = null;
  await renderBattleInfo(id);
}

async function renderBattleInfo(id) {
  binfoId = id;
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
    // вмешаться можно, если бой это разрешает и сам игрок сейчас не в бою
    const canJoin = d.allowJoin && mode !== 'battle' && online;
    const joinBar = canJoin ? `
      <div class="bi-join">
        <span>Вмешаться:</span>
        <button class="bi-join-btn" data-side="left">за союзников</button>
        <button class="bi-join-btn" data-side="right">за противников</button>
      </div>` : (d.status === 'active' && !d.allowJoin
      ? '<div class="bi-join-closed">Вмешательство в этот бой закрыто (охота или настройка сервера).</div>'
      : (mode === 'battle'
        ? '<div class="bi-join-closed">Выйдите из текущего боя, чтобы вмешаться.</div>'
        : ''));
    binfoBody.innerHTML = `
      <div class="bi-teams">
        <div class="bi-team bi-team-ally"><div class="bi-team-title">Союзники</div>
          ${d.teams.left.map(member).join('')}</div>
        <div class="bi-team bi-team-enemy"><div class="bi-team-title">Противники</div>
          ${d.teams.right.map(member).join('')}</div>
      </div>${joinBar}`;
    for (const btn of binfoBody.querySelectorAll('.bi-join-btn')) {
      btn.addEventListener('click', () => intervene(id, btn.dataset.side));
    }
    // живой бой — обновляем картину раз в 2 секунды
    if (!binfoTimer) {
      binfoTimer = setInterval(() => {
        if (binfoEl.classList.contains('hidden')) closeBattleInfo();
        else if (!document.hidden) renderBattleInfo(id);   // в фоне не опрашиваем
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

// Эмодзи-иконка эликсира по его эффекту. Серверные icon-строки шаблонов
// (вроде 'elixirHealth') в ITEMS не маппятся — без этого в рюкзаке висела бы
// коробка 📦 вместо колбы. Вид определяем по base_stats (как на сервере).
const ELIXIR_EMOJI = { health: '🧪', power: '⚡', escape: '🏃' };
function elixirKindFromStats(stats) {
  const s = stats || {};
  if (s.escape) return 'escape';
  if (s.power_mult != null) return 'power';
  if (s.heal != null) return 'health';
  return null;
}

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
      // эликсиру (type 4) даём колбу/реторту по эффекту, прочему — коробку
      const ek = it.type === 4 ? elixirKindFromStats(it.stats) : null;
      ITEMS[key] = { name: it.name, slot: slotName,
        icon: ek ? ELIXIR_EMOJI[ek] : '📦', noModel: true };
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
// Эликсиры: боевой пояс из ELIXIR_SLOTS ячеек. Надеваются в гардеробе,
// используются в бою; число доступных за бой = вместимость пояса (по заряду
// на ячейку). Использование отправляется на СЕРВЕР (ServerBattle.useElixir):
// сервер реально лечит/усиливает бойца в движке и присылает событие 'elixir'.
// ---------------------------------------------------------------------------

// иконка-призрак пустой ячейки пояса (как в исходном боевом оверлее)
const FLASK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5h4M10.8 3.5v5L5.6 17a3.2 3.2 0 0 0 2.9 4.6h7a3.2 3.2 0 0 0 2.9-4.6l-5.2-8.5v-5"/><path d="M7.5 14.5h9"/></svg>`;
const SPELL_STAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l1.8 5.4L19 12l-5.2 2.6L12 20l-1.8-5.4L5 12l5.2-2.6L12 4Z"/></svg>`;

const spellBar = new Array(SPELL_SLOTS).fill(null);
['spark', 'fireball', 'frost'].forEach((key, i) => { spellBar[i] = key; });

// пояс эликсиров приходит с СЕРВЕРА (api.belt): ячейка -> { slot, templateId,
// name, icon, kind, qty } | null. Сервер помнит состав пояса и списывает заряды.
let elixirBelt = new Array(ELIXIR_SLOTS).fill(null);
const elixirSpent = new Set();         // (резерв; при серверном поясе доступность — по qty)
let selfBuffTurns = 0;                 // оставшиеся усиленные удары (с сервера)
let selfBuffPct = 0;                   // прибавка урона «Эликсира мощи», %
let beltLive = false;                  // можно ли использовать пояс прямо сейчас

const elixirGlyph = (kind) => (kind === 'power' ? '⚡' : '🧪');

/** Подтянуть состав пояса с сервера (сервер его помнит между сессиями). */
async function loadBelt() {
  if (!online || !api.belt) return;
  try { elixirBelt = await api.belt(); } catch (e) { console.warn('Пояс эликсиров:', e); }
}

const combatBarEl = $('combat-bar');
const spellSlotsEl = $('spell-slots');
const elixirSlotsEl = $('elixir-slots');           // «лента» эликсиров (.cb-track)
const elixirViewEl = document.querySelector('.cb-elixirs-view');
const elixirPrevBtn = $('elixir-prev');
const elixirNextBtn = $('elixir-next');
const dressingBeltEl = $('dressing-belt');

// состояние листания эликсиров (страницы считаются под ширину экрана)
let elixirPage = 0;
let elixirPerPage = ELIXIR_SLOTS;
let elixirPages = 1;

elixirPrevBtn?.addEventListener('click', () => {
  if (elixirPage <= 0) return;
  elixirPage--; applyElixirPage();
});
elixirNextBtn?.addEventListener('click', () => {
  if (elixirPage >= elixirPages - 1) return;
  elixirPage++; applyElixirPage();
});

/** Показать HP стороны (HP считает сервер; при baseHp<=0 — 0, иначе не ниже 1). */
function showHP(side, baseHp, maxHp) {
  const hp = baseHp <= 0 ? 0 : Math.min(maxHp, Math.max(1, baseHp));
  ui.setHP(side, hp, maxHp);
}

/** Показать/скрыть 3D-модель соперника (на ожидании она прячется). */
function setOpponentVisible(v) {
  if (fighters.right && fighters.right.root) fighters.right.root.visible = v;
}

/** Сфокусировать соперника: имя/уровень в шапке, HP, и показать модель. */
function applyFocus(focus) {
  if (!focus) return;
  // тот же соперник (липкий фокус с сервера) — не пересобираем шапку, только HP
  if (focus.id == null || focus.id !== currentFocusId) {
    currentFocusId = focus.id ?? null;
    ui.setOpponent(focus);
    // NvN: фокус перешёл на нового живого врага — поднимаем правую модель,
    // если она лежит после гибели прошлого соперника (#6: чёткость мультибоя)
    const live = focus.alive !== false && (focus.hp == null || focus.hp > 0);
    if (live && fighters.right && fighters.right.alive === false) {
      fighters.right.revive();
    }
  }
  if (focus.maxHp) showHP('right', focus.hp, focus.maxHp);
  setOpponentVisible(true);
}

/** Карточка «информация об игроке» (модалка боя): имя, уровень, HP, сторона. */
function fighterCard(name, level, hp, maxHp, teamLabel) {
  const rows = [`<div class="finfo-row"><span>Уровень</span><b>${esc(String(level ?? '?'))}</b></div>`];
  if (maxHp) rows.push(
    `<div class="finfo-row"><span>Здоровье</span><b>${Math.max(0, Math.round(hp))} / ${maxHp}</b></div>`);
  if (teamLabel) rows.push(`<div class="finfo-row"><span>Сторона</span><b>${teamLabel}</b></div>`);
  binfoTitle.textContent = name || '—';
  binfoBody.innerHTML = `<div class="finfo">${rows.join('')}</div>`;
  if (binfoCopyBtn) binfoCopyBtn.style.display = 'none';   // не бой — ссылку не копируем
  clearInterval(binfoTimer); binfoTimer = null; binfoId = null;
  binfoEl.classList.remove('hidden');
}

/** «Инфо» у ника в шапке боя (своя плашка / сфокусированный соперник). */
function showFighterInfo(side) {
  if (!battle || !battle.sides) return;
  const base = battle.sides[side] || {};
  const info = side === 'right' && battle.focus ? battle.focus : base;
  fighterCard(info.name ?? base.name, info.level ?? base.level,
    info.hp != null ? info.hp : base.hp, info.maxHp ?? base.maxHp,
    side === 'left' ? 'Союзники' : 'Противники');
}

/** «Инфо» у участника в окне «Участники боя» — ищем бойца в ростере по id. */
function showMemberInfo(id) {
  if (!battle || !battle.roster) return;
  for (const side of ['left', 'right']) {
    const f = (battle.roster[side] || []).find((x) => String(x.id) === String(id));
    if (f) {
      fighterCard(f.name, f.level, f.hp, f.maxHp, side === 'left' ? 'Союзники' : 'Противники');
      return;
    }
  }
}

const offscreenLog = (s) => {
  const a = `<b>${esc(s.attackerName)}</b>`, t = `<b>${esc(s.defenderName)}</b>`;
  if (s.dodged) return `${t} уворачивается от удара ${a}`;
  if (s.blocked) return `${t} блокирует удар ${a} — ${s.damage}`;
  return `${a} бьёт ${t}${s.crit ? ' (крит)' : ''} — ${s.damage}`;
};

/** Сбросить эликсир-эффекты и заряды к началу боя. */
function resetElixirBattle() {
  elixirSpent.clear();
  selfBuffTurns = 0;
  selfBuffPct = 0;
  beltLive = false;
  renderCombatBar();
  refreshSelfEffects();
}

/** Показать активные эффекты игрока иконками с таймером в шапке боя. */
function refreshSelfEffects() {
  if (!ui) return;
  const list = [];
  if (selfBuffTurns > 0) {
    list.push({ icon: '💪', time: selfBuffTurns, kind: 'buff',
                label: `Эликсир мощи: урон +${selfBuffPct}%` });
  }
  ui.setEffects('left', list);
}

function setBeltLive(v) {
  beltLive = v;
  renderCombatBar();
}

/** Нижняя боевая панель: 3 заклинания + 6 эликсиров (эликсиры листаются). */
function renderCombatBar() {
  if (combatBarEl) combatBarEl.classList.toggle('hidden', mode !== 'battle');

  if (spellSlotsEl) {
    spellSlotsEl.innerHTML = '';
    for (let i = 0; i < SPELL_SLOTS; i++) {
      const key = spellBar[i];
      if (!key) {
        const empty = document.createElement('div');
        empty.className = 'combat-slot spell empty';
        empty.title = 'Пустой слот заклинания';
        empty.innerHTML = SPELL_STAR_SVG;
        spellSlotsEl.appendChild(empty);
        continue;
      }
      const sp = SPELLS[key];
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'combat-slot spell filled';
      slot.disabled = !beltLive;
      slot.title = sp?.name ?? key;
      slot.innerHTML = `<span class="bs-ico">${sp?.icon ?? '✦'}</span>`;
      slot.addEventListener('click', () => {
        if (!beltLive) return;
        showToast(`«${sp?.name ?? key}» — скоро`);
      });
      spellSlotsEl.appendChild(slot);
    }
  }

  if (elixirSlotsEl) {
    elixirSlotsEl.innerHTML = '';
    for (let i = 0; i < ELIXIR_SLOTS; i++) {
      const cell = elixirBelt[i];
      if (!cell || (cell.qty != null && cell.qty <= 0)) {   // пустая / израсходованная (#2)
        const empty = document.createElement('div');
        empty.className = 'combat-slot elixir empty';
        empty.title = 'Пустая ячейка эликсира';
        empty.innerHTML = FLASK_SVG;
        elixirSlotsEl.appendChild(empty);
        continue;
      }
      // эликсир мощи нельзя пить, пока его усиление ещё действует (#3) — «перезарядка»
      const onCooldown = cell.kind === 'power' && selfBuffTurns > 0;
      const qty = cell.qty != null ? cell.qty : 1;
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = `combat-slot elixir filled kind-${cell.kind === 'power' ? 'power' : 'health'}`
        + (onCooldown ? ' cooldown' : '');
      slot.disabled = onCooldown || !beltLive;
      slot.title = onCooldown
        ? `${cell.name} — усиление ещё действует (${selfBuffTurns})`
        : `${cell.name} ×${qty} — использовать`;
      // счётчик зарядов в уголке (#1): мощь — стопкой ×N, жизнь — всегда 1
      slot.innerHTML = `<span class="bs-ico">${elixirGlyph(cell.kind)}</span>`
        + `<span class="bs-qty">${qty}</span>`;
      slot.addEventListener('click', () => useElixir(i));
      elixirSlotsEl.appendChild(slot);
    }
  }

  layoutCombatBar();
}

/**
 * Адаптивная раскладка нижней панели (#0, #5). Заклинания всегда видны слева;
 * эликсиры показываются в окне фиксированной ширины. Если все 6 не помещаются
 * по ширине экрана — включаются стрелки листания, окно подгоняется ровно под
 * целое число слотов (без «обрезков»), чтобы при ресайзе ничего не съезжало.
 */
function layoutCombatBar() {
  if (!combatBarEl || !elixirSlotsEl || !elixirViewEl) return;
  if (combatBarEl.classList.contains('hidden')) return;
  const slots = elixirSlotsEl.children;
  if (!slots.length) return;

  const slotW = slots[0].offsetWidth;
  if (!slotW) { requestAnimationFrame(layoutCombatBar); return; }  // ещё без размера
  const cs = getComputedStyle(elixirSlotsEl);
  const viewCs = getComputedStyle(elixirViewEl);
  const gap = parseFloat(cs.columnGap || cs.gap) || 6;
  const viewPadX = (parseFloat(viewCs.paddingLeft) || 0) + (parseFloat(viewCs.paddingRight) || 0);
  const step = slotW + gap;
  const fullTrack = ELIXIR_SLOTS * step - gap;   // ширина всех 6 слотов

  // 1) пробуем без стрелок: помещаются ли все эликсиры?
  combatBarEl.classList.remove('paged');
  elixirViewEl.style.width = '';
  const availAll = Math.max(0, elixirViewEl.clientWidth - viewPadX);
  if (availAll + 0.5 >= fullTrack) {             // влезают все — стрелки не нужны
    elixirPerPage = ELIXIR_SLOTS;
    elixirPages = 1;
    elixirPage = 0;
    elixirSlotsEl.style.transform = '';
    return;
  }

  // 2) нужны страницы: добавляем стрелки и считаем, сколько слотов в окне
  combatBarEl.classList.add('paged');
  const avail = Math.max(0, elixirViewEl.clientWidth - viewPadX); // место уже с учётом стрелок
  let perPage = Math.max(1, Math.floor((avail + gap) / step));
  perPage = Math.min(perPage, ELIXIR_SLOTS - 1); // в режиме страниц < 6
  elixirPerPage = perPage;
  elixirPages = Math.ceil(ELIXIR_SLOTS / perPage);
  elixirViewEl.style.width = Math.ceil(perPage * step - gap + viewPadX + 1) + 'px';
  applyElixirPage();
}

/** Применить текущую страницу эликсиров: сдвиг ленты + доступность стрелок. */
function applyElixirPage() {
  if (!elixirSlotsEl) return;
  if (elixirPages <= 1) {
    elixirPage = 0;
    elixirSlotsEl.style.transform = '';
    return;
  }
  elixirPage = Math.max(0, Math.min(elixirPage, elixirPages - 1));
  const cs = getComputedStyle(elixirSlotsEl);
  const gap = parseFloat(cs.columnGap || cs.gap) || 6;
  const slotW = elixirSlotsEl.children[0]?.offsetWidth || 44;
  const step = slotW + gap;
  elixirSlotsEl.style.transform = `translateX(${-elixirPage * elixirPerPage * step}px)`;
  if (elixirPrevBtn) elixirPrevBtn.disabled = elixirPage <= 0;
  if (elixirNextBtn) elixirNextBtn.disabled = elixirPage >= elixirPages - 1;
}

function relayoutBattleChrome() {
  if (mode !== 'battle') return;
  const run = () => {
    arena.resize();
    if (ui) ui.placeWheel(arena.wheelLayout());
    layoutCombatBar();
  };
  run();
  requestAnimationFrame(run);
  setTimeout(run, 90);
  setTimeout(run, 300);
}

window.addEventListener('arena:layoutChanged', relayoutBattleChrome);

/** Использовать эликсир из ячейки i (только в свой ход, по разу на ячейку).
 *  Эффект применяет СЕРВЕР (battle.useElixir) и присылает событие 'elixir'. */
function useElixir(i) {
  if (mode !== 'battle' || !battle || battle.phase === 'ended' || !beltLive) return;
  const cell = elixirBelt[i];
  if (!cell || (cell.qty != null && cell.qty <= 0)) return;
  // авторитетно: сервер берёт эликсир из ячейки пояса, списывает заряд и
  // применяет эффект к выбранной в ростере цели (союзник/себя). Параметры —
  // с сервера; клиент шлёт только номер ячейки и цель эффекта.
  battle.useElixir({ slot: i, target: ui?.target ?? null });
  ui.log(`<b>${esc(battle.sides.left.name)}</b> выпивает «${esc(cell.name)}»…`);
}

/** Пояс в гардеробе: пряжка + все ячейки; клик по заполненной — убрать. */
function renderDressingBelt() {
  if (!dressingBeltEl) return;
  dressingBeltEl.innerHTML = '<span class="belt-buckle" aria-hidden="true"></span>';
  for (let i = 0; i < ELIXIR_SLOTS; i++) {
    const cell = elixirBelt[i];
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'belt-slot elixir round'
      + (cell ? ` filled kind-${cell.kind === 'power' ? 'power' : 'health'}` : '');
    slot.title = cell
      ? `${cell.name}${cell.qty != null ? ' ×' + cell.qty : ''} (клик — убрать из пояса)`
      : 'Пустая ячейка — добавьте эликсир кнопкой «В пояс»';
    slot.innerHTML = cell
      ? `<span class="bs-ico">${elixirGlyph(cell.kind)}</span>`
        + `<span class="bs-qty">${cell.qty != null ? cell.qty : 1}</span>`
      : FLASK_SVG;
    slot.addEventListener('click', () => {
      if (!cell) { showToast('Добавьте эликсир из рюкзака кнопкой «В пояс»'); return; }
      removeElixirFromBelt(i);
    });
    dressingBeltEl.appendChild(slot);
  }
}

/** Освободить ячейку пояса (сервер помнит состав). */
async function removeElixirFromBelt(slot) {
  if (!online) { showToast('Пояс требует подключения к серверу'); return; }
  try { elixirBelt = await api.beltUnequip(slot); }
  catch (e) { showToast('Не убрать из пояса: ' + e.message); }
  renderDressingBelt();
  renderInventory();
}

/** Надеть один заряд эликсира (по templateId). Размещение выбирает сервер:
 *  мощь копит в стопку одной ячейки, жизнь занимает новый слот. Нельзя надеть
 *  больше, чем лежит в рюкзаке (сервер вернёт not_enough). */
async function addElixirToBelt(templateId) {
  if (!online) { showToast('Пояс требует подключения к серверу'); return; }
  if (templateId == null) return;
  try { elixirBelt = await api.beltEquip(templateId); }
  catch (e) {
    const msg = { belt_full: 'Пояс эликсиров заполнен',
      not_enough: 'Больше нет в рюкзаке — нечего надеть',
      not_owned: 'Этого эликсира нет в рюкзаке' }[e.message];
    showToast(msg || ('Не добавить в пояс: ' + e.message));
  }
  renderDressingBelt();
  renderInventory();
}

// ---------------------------------------------------------------------------
// Гардероб (примерочная): только СВОЙ персонаж, вещи меряются на нём
// ---------------------------------------------------------------------------

const dressingEl = $('dressing');
const dressingItemsEl = $('dressing-items');
const dressing = new DressingRoom($('dressing-view'));
const dressingSide = 'left';   // одевать можно только себя

// Сворачивание Mini App / гашение экрана: явно гасим WebGL-циклы (арена +
// примерочная), чтобы фоновая вкладка не жгла GPU/батарею. На возврате
// поднимаем ровно те циклы, что работали до сворачивания. rAF и сам тормозит
// в фоне, но в Telegram-WebView это не гарантировано — стопаем надёжно.
let _hiddenArena = false;
let _hiddenDressing = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if ((_hiddenArena = arena._running)) arena.stop();
    if ((_hiddenDressing = dressing._running)) dressing.stop();
  } else {
    // поднимаем цикл, только если он всё ещё нужен: пока были в фоне, бой мог
    // закончиться по сети, а гардероб — закрыться, тогда GPU будить незачем
    if (_hiddenArena && mode === 'battle') arena.start();
    if (_hiddenDressing && !dressingEl.classList.contains('hidden')) dressing.start();
    _hiddenArena = _hiddenDressing = false;
  }
});
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

/** Кукла, пояс эликсиров и рюкзак рисуются вместе — состояние у них общее. */
function renderDressingUI() {
  renderDoll();
  renderDressingBelt();
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
  // дубликаты и предметы без 3D) + локальные демо-вещи (для примерки 3D) в конце.
  // Демо-ЭЛИКСИРЫ исключаем: пояс ведёт сервер, у них нет templateId, и кнопка
  // «В пояс» висела бы вечно неактивной — игрок думал, что эликсиры не надеть (#1).
  // Оффлайн — весь набор из ITEMS.
  const demoRows = Object.keys(ITEMS)
    .filter((k) => ITEMS[k].demo && ITEMS[k].type !== 'elixir')
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
    // эликсир определяем по серверному типу (item_templates.type === 4),
    // иначе — по демо-конфигу ITEMS
    const isElixir = inst ? inst.type === 4 : item.type === 'elixir';
    // вид эликсира (по base_stats / демо-конфигу): мощь и жизнь идут в пояс,
    // эликсир побега (escape) в пояс не кладётся — он для выхода из боя
    const ekind = isElixir
      ? (inst ? elixirKindFromStats(inst.stats) : (item.kind || null)) : null;
    const beltable = ekind === 'health' || ekind === 'power';
    const tplId = inst ? inst.templateId : null;
    if (isElixir) {                   // бейдж: куда годится эликсир
      const badge = document.createElement('span');
      badge.className = 'inv-slot';
      badge.textContent = beltable ? 'Пояс' : 'Побег';
      head.appendChild(badge);
    } else if (slotName) {            // бейдж слота: понятно, куда вещь надевается
      const badge = document.createElement('span');
      badge.className = 'inv-slot';
      badge.textContent = SLOT_META[slotName]?.name || slotName;
      head.appendChild(badge);
    }
    const actions = document.createElement('div');
    actions.className = 'inv-actions';
    if (beltable) {                   // эликсир — кнопка «В пояс» (сервер помнит пояс)
      // надето = сумма зарядов шаблона по всем ячейкам; есть = сколько в рюкзаке.
      // Нельзя надеть больше, чем есть (#4). Мощь копится в стопку (можно без
      // свободной ячейки), жизнь занимает новый слот — поэтому ей нужна свободная.
      const reserved = tplId != null
        ? elixirBelt.reduce((n, c) => c && c.templateId === tplId ? n + (c.qty || 0) : n, 0)
        : 0;
      const owned = tplId != null
        ? serverInv.reduce((n, it) => it.templateId === tplId ? n + (it.quantity || 0) : n, 0)
        : 0;
      const canStack = tplId != null
        && elixirBelt.some((c) => c && c.templateId === tplId && c.kind === 'power');
      const noFreeSlot = elixirBelt.every((c) => c !== null);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'inv-btn';
      b.disabled = !online || tplId == null || reserved >= owned
        || (noFreeSlot && !canStack);
      b.textContent = reserved ? `В пояс (×${reserved})` : 'В пояс';
      b.addEventListener('click', () => addElixirToBelt(tplId));
      actions.appendChild(b);
    } else if (slotName) { // вещь надевается — кнопка «Надеть/Снять»
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
    // свежий рюкзак и пояс с сервера: выданные/полученные вещи появляются сразу
    if (online) {
      try { registerServerItems(await api.inventory()); }
      catch (e) { console.error('Обновление рюкзака:', e); }
      await loadBelt();
      renderDressingBelt();
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
  else if (id === 'battles') toggleBattlesPanel();
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

/**
 * Запуск из Telegram админом — предложить выбор: остаться в игре или открыть
 * админку. Обычный игрок (не админ) и запуск вне Telegram проходят мгновенно.
 * При выборе «Админка» переходим на её страницу, неся initData в hash (#tginit)
 * — телеграм-сессия не теряется при навигации, админка входит без пароля.
 */
function adminEntryChoice() {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!api.isAdmin || !tg || !tg.initData) return Promise.resolve();
  return new Promise((resolve) => {
    const adminBase = window.API_URL || 'http://localhost:8080';
    const el = document.createElement('div');
    el.className = 'admin-choice';
    el.innerHTML =
      '<div class="ac-card">' +
        '<div class="ac-title">С возвращением, мастер</div>' +
        '<div class="ac-sub">Куда заходим?</div>' +
        '<button type="button" class="ac-btn ac-game">🎮 В игру</button>' +
        '<button type="button" class="ac-btn ac-admin">🛠️ Открыть админку</button>' +
      '</div>';
    el.querySelector('.ac-game').addEventListener('click', () => { el.remove(); resolve(); });
    el.querySelector('.ac-admin').addEventListener('click', () => {
      location.href = adminBase + '/admin#tginit=' + encodeURIComponent(tg.initData);
    });
    document.body.appendChild(el);
  });
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
    await adminEntryChoice();        // админу из Telegram — выбор игра/админка
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

    // ссылка вида ?battle=N (скопированная из окна боя) — открываем статистику боя
    const deepBattle = new URLSearchParams(location.search).get('battle');
    if (deepBattle && /^\d+$/.test(deepBattle)) openBattleInfo(Number(deepBattle));
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
