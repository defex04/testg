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
import { FIGHTERS, LOCATIONS, ITEMS, SLOT_META, SPELLS, SPELL_SLOTS, ELIXIR_SLOTS, beltCapFor } from './content.js';

// ---------------------------------------------------------------------------
// Утилиты и состояние игрока
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const esc = (v) => String(v ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PLAYER = {
  name: 'ИгрокА',
  level: 1,
  maxLevel: 15,
  // кошелёк: медь / серебро / золото / бриллианты
  wallet: { copper: 0, silver: 0, gold: 0, diamond: 0 },
  xp: 0,       xpMax: 200,     // опыт до следующего уровня
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

// Значки снаряжения по серверному слоту: если шаблон прислал технический icon-код,
// в рюкзаке всё равно показываем узнаваемый предмет, а не коробку.
const GEAR_EMOJI_BY_SLOT_ID = {
  1: '🥋', 2: '⛑️', 3: '👖', 4: '🥾', 5: '🧤',
  6: '🦾', 7: '⚔️', 8: '🛡️', 9: '🦺', 10: '📿',   // 6 плечи (наплечье), 9 кольчуга (доспех)
};
const GEAR_EMOJI_BY_SLOT = {
  head: '⛑️', shoulders: '🦾', mainhand: '⚔️', torso: '🥋', belt: '🧷',
  amulet: '📿', hands: '🧤', offhand: '🛡️', legs: '👖', feet: '🥾',
};
function gearIconFromSlot(slot) {
  if (slot == null) return '';
  const raw = String(slot);
  if (/^\d+$/.test(raw)) return GEAR_EMOJI_BY_SLOT_ID[Number(raw)] || '';
  return GEAR_EMOJI_BY_SLOT[raw] || '';
}
function gearIconFromType(type) {
  const n = Number(type);
  if (n === 1) return '⚔️';
  if (n === 5) return '📿';
  if (n === 2) return '🛡️';
  return '📦';
}
function gearIconForItem(it) {
  return gearIconFromSlot(it?.slot) || gearIconFromType(it?.type);
}
const qClass = (on, quality) => on ? ' q' + Math.min(5, Math.max(1, Number(quality) || 1)) : '';

// id локации в БД сервера -> ключ в LOCATIONS (клиентские локации без id)
const LOC_BY_ID = Object.fromEntries(
  Object.entries(LOCATIONS).filter(([, l]) => l.id).map(([k, l]) => [l.id, k]));

/** Перенести персонажа с сервера в PLAYER и шапку. */
function applyCharacter(ch) {
  PLAYER.id = ch.id;
  PLAYER.name = ch.name;
  PLAYER.level = ch.level;
  PLAYER.maxLevel = ch.maxLevel || PLAYER.maxLevel;
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
  const xpMaxed = PLAYER.level >= PLAYER.maxLevel || PLAYER.xpMax <= 0;
  $('pp-xp-fill').style.width = xpMaxed
    ? '100%'
    : Math.min(100, (PLAYER.xp / PLAYER.xpMax) * 100) + '%';
  $('pp-xp-text').textContent = xpMaxed ? 'MAX' : `${PLAYER.xp} / ${PLAYER.xpMax}`;
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

// --- Скрывать системные сообщения в чате (по умолчанию показывать) -----------
const HIDE_SYS_KEY = 'arena.hideSysChat';
const hideSysChatPref = () => {
  try { return localStorage.getItem(HIDE_SYS_KEY) === '1'; } catch { return false; }
};
function applyHideSysChat(on) { document.body.classList.toggle('hide-sys-chat', on); }
function setHideSysChatPref(on) {
  try { localStorage.setItem(HIDE_SYS_KEY, on ? '1' : '0'); } catch {}
  applyHideSysChat(on);
}
applyHideSysChat(hideSysChatPref());

// --- Режим оптимизации (меньше нагрев телефона; по умолчанию выкл) -----------
// Гасит тени бойцов, режет плотность пикселей до 1× и ограничивает кадры ~30 к/с
// (см. Arena.setPerfMode). Класс body.perf-mode дополнительно убирает дорогое
// размытие фона панелей. arena объявлена ниже — applyPerfMode зовём после её
// создания, поэтому здесь только функции (предпочтение применит вызов позже).
const PERF_KEY = 'arena.perfMode';
const perfModePref = () => {
  try { return localStorage.getItem(PERF_KEY) === '1'; } catch { return false; }
};
function applyPerfMode(on) {
  document.body.classList.toggle('perf-mode', on);
  if (arena) arena.setPerfMode(on);
}
function setPerfModePref(on) {
  try { localStorage.setItem(PERF_KEY, on ? '1' : '0'); } catch {}
  applyPerfMode(on);
}

// --- Автозаполнение пояса эликсиров после боя (по умолчанию выкл) ------------
const BELT_AUTOFILL_KEY = 'arena.beltAutofill';
const beltAutofillPref = () => {
  try { return localStorage.getItem(BELT_AUTOFILL_KEY) === '1'; } catch { return false; }
};
function setBeltAutofillPref(on) {
  try { localStorage.setItem(BELT_AUTOFILL_KEY, on ? '1' : '0'); } catch {}
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
  const hideSysInput = $('set-hide-sys');
  const optimizeInput = $('set-optimize');
  const beltAutofillInput = $('set-belt-autofill');
  const open = () => {
    if (fsInput) fsInput.checked = fullscreenPref();
    if (hintsInput) hintsInput.checked = hintsPref();
    if (membersStartInput) membersStartInput.checked = membersOnStartPref();
    if (hideSysInput) hideSysInput.checked = hideSysChatPref();
    if (optimizeInput) optimizeInput.checked = perfModePref();
    if (beltAutofillInput) beltAutofillInput.checked = beltAutofillPref();
    el.classList.remove('hidden');
  };
  const close = () => el.classList.add('hidden');
  $('pp-settings')?.addEventListener('click', open);
  $('settings-close')?.addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  fsInput?.addEventListener('change', () => setFullscreenPref(fsInput.checked));
  hintsInput?.addEventListener('change', () => setHintsPref(hintsInput.checked));
  membersStartInput?.addEventListener('change', () => setMembersOnStartPref(membersStartInput.checked));
  hideSysInput?.addEventListener('change', () => setHideSysChatPref(hideSysInput.checked));
  optimizeInput?.addEventListener('change', () => setPerfModePref(optimizeInput.checked));
  beltAutofillInput?.addEventListener('change', () => setBeltAutofillPref(beltAutofillInput.checked));
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

  // индикатор загрузки: считаем активные запросы, оборачивая fetch.
  // Дебаунс против мерцания: короткие запросы (< 150 мс) полоску не зажигают,
  // а зажжённая гаснет не раньше чем через 300 мс — серия мелких запросов
  // выглядит одной ровной загрузкой, а не стробоскопом.
  let pending = 0;
  let showT = null, hideT = null, shownAt = 0;
  const isHealth = (u) => /\/api\/health(\?|$)/.test(u);
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (isHealth(u)) return rawFetch(input, init);   // пинг бар не мигает
    pending++;
    clearTimeout(hideT);
    if (!showT && !bar?.classList.contains('busy')) {
      showT = setTimeout(() => {
        showT = null;
        if (pending > 0 && bar) { bar.classList.add('busy'); shownAt = performance.now(); }
      }, 150);
    }
    return rawFetch(input, init).finally(() => {
      if (--pending <= 0) {
        pending = 0;
        clearTimeout(showT); showT = null;
        const left = Math.max(0, 300 - (performance.now() - shownAt));
        hideT = setTimeout(() => bar?.classList.remove('busy'), left);
      }
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
const npcDialogEl = $('npc-dialog');
const npcDialogTitle = $('npc-dialog-title');
const npcDialogBody = $('npc-dialog-body');

let mode = 'location';   // 'location' | 'battle'
let currentLoc = 'village';
let locationNpcs = [];
let locationNpcLocId = null;
let locationNpcsLoading = false;
let locationNpcsError = '';

// канвас живёт в скрытом до боя arena-stage; Arena сама подхватит размер,
// когда экран боя станет видимым (ResizeObserver). Рендер-цикл запускается
// только на время боя (setMode) — вне боя GPU не работает вхолостую.
const arena = new Arena(arenaStage, { autostart: false });
// применить сохранённый режим оптимизации к только что созданной арене
applyPerfMode(perfModePref());

// --- Индикатор нагрузки ЦП/ГП под пингом (где упор: процессор или видео) ------
// Виден только в бою, пока крутится рендер-цикл арены. ЦП — время JS на кадр
// (высокое → упор в процессор), ГП — время GPU на кадр (если браузер даёт таймер;
// иначе «—»). FPS ниже потолка при низком ЦП → узкое место видео/композитинг.
(() => {
  const wrap = $('net-perf');
  const fpsEl = $('np-fps'), cpuEl = $('np-cpu'), gpuEl = $('np-gpu'), gpuWrap = $('np-gpu-wrap');
  if (!wrap || !fpsEl) return;
  const q = (el, val) => { if (el) el.dataset.q = val; };
  const update = () => {
    if (document.hidden) return;   // в фоне индикатор не пересчитываем
    const p = (mode === 'battle' && arena.getPerf) ? arena.getPerf() : null;
    if (!p || !p.running) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    const fps = Math.round(p.fps);
    fpsEl.textContent = fps || '—';
    q(fpsEl, fps >= 50 ? 'good' : fps >= 28 ? 'ok' : 'bad');
    const cpu = p.cpuMs;
    cpuEl.textContent = Math.round(cpu) + 'мс';
    q(cpuEl, cpu < 6 ? 'good' : cpu < 12 ? 'ok' : 'bad');
    if (p.gpuSupported && p.gpuMs != null) {
      if (gpuWrap) gpuWrap.style.display = '';
      gpuEl.textContent = Math.round(p.gpuMs) + 'мс';
      q(gpuEl, p.gpuMs < 6 ? 'good' : p.gpuMs < 12 ? 'ok' : 'bad');
    } else if (gpuWrap) {
      gpuWrap.style.display = 'none';   // браузер не даёт таймер GPU — прячем
    }
  };
  update();
  setInterval(update, 1000);
})();

// --- состояние UI локации ---
let locPanelOpen = false;                 // всплывающая панель «Локация»
let shopOpen = false;
let battlesPanelOpen = false;             // панель «Бои в локации»
let battlesTimer = null;
let battlesTab = 'active';                // вкладка панели боёв: 'active' | 'finished'
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
  if (shopOpen) renderLocationActions(LOCATIONS[currentLoc]);
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
    battlesTab = 'active';        // всегда открываем на «Текущие»
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
  // открыли чат на общей вкладке — гасим звоночек личных сообщений (#10)
  if (pane === 'chat' && typeof clearMentions === 'function' && activeChat === 'common') {
    clearMentions();
    refreshCommonChatHistory?.();
  }
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
let battleStartedAt = null;     // когда начался бой (для длительности в сводке)
let battleDurTimer = null;      // тикер длительности раз в секунду
function ensureBattleInfo() {
  if (!battleForeground) return null;
  if (biEls && battleForeground.contains(biEls.root)) return biEls;
  battleForeground.innerHTML = `
    <div class="binfo-panel">
      <div class="binfo-panel-head">Сводка боя</div>
      <div class="binfo-stats">
        <div class="bis ally"><span class="bis-k">Союзники</span><span class="bis-v" data-bi="ally">—</span></div>
        <div class="bis enemy"><span class="bis-k">Противники</span><span class="bis-v" data-bi="enemy">—</span></div>
        <div class="bis plain"><span class="bis-k">Урон</span><span class="bis-v" data-bi="dmg">0</span></div>
        <div class="bis plain"><span class="bis-k">Убито</span><span class="bis-v" data-bi="kills">0</span></div>
        <button type="button" class="bis binfo-copy-link" data-bi="copy">🔗 Скопировать</button>
      </div>
      <div class="binfo-tip" data-bi="tip"></div>
    </div>`;
  const q = (s) => battleForeground.querySelector(s);
  biEls = {
    root: battleForeground.firstElementChild,
    dmg: q('[data-bi="dmg"]'), kills: q('[data-bi="kills"]'),
    ally: q('[data-bi="ally"]'), enemy: q('[data-bi="enemy"]'),
    tip: q('[data-bi="tip"]'), copy: q('[data-bi="copy"]'),
  };
  biEls.copy.addEventListener('click', async () => {
    const id = battle && battle.battleId;
    if (!id) { showToast('Ссылка доступна в бою на сервере'); return; }
    if (await writeClipboard(battleLink(id))) showToast('Ссылка на бой скопирована');
    else window.prompt('Ссылка на бой:', battleLink(id));
  });
  return biEls;
}
function aliveCount(side) {
  const list = (battle && battle.roster && battle.roster[side]) || [];
  let alive = 0;
  for (const f of list) if (f.alive !== false && (f.hp == null || f.hp > 0)) alive++;
  return { alive, total: list.length, dead: list.length - alive };
}
function updateBattleInfo() {
  if (mode !== 'battle') return;
  const e = ensureBattleInfo();
  if (!e) return;
  if (!battleStartedAt) battleStartedAt = Date.now();
  const turn = lastTurnShown || 1;
  e.dmg.textContent = totalDamage;
  const a = aliveCount('left');
  const en = aliveCount('right');
  e.ally.textContent = `${a.alive}/${a.total}`;      // живых/всего, как раньше
  e.enemy.textContent = `${en.alive}/${en.total}`;
  e.kills.textContent = en.dead;            // сколько противников пало (убито нашей стороной)
  e.tip.textContent = BATTLE_TIPS[(turn - 1) % BATTLE_TIPS.length];
}
function clearBattleInfo() {
  if (battleForeground) battleForeground.innerHTML = '';
  biEls = null;
  battleStartedAt = null;
  clearInterval(battleDurTimer); battleDurTimer = null;
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
  if (!battle) hideEffectPreview();   // не оставлять превью эффекта поверх локации (#8)
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
    refreshBattlesBadge();
  } catch (e) {
    showToast('Туда не пройти: ' + e.message);
  }
}

// иконки кнопок локации (inline-SVG — эмодзи в UI рендерятся нестабильно)
const ICON_GO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13.5 6.5 19 12l-5.5 5.5"/></svg>`;
const ICON_HUNT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 4.5 15.5 15.5M19.5 4.5 8.5 15.5"/><path d="M14 17.2 17.2 14M10 17.2 6.8 14"/><path d="M16.2 16.2 19 19M7.8 16.2 5 19"/></svg>`;
const ICON_ACT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l1.8 5.4L19 12l-5.2 2.6L12 20l-1.8-5.4L5 12l5.2-2.6L12 4Z"/></svg>`;
const ICON_SHOP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 10h14l-1 10H6L5 10Z"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M9 14h6"/></svg>`;

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

function mediaUrl(src) {
  if (!src) return '';
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  if (src.startsWith('/')) return (window.API_URL || 'http://localhost:8080') + src;
  return src;
}

function npcInitial(npc) {
  return String(npc?.name || '?').trim().slice(0, 1).toUpperCase() || '?';
}

function npcAvatarHtml(npc, cls = 'npc-ava') {
  const img = mediaUrl(npc?.image);
  return `<span class="${cls}">${img
    ? `<img src="${esc(img)}" alt="">`
    : esc(npcInitial(npc))}</span>`;
}

function npcsForLocation(loc) {
  if (online && loc.id && locationNpcLocId === loc.id) return locationNpcs;
  if (online && loc.id) {
    if (locationNpcsLoading) return [{ name: 'Жители загружаются...', _loading: true }];
    if (locationNpcsError) return [{ name: 'Не удалось загрузить жителей', _error: true }];
    return [{ name: 'Жители загружаются...', _loading: true }];
  }
  return (loc.npc || []).map((n, i) => ({ id: null, name: n.name, image: n.image || null,
    description: n.description || '', _fallback: i }));
}

async function refreshLocationNpcs() {
  if (!online || !serverLocId) return;
  const expected = serverLocId;
  locationNpcsLoading = true;
  locationNpcsError = '';
  if (mode === 'location' && !shopOpen) renderLocationActions(LOCATIONS[currentLoc]);
  try {
    const rows = await api.locationNpcs();
    if (expected !== serverLocId) return;
    locationNpcs = rows;
    locationNpcLocId = expected;
  } catch (e) {
    console.warn('NPC локации:', e);
    if (expected === serverLocId) {
      locationNpcs = [];
      locationNpcLocId = null;
      locationNpcsError = e.message || 'server_error';
    }
  } finally {
    if (expected === serverLocId) {
      locationNpcsLoading = false;
      if (mode === 'location' && !shopOpen) renderLocationActions(LOCATIONS[currentLoc]);
    }
  }
}

function renderLocationActions(loc) {
  shopOpen = false;
  locBody.classList.remove('shop-open');
  locSceneTitle.textContent = loc.name;
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
    makeButton('loc-btn' + (a.hunt ? ' hunt' : '') + (a.shop ? ' shop' : ''),
      `<span class="lc-ico">${a.shop ? ICON_SHOP : (a.hunt ? ICON_HUNT : ICON_ACT)}</span><span>${esc(a.label)}</span>`,
      () => {
        if (a.hunt) startBattle(a.npc);   // a.npc — конкретная цель (напр. шайка), опц.
        else if (a.shop) openShop(a.shop === 'gear' ? 'gear' : 'elixir');
        else if (a.drink === 'livingWater') drinkLivingWater();
        else showToast(`«${a.label}» — заглушка: модуль действий подключается отдельно`);
      })));

  renderActionGroup('Жители', npcsForLocation(loc).map((n) => {
    const b = makeButton('npc-chip' + (n._loading || n._error ? ' muted' : ''),
      `${npcAvatarHtml(n)}<span>${esc(n.name)}</span>`,
      () => {
        if (n._loading) return;
        if (n._error) {
          showToast('Обновляю список жителей...');
          refreshLocationNpcs();
          return;
        }
        if (n.id) openNpcDialog(n.id);
        else if (online) {
          showToast('NPC ещё не загружен с сервера, попробуйте через секунду');
          refreshLocationNpcs();
        } else {
          showToast(`Диалог с «${n.name}» доступен только при подключении к серверу`);
        }
      });
    if (n._loading) b.disabled = true;
    return b;
  }));
}

function objectiveLine(o) {
  const done = o.done ? ' done' : '';
  return `<div class="npc-objective${done}">
    <span>${o.done ? '✓' : '•'}</span>
    <span>${esc(o.text || o.kind)}</span>
    <b>${esc(o.current ?? 0)} / ${esc(o.need ?? 1)}</b>
  </div>`;
}

function questRewardItemIcon(it) {
  const raw = it?.icon ? String(it.icon) : '';
  if (raw && !/[A-Za-z]/.test(raw)) return raw;
  const ek = Number(it?.type) === 4 ? elixirKindFromStats(it.stats) : null;
  if (ek && ELIXIR_EMOJI[ek]) return ELIXIR_EMOJI[ek];
  if (it?.kind === 'weapon' || it?.kind === 'armor' || it?.kind === 'amulet') {
    return gearIconForItem(it);
  }
  return shopIcon(it?.kind || 'item', it);
}

function questRewardItemsHtml(q) {
  const items = Array.isArray(q.rewardItems) ? q.rewardItems : [];
  if (!items.length) return '';
  return `<div class="npc-reward-items" aria-label="Предметы награды">
    ${items.map((it, idx) => {
      const count = Math.max(1, Number(it.count) || 1);
      const quality = Math.min(5, Math.max(1, Number(it.quality) || 1));
      return `<button type="button" class="npc-reward-item q${quality}"
          data-reward-quest="${esc(q.id)}" data-reward-index="${idx}"
          title="${esc(it.name || 'Предмет')}">
        <span class="npc-reward-ico">${esc(questRewardItemIcon(it))}</span>
        ${count > 1 ? `<b>×${esc(count)}</b>` : ''}
      </button>`;
    }).join('')}
  </div>`;
}

function questRewardTypeLabel(it) {
  const type = Number(it?.type);
  if (type === 4) {
    const ek = elixirKindFromStats(it.stats) || it.kind;
    return ELIXIR_KIND_LABEL[ek] || 'Расходник';
  }
  if (it?.kind === 'weapon') return 'Оружие';
  if (it?.kind === 'armor') return 'Броня';
  if (it?.kind === 'amulet') return 'Амулет';
  if (it?.kind === 'resource' || type === 3 || type === 6) return 'Ресурс';
  return 'Предмет';
}

function questRewardRows(it) {
  const rows = [];
  const count = Math.max(1, Number(it?.count) || 1);
  if (count > 1) rows.push(['Количество', '×' + count]);
  rows.push(['Тип', questRewardTypeLabel(it)]);
  if (Number(it?.levelReq) > 1) rows.push(['Уровень', 'с ' + Number(it.levelReq)]);
  const slotName = slotNameFor(it?.slot);
  if (slotName) rows.push(['Слот', SLOT_META[slotName]?.name || slotName]);
  const stats = it?.stats || null;
  const clsName = { natisk: 'Натиск', uklon: 'Уклон', oplot: 'Оплот' }[stats && stats.cls];
  if (clsName) rows.push(['Класс', clsName]);
  if (Number(it?.type) === 4) {
    const ek = elixirKindFromStats(stats) || it.kind;
    const fx = elixirEffectText(ek, stats);
    if (fx) rows.push(['Эффект', fx]);
  } else {
    const gs = gearStatsText(stats);
    if (gs) rows.push(['Характеристики', gs]);
  }
  return rows;
}

let questRewardPreviewCleanup = null;
function closeQuestRewardPreview() {
  if (questRewardPreviewCleanup) {
    questRewardPreviewCleanup();
    return;
  }
  document.querySelector('.quest-reward-preview')?.remove();
}

function openQuestRewardPreview(it) {
  closeQuestRewardPreview();
  const box = document.createElement('div');
  box.className = 'quest-reward-preview';
  const rows = questRewardRows(it);
  box.innerHTML = `
    <div class="qrp-card" role="dialog" aria-modal="true" aria-label="${esc(it?.name || 'Предмет')}">
      <div class="qrp-head">
        <span class="qrp-ico q${Math.min(5, Math.max(1, Number(it?.quality) || 1))}">${esc(questRewardItemIcon(it))}</span>
        <div class="qrp-title">
          <div class="qrp-name">${esc(it?.name || 'Предмет')}</div>
          <div class="qrp-kind">${esc(questRewardTypeLabel(it))}</div>
        </div>
        <button type="button" class="qrp-close" title="Закрыть">×</button>
      </div>
      <div class="qrp-rows">${rows.map(([k, v]) =>
        `<div class="qrp-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('')}</div>
    </div>`;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
    if (questRewardPreviewCleanup === close) questRewardPreviewCleanup = null;
  };
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  box.querySelector('.qrp-close')?.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  questRewardPreviewCleanup = close;
  document.body.appendChild(box);
}

function renderNpcQuest(q, npc) {
  const p = q.progress || {};
  const objectives = (p.objectives || []).map(objectiveLine).join('');
  const stage = p.stages > 1
    ? `<div class="npc-quest-reward">Этап ${p.stage + 1} из ${p.stages}${p.stageTitle ? ': ' + esc(p.stageTitle) : ''}</div>`
    : '';
  const reward = q.rewardText
    ? `<div class="npc-quest-reward">Награда: ${esc(q.rewardText)}</div>` : '';
  const rewardItems = questRewardItemsHtml(q);
  let action = '';
  if (q.canTalk && q.conversation) action = `<button class="npc-quest-btn" data-quest-talk="${q.id}">Поговорить</button>`;
  else if (q.canAccept) action = `<button class="npc-quest-btn" data-quest-accept="${q.id}">Принять</button>`;
  else if (q.canComplete || q.canAdvance) action =
    `<button class="npc-quest-btn" data-quest-complete="${q.id}">${q.canAdvance ? 'Продолжить' : 'Завершить'}</button>`;
  else if (q.status === 'active') action = `<button class="npc-quest-btn" disabled>В процессе</button>`;
  else if (q.status === 'ready') action = `<button class="npc-quest-btn" disabled>Вернитесь к нужному NPC</button>`;
  return `<div class="npc-quest">
    <div class="npc-quest-head">
      <div class="npc-quest-title">${esc(q.name)}</div>
      <div class="npc-quest-state">${esc(q.statusText || '')}</div>
    </div>
    ${q.dialogue ? `<div class="npc-quest-text">${esc(q.dialogue)}</div>` : ''}
    ${stage}
    ${p.stageText ? `<div class="npc-quest-text">${esc(p.stageText)}</div>` : ''}
    ${objectives ? `<div class="npc-objectives">${objectives}</div>` : ''}
    ${reward}
    ${rewardItems}
    ${action ? `<div class="npc-quest-actions">${action}</div>` : ''}
  </div>`;
}

function startNpcConversation(npc, conv) {
  let step = 0;
  const steps = (conv.steps || []).filter(Boolean);
  const draw = () => {
    const last = step >= steps.length - 1;
    npcDialogTitle.textContent = conv.title || npc.name || 'Разговор';
    npcDialogBody.innerHTML = `
      <div class="npc-convo">
        ${npcAvatarHtml(npc, 'npc-portrait')}
        <div class="npc-convo-main">
          <div class="npc-convo-kicker">${esc(npc.name || 'NPC')}</div>
          <div class="npc-convo-text">${esc(steps[step] || '...')}</div>
          <div class="npc-convo-progress">${step + 1} / ${Math.max(1, steps.length)}</div>
          <div class="npc-quest-actions">
            <button class="npc-quest-btn secondary" type="button" data-convo-back>Назад</button>
            <button class="npc-quest-btn" type="button" data-convo-next>
              ${last ? esc(conv.finishLabel || 'Завершить разговор') : 'Далее'}
            </button>
          </div>
        </div>
      </div>`;
    npcDialogBody.querySelector('[data-convo-back]').addEventListener('click', () => openNpcDialog(npc.id, true));
    npcDialogBody.querySelector('[data-convo-next]').addEventListener('click', async (e) => {
      if (!last) {
        step++;
        draw();
        return;
      }
      e.currentTarget.disabled = true;
      try {
        const out = await api.npcTalk(npc.id, conv.questId);
        showToast(out.updated ? 'Разговор завершён' : 'Разговор уже засчитан');
        renderNpcDialog(out);
      } catch (err) {
        showToast('Не удалось завершить разговор: ' + (err.message || ''));
        e.currentTarget.disabled = false;
      }
    });
  };
  draw();
}

function renderNpcDialog(data) {
  const npc = data.npc || {};
  npcDialogTitle.textContent = npc.name || 'NPC';
  const portrait = npcAvatarHtml(npc, 'npc-portrait');
  const dialogs = data.dialogs || [];
  npcDialogBody.innerHTML = `
    <div class="npc-profile">
      ${portrait}
      <div>
        <h3>${esc(npc.name || 'NPC')}</h3>
        <p>${esc(npc.description || 'Этот персонаж пока молчит, но уже присутствует в мире.')}</p>
      </div>
    </div>
    <div class="npc-quests">
      ${dialogs.length ? dialogs.map((q) => renderNpcQuest(q, npc)).join('')
        : '<div class="npc-empty">Доступных диалогов сейчас нет.</div>'}
    </div>`;
  npcDialogBody.querySelectorAll('[data-quest-talk]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = dialogs.find((x) => String(x.id) === String(btn.dataset.questTalk));
      if (q?.conversation) startNpcConversation(npc, q.conversation);
    });
  });
  npcDialogBody.querySelectorAll('[data-quest-accept]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.questAccept(btn.dataset.questAccept, npc.id);
        showToast('Задание принято');
        await openNpcDialog(npc.id, true);
      } catch (e) {
        showToast('Не удалось принять: ' + (e.message || ''));
        btn.disabled = false;
      }
    });
  });
  npcDialogBody.querySelectorAll('[data-quest-complete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api.questComplete(btn.dataset.questComplete, npc.id);
        showToast(r.completed ? 'Задание завершено' : 'Этап выполнен');
        applyCharacter(await api.me());
        try { registerServerItems(await api.inventory()); } catch {}
        await openNpcDialog(npc.id, true);
        refreshLocationNpcs();
      } catch (e) {
        showToast('Не удалось завершить: ' + (e.message || ''));
        btn.disabled = false;
      }
    });
  });
  npcDialogBody.querySelectorAll('[data-reward-quest][data-reward-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = dialogs.find((x) => String(x.id) === String(btn.dataset.rewardQuest));
      const item = q?.rewardItems?.[Number(btn.dataset.rewardIndex)];
      if (item) openQuestRewardPreview(item);
    });
  });
}

async function openNpcDialog(id, quiet = false) {
  if (!online) { showToast('Диалоги доступны только онлайн'); return; }
  npcDialogEl.classList.remove('hidden');
  if (!quiet) {
    npcDialogTitle.textContent = 'NPC';
    npcDialogBody.innerHTML = '<div class="npc-empty">Загрузка...</div>';
  }
  try {
    renderNpcDialog(await api.npcDialog(id));
  } catch (e) {
    npcDialogBody.innerHTML = `<div class="npc-empty">Не удалось открыть диалог: ${esc(e.message || '')}</div>`;
  }
}

$('npc-dialog-close')?.addEventListener('click', () => {
  closeQuestRewardPreview();
  npcDialogEl.classList.add('hidden');
});
npcDialogEl?.addEventListener('click', (e) => {
  if (e.target === npcDialogEl) {
    closeQuestRewardPreview();
    npcDialogEl.classList.add('hidden');
  }
});

/** Испить живой воды: бафф +10% к HP и урону на 10 минут (применяется в бою/панели). */
async function drinkLivingWater() {
  if (!online) { showToast('Действие доступно только онлайн'); return; }
  try {
    const r = await api.drinkWater();
    const mins = Math.round((r.buff?.secs || 600) / 60);
    showToast(`Живая вода: +${r.buff?.hpPct || 10}% к HP и урону на ${mins} мин`);
    paramsData = null;                 // статы изменились — вкладка «Параметры» перетянет
    if (invCategory === 'params' && dressingEl && !dressingEl.classList.contains('hidden')) refreshParams();
  } catch (e) {
    showToast('Не удалось испить: ' + (e.message || ''));
  }
}

const SHOP_ERRORS = {
  shop_unavailable: 'Магазин доступен только в Городе Надежды',
  insufficient_funds: 'Не хватает меди',
  not_for_sale: 'Этот товар сейчас не продается',
  not_found: 'Товар не найден',
  level_too_low: 'Уровень слишком низкий для покупки',
};
let shopCharLevel = 1;          // уровень игрока для блокировки покупок не по уровню
const SHOP_EMOJI = { health: '🧪', power: '⚗️', mana: '🔮', blood: '🩸',
  escape: '🏃', poison: '☠️', heal_scroll: '🩹', cleanse: '🌀', elixir: '⚗️',
  weapon: '⚔️', armor: '🛡️', amulet: '📿', resource: '⛏️', item: '📦' };

// характеристики предмета (модель) → краткая строка для витрины/рюкзака
const GEAR_STAT_LABEL = { power: 'Мощь', health: 'HP', accuracy: 'Точность',
  dodge: 'Уклонение', crit: 'Крит', critResist: 'Сопр.Криту', defense: 'Защита',
  block: 'Блок', counter: 'Контратака', critPower: 'Сила Крита', blockDmg: 'Блок урона' };
const GEAR_STAT_ORDER = ['power', 'health', 'accuracy', 'dodge', 'crit', 'critPower',
  'critResist', 'defense', 'block', 'counter', 'blockDmg'];
const GEAR_PCT_STATS = new Set(['critPower', 'blockDmg']);
function gearStatsText(stats) {
  if (!stats || typeof stats !== 'object') return '';
  const parts = [];
  for (const k of GEAR_STAT_ORDER) {
    const v = stats[k];
    if (v == null || v === 0) continue;
    parts.push(`${GEAR_STAT_LABEL[k] || k} +${Math.round(v)}${GEAR_PCT_STATS.has(k) ? '%' : ''}`);
  }
  return parts.join(' · ');
}

function shopErrorText(e) {
  return SHOP_ERRORS[e?.message] || ('Магазин: ' + (e?.message || 'ошибка'));
}

function shopIcon(kind, item = null) {
  if (kind === 'weapon' || kind === 'armor' || kind === 'amulet') {
    return gearIconFromSlot(item?.slot) || gearIconFromType(kind === 'weapon' ? 1 : kind === 'amulet' ? 5 : 2);
  }
  return SHOP_EMOJI[kind] || SHOP_EMOJI.elixir;
}

async function openShop(kind = 'elixir') {
  if (!online) {
    showToast('Магазин доступен только онлайн');
    return;
  }
  shopOpen = true;
  locBody.classList.add('shop-open');
  shopKind = kind === 'gear' ? 'gear' : 'elixir';
  shopTabs = shopKind === 'gear' ? GEAR_TABS : ELIXIR_TABS;
  shopTab = shopTabs[0].id;
  locSceneTitle.textContent = shopKind === 'gear' ? 'Магазин экипировки' : 'Магазин эликсиров';
  locActions.innerHTML = '<div class="shop-loading">Загрузка товаров...</div>';
  try {
    const data = await api.shop();
    shopCharLevel = Number(data.charLevel) || PLAYER.level || 1;
    // показываем только товары этого магазина (по kinds его вкладок)
    const allowed = new Set(shopTabs.flatMap((t) => t.kinds));
    renderShop((data.items || []).filter((it) => allowed.has(it.kind)));
  } catch (e) {
    showToast(shopErrorText(e));
    renderLocationActions(LOCATIONS[currentLoc]);
  }
}

// Вкладки магазина по категориям (ТЗ #3); свитки сгруппированы в одну вкладку.
// два РАЗДЕЛЬНЫХ магазина: эликсиры и экипировка (со своими категориями-вкладками)
const ELIXIR_TABS = [
  { id: 'health', name: 'Жизнь',  kinds: ['health'] },
  { id: 'power',  name: 'Мощь',   kinds: ['power'] },
  { id: 'mana',   name: 'Мана',   kinds: ['mana'] },
  { id: 'blood',  name: 'Кровь',  kinds: ['blood'] },
  { id: 'scroll', name: 'Свитки', kinds: ['poison', 'heal_scroll', 'cleanse'] },
  { id: 'escape', name: 'Побег',  kinds: ['escape'] },
];
const GEAR_TABS = [
  { id: 'g-armor',  name: 'Вещи',    kinds: ['armor'] },
  { id: 'g-weapon', name: 'Оружие',  kinds: ['weapon'] },
  { id: 'g-amulet', name: 'Амулеты', kinds: ['amulet'] },
];
let shopKind = 'elixir';        // 'elixir' | 'gear' — какой магазин открыт
let shopTabs = ELIXIR_TABS;     // активный набор вкладок
let shopItems = [];
let shopTab = 'health';
let shopSearch = '';
let shopAvailOnly = false;
let shopListEl = null;
const tabKinds = (id) => (shopTabs.find((t) => t.id === id) || { kinds: [] }).kinds;

function renderShop(items) {
  shopItems = items || [];
  shopSearch = '';
  shopAvailOnly = false;
  // активная вкладка пуста (нет таких товаров) → берём первую непустую
  if (!shopItems.some((it) => tabKinds(shopTab).includes(it.kind))) {
    const first = shopTabs.find((t) => shopItems.some((it) => t.kinds.includes(it.kind)));
    shopTab = first ? first.id : shopTabs[0].id;
  }
  locActions.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'shop-panel';
  panel.appendChild(makeButton('loc-chip shop-back',
    `<span class="lc-ico">${ICON_GO}</span><span>Назад</span>`,
    () => renderLocationActions(LOCATIONS[currentLoc])));

  // поиск по названию + фильтр «только доступные мне» (ТЗ #2)
  const tools = document.createElement('div');
  tools.className = 'shop-tools';
  tools.innerHTML = `
    <input class="shop-search" type="search" placeholder="Поиск по названию…" aria-label="Поиск">
    <label class="shop-avail"><input type="checkbox" class="shop-avail-cb"> Доступные</label>`;
  const search = tools.querySelector('.shop-search');
  search.addEventListener('input', () => { shopSearch = search.value.trim().toLowerCase(); renderShopList(); });
  tools.querySelector('.shop-avail-cb').addEventListener('change', (e) => {
    shopAvailOnly = e.target.checked; renderShopList();
  });
  panel.appendChild(tools);

  // вкладки-категории (ТЗ #3)
  const tabs = document.createElement('div');
  tabs.className = 'shop-tabs';
  for (const t of shopTabs) {
    if (!shopItems.some((it) => t.kinds.includes(it.kind))) continue;
    const b = makeButton('shop-tab' + (t.id === shopTab ? ' active' : ''), esc(t.name), () => {
      shopTab = t.id;
      tabs.querySelectorAll('.shop-tab').forEach((x) => x.classList.toggle('active', x === b));
      renderShopList();
    });
    tabs.appendChild(b);
  }
  panel.appendChild(tabs);

  shopListEl = document.createElement('div');
  shopListEl.className = 'shop-list';
  panel.appendChild(shopListEl);
  locActions.appendChild(panel);
  renderShopList();
}

/** Перерисовать только список товаров под активную вкладку/поиск/фильтр. */
function renderShopList() {
  if (!shopListEl) return;
  let list = shopItems.filter((it) => tabKinds(shopTab).includes(it.kind));
  if (shopSearch) list = list.filter((it) => (it.name || '').toLowerCase().includes(shopSearch));
  if (shopAvailOnly) list = list.filter((it) => shopCharLevel >= (it.levelReq || 1));
  shopListEl.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'shop-loading';
    empty.textContent = 'Ничего не найдено';
    shopListEl.appendChild(empty);
    return;
  }
  for (const it of list) shopListEl.appendChild(shopItemRow(it));
}

/** Строка товара: иконка/инфо + степпер количества (− N +) и кнопка покупки (ТЗ #1). */
function shopItemRow(it) {
  const q = it.quality || 1;
  const levelReq = it.levelReq || 1;
  const locked = shopCharLevel < levelReq;     // купить можно только по уровню
  const row = document.createElement('div');
  row.className = 'shop-item q' + q + (locked ? ' locked' : '');
  row.innerHTML = `
    <div class="shop-ico q${q}">${esc(shopIcon(it.kind, it))}</div>
    <div class="shop-info">
      <div class="shop-name">${esc(it.name)}</div>
      <div class="shop-desc">${esc(it.stats ? gearStatsText(it.stats) : (it.description || ''))}</div>
      <div class="shop-price">${Number(it.price) || 0} меди
        <span class="shop-lvl${locked ? ' lock' : ''}">ур. ${levelReq}</span></div>
    </div>
    <div class="shop-buy-row">
      <div class="shop-stepper">
        <button type="button" class="shop-qm" aria-label="Меньше">−</button>
        <input class="shop-qty" type="number" min="1" max="99" value="1" inputmode="numeric" aria-label="Количество">
        <button type="button" class="shop-qp" aria-label="Больше">+</button>
      </div>
      <button class="shop-buy" type="button"${locked ? ' disabled' : ''}>${locked ? 'Ур. ' + levelReq : 'Купить'}</button>
    </div>`;
  const qty = row.querySelector('.shop-qty');
  const btn = row.querySelector('.shop-buy');
  const qm = row.querySelector('.shop-qm');
  const qp = row.querySelector('.shop-qp');
  const cur = () => Math.trunc(Number(qty.value)) || 1;
  qm.addEventListener('click', () => { qty.value = Math.max(1, cur() - 1); });
  qp.addEventListener('click', () => { qty.value = Math.min(99, cur() + 1); });
  qty.addEventListener('change', () => { qty.value = Math.max(1, Math.min(99, cur())); });
  if (locked) { qty.disabled = qm.disabled = qp.disabled = true; btn.title = `Требуется уровень ${levelReq}`; }
  else btn.addEventListener('click', () => buyShopItem(it, qty, btn));
  return row;
}

async function buyShopItem(it, qtyEl, btn) {
  const qty = Math.max(1, Math.min(99, Math.trunc(Number(qtyEl.value) || 1)));
  qtyEl.value = qty;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res = await api.shopBuy(it.templateId, qty);
    PLAYER.wallet = { copper: 0, silver: 0, gold: 0, diamond: 0, ...res.wallet };
    delete PLAYER.wallet.valor;
    renderMoney();
    registerServerItems(res.inventory || await api.inventory());
    showToast(`Куплено: ${it.name} x${res.bought?.quantity || qty}`);
  } catch (e) {
    showToast(shopErrorText(e));
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function setLocation(key, { quiet = false } = {}) {
  currentLoc = key;
  const loc = LOCATIONS[key];
  if (loc.id !== locationNpcLocId) {
    locationNpcs = [];
    locationNpcLocId = null;
    locationNpcsError = '';
    locationNpcsLoading = online && !!loc.id;
  }
  if (!quiet) chatMessage('Система', `Вы вошли в локацию «${loc.name}».`, true);
  closeLocPanel();
  closeBattlesPanel();
  // при старте/F5 возврат в идущий бой и эта установка локации идут параллельно;
  // в бою НЕ закрываем док — иначе последнее открытое окно боя гаснет (#5)
  if (mode !== 'battle') closeCastleDock();
  applyUILayout();
  renderLocationActions(loc);
  refreshLocationNpcs();
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

// Добыча после боя (#1.7): из награды сервера (battleEnd.reward = {exp, currency, amount})
// собираем список чипов «что выпало». Валюта и опыт уже начислены сервером — здесь
// только показ. Предметного лута пока нет, но формат расширяемый.
const CUR_DROP_LABEL = { copper: 'меди', silver: 'серебра', gold: 'золота',
  diamond: 'кристаллов', valor: 'доблести' };
const CUR_DROP_GLYPH = { copper: '🪙', silver: '🪙', gold: '🪙',
  diamond: '💎', valor: '🎖️' };
function battleDrop(reward) {
  if (!reward) return [];
  const out = [];
  if (Number(reward.exp) > 0)
    out.push({ glyph: '⭐', value: '+' + reward.exp, label: 'опыт' });
  if (Number(reward.amount) > 0)
    out.push({ glyph: CUR_DROP_GLYPH[reward.currency] || '🪙',
      value: '+' + reward.amount, label: CUR_DROP_LABEL[reward.currency] || '' });
  if (Array.isArray(reward.items))   // на будущее: предметный лут
    for (const it of reward.items)
      out.push({ glyph: '🎁', value: '×' + (it.qty || 1), label: it.name || 'предмет' });
  return out;
}

// Очередь боевых событий: turnStart/resolve/elixir/battleEnd обрабатываются строго
// по одному, со ВЗАИМНЫМ ожиданием. Розыгрыш удара асинхронный (играет анимацию
// через await), а сервер/replay могут выпустить несколько событий подряд — без
// очереди их обработчики шли бы параллельно и анимации накладывались. Цепочка
// гарантирует: следующее событие стартует только когда предыдущее доиграло.
let battleOpChain = Promise.resolve();
function battleSerial(fn) {
  battleOpChain = battleOpChain.then(fn).catch((err) => console.error('Боевое событие:', err));
  return battleOpChain;
}

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

const startBattle = (npc) =>
  enterBattle(npc ? { starter: () => ServerBattle.hunt(npc) } : undefined);
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
      ui.hideControls();           // удар выбран — прячем колесо; пояс остаётся доступен
      battle.submitMove('left', move);
    },
    onInfo: (side) => showFighterInfo(side),
    onMemberInfo: (id) => showMemberInfo(id),
    onEffectInfo: (eff) => showEffectPreview(eff),   // превью эффекта в окне боя (#8)
  });
  await loadBelt();                // состав пояса с сервера (он его помнит)
  beltSnapshot = snapshotBelt();   // запомнить состав — для автозаполнения после боя (#2)
  resetElixirBattle();             // эффекты с нуля; пояс уже загружен
  setBeltLive(true);               // расходники доступны весь бой (в любой ход, ТЗ)
  lastTurnShown = 0;
  currentFocusId = battle.focus ? (battle.focus.id ?? null) : null;
  showHP('left', battle.sides.left.hp, battle.sides.left.maxHp);
  showHP('right', battle.sides.right.hp, battle.sides.right.maxHp);
  ui.setOpponent(battle.focus);
  applyBattleRoster(battle.roster);
  totalDamage = 0;
  ui.setDamage(0);
  refreshHeaderEffects();
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

  // новый бой — чистая очередь событий (хвосты прошлого боя не тянем)
  battleOpChain = Promise.resolve();

  battle.addEventListener('turnStart', (e) => battleSerial(() => {
    const d = e.detail;
    if (d.turn !== lastTurnShown) { ui.setTurn(d.turn); lastTurnShown = d.turn; }
    ui.startCountdown(d.timeLeft);   // локальный отсчёт — дисплей не «зависнет» без пакетов
    if (d.roster) applyBattleRoster(d.roster);
    updateBattleInfo();
    // расходники доступны в ЛЮБОЙ ход (ТЗ) — пояс live весь бой, его не гасим по ходам
    if (d.canAct) {                // мой ход
      applyFocus(d.focus);
      ui.setTargets();             // сохранить ручную цель эффекта (если есть)
      ui.showControls();
    } else if (d.waiting) {        // ходит союзник — ждём своего соперника
      setOpponentVisible(false);
      ui.showWait();
    } else {                       // ходит враг — смотрим на него
      applyFocus(d.focus);
      ui.showWaitTimer();
    }
    if (!beltLive) setBeltLive(true);
  }));

  // timer — лёгкий ресинк дисплея, идёт МИМО очереди (иначе отсчёт лагал бы за
  // анимацией розыгрыша); сам отсчёт ведёт клиент, сервер только сверяет значение
  battle.addEventListener('timer', (e) => ui.syncCountdown(e.detail.timeLeft));

  battle.addEventListener('rosterUpdate', (e) => battleSerial(() => {
    if (e.detail.roster) applyBattleRoster(e.detail.roster);
    updateBattleInfo();
  }));

  battle.addEventListener('resolve', (e) => battleSerial(async () => {
    const d = e.detail;
    // пояс НЕ гасим (расходники доступны в любой ход), скрываем только колесо удара
    ui.showResolving();            // колесо скрыто, баннер убран — видна анимация
    if (d.roster) applyBattleRoster(d.roster);
    if (d.focus) applyFocus(d.focus);
    updateBattleInfo();
    // в журнал — только удары (#10): пропуски ход не логируем
    try {
      for (const s of d.strikes || []) {
        // удары показываем (и логируем) ТОЛЬКО с противником напротив, т.е. где я —
        // атакующий или цель. Чужие удары (offscreen) в мой лог не идут (ТЗ #5).
        if (s.offscreen) continue;
        await playStrike(s, d.sides);
      }
    } catch (err) {
      // анимация не должна «подвесить» бой — досрочно отдаём ход дальше
      console.error('Ошибка анимации удара:', err);
    } finally {
      // серверный счётчик «Эликсира мощи» убывает с каждым ударом — синхронизируем чип
      if (d.sides && d.sides.left && d.sides.left.buffTurns != null) {
        selfBuffTurns = d.sides.left.buffTurns;
        syncEffectFromFighter(battle.sides.left);
        syncEffectFromFighter(battle.sides.right);
        refreshSelfEffects();
      }
      battle.finishTurn();
    }
  }));

  // Эликсир применил и СПИСАЛ сервер: обновляем ростер, остаток ячейки у пьющего,
  // и (если эффект пришёлся на меня) — HP/всплывашку/чип эффекта.
  battle.addEventListener('elixir', (e) => battleSerial(() => {
    const d = e.detail;
    if (d.roster) applyBattleRoster(d.roster);
    updateBattleInfo();
    // остаток заряда в моей ячейке (пил я) — пояс авторитетно с сервера
    if (d.isUser && d.slot != null && elixirBelt[d.slot]) {
      if (d.slotQty != null && d.slotQty <= 0) elixirBelt[d.slot] = null;  // слот опустел (#2)
      else elixirBelt[d.slot].qty = d.slotQty;
      renderCombatBar();
    }
    // мой свиток ушёл на тайм-аут — заводим серую зону его слота
    if (d.isUser && d.cooldownUntil
        && (d.kind === 'poison' || d.kind === 'heal_scroll' || d.kind === 'cleanse')) {
      scrollCdEnd[d.kind] = d.cooldownUntil;
      renderCombatBar();
    }
    if (d.target) syncEffectFromFighter(d.target);
    // В ЛОГ — только события, которые касаются меня: я применил расходник (isUser)
    // или его применили на меня (onSelf). Чужие эликсиры (между другими бойцами)
    // в моём логе не показываем — неважно, стоят ли они напротив (ТЗ #5).
    if (d.isUser || d.onSelf) {
      const byName = esc(d.byName || battle.sides.left.name);
      const tn = d.targetName && d.targetName !== d.byName ? ` для <b>${esc(d.targetName)}</b>` : '';
      const tnFoe = d.targetName && d.targetName !== d.byName ? ` <b>${esc(d.targetName)}</b>` : '';
      const every = d.everySec ? `, каждые ${d.everySec} c` : '';
      if (d.kind === 'health') ui.log(`<b>${byName}</b> пьёт эликсир жизни${tn} (+${d.amount} HP за ${d.secs} c${every})`);
      else if (d.kind === 'mana') ui.log(`<b>${byName}</b> пьёт эликсир маны${tn} (+${d.amount} MP за ${d.secs} c${every})`);
      else if (d.kind === 'power') ui.log(`<b>${byName}</b> усиливает удары${tn} на +${Math.round((d.mult - 1) * 100)}% (${d.turns} х.)`);
      else if (d.kind === 'blood') ui.log(`<b>${byName}</b> повышает шанс крита${tn} на +${Math.round((d.critAdd || 0) * 100)}% (${d.turns} х.)`);
      else if (d.kind === 'poison') ui.log(`<b>${byName}</b> отравляет${tnFoe} (−${d.amount} HP за ${d.secs} c${every})`);
      else if (d.kind === 'heal_scroll') ui.log(`<b>${byName}</b> читает свиток исцеления${tn} (+${d.amount} HP за ${d.secs} c${every})`);
      else if (d.kind === 'cleanse') ui.log(`<b>${byName}</b> очищает эффекты${tnFoe || tn}`);
      else if (d.kind === 'escape') ui.log(`<b>${byName}</b> использует Эликсир побега`);
    }

    const side = effectPopupSide(d);
    if (!side) {
      refreshHeaderEffects();
      return;
    }
    showHP(side, d.hp, d.maxHp);
    const fighter = fighters[side];
    const pos = fighter
      ? arena.worldToScreen(fighter.headPoint()) : { x: side === 'left' ? 70 : 220, y: 90 };
    // всплывашка — НАЗВАНИЕ расходника (ТЗ #4), а не «Крит +»/«Яд»/…
    const label = d.itemName || ELIXIR_KIND_LABEL[d.kind] || '';
    if (d.kind === 'power' && side === 'left') selfBuffPct = Math.round((d.mult - 1) * 100);
    ui.popup(pos, label, d.kind === 'poison' ? 'name-bad' : 'name');
    if (d.kind === 'escape' && side === 'right') setOpponentVisible(false);
    if (side === 'left') selfBuffTurns = d.buffTurns || 0;
    refreshSelfEffects();
    renderCombatBar();         // мощь активна → её слот уходит на «перезарядку» (#3)
  }));

  // эффекты по времени (лечение/яд/мана) тикают на сервере — обновляем полосы и чипы
  battle.addEventListener('effectTick', (e) => battleSerial(() => {
    const d = e.detail;
    // applyBattleRoster уже зовёт refreshHeaderEffects — не дублируем (лишний джанк
    // под несколькими ядами); без ростера обновляем шапку напрямую
    if (d.roster) applyBattleRoster(d.roster);
    else refreshHeaderEffects();
    const left = battle.sides.left;
    if (left && left.maxHp) showHP('left', left.hp, left.maxHp);
    const right = battle.focus || battle.sides.right;
    if (right && right.maxHp) showHP('right', right.hp, right.maxHp);
    showEffectNumbers(d.changed);   // всплывашки урона/лечения от свитков/HoT (ТЗ #5)
    updateBattleInfo();
  }));

  // battleEnd — через очередь: показ итога дожидается последней анимации удара/смерти
  battle.addEventListener('battleEnd', (e) => battleSerial(() => {
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
    // долить пояс из рюкзака, если включено автозаполнение (#2)
    autofillBeltAfterBattle().catch(console.error);
    // добыча после боя (#1.7): опыт + валюта, которые начислил сервер
    ui.showEnd(victory, { onLeave: () => leaveBattle(true), drop: battleDrop(e.detail.reward) });
  }));

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
      : code === 'on_cooldown' ? 'Свиток ещё на перезарядке'
      : code === 'no_target' ? 'Нет цели для свитка'
      : code === 'ally_only' ? 'Исцелять можно только союзников'
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
      // контратака — отдельная подпись всплывашки (рипост, без направления)
      ui.popup(pos, s.counter ? `⚡−${dmg}` : `−${dmg}`, s.crit ? 'crit' : 'dmg');
    }
    // бьют игрока направленным ударом — запоминаем зону на колесе (метка видна в
    // следующий свой ход). У контратаки направления нет (zone=null) — метку не ставим.
    if (s.defender === 'left' && !s.dodged && s.zone) {
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
    const zone = s.zone ? (ZONE_LABELS[s.zone] || s.zone) : '';
    let text;
    if (s.counter) {
      // контратака без направления: «в зону» не пишем
      if (s.dodged) text = `<b>${whom}</b> уклонился от контратаки`;
      else if (s.crit) text = `<b>${who}</b> наносит <span class="crit">критическую контратаку</span>: −${dmg}`;
      else if (s.blocked) text = `<b>${whom}</b> отбивает контратаку: −${dmg}`;
      else text = `<b>${who}</b> контратакует: −${dmg}`;
    } else if (s.dodged) text = `<b>${whom}</b> уклонился от удара`;
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
// вкладки панели боёв: «Текущие» / «Завершённые» (#C2)
$('battles-tabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.battles-tab');
  if (!tab || tab.dataset.bt === battlesTab) return;
  battlesTab = tab.dataset.bt;
  syncBattlesTabs();
  refreshBattles();
});

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

// ---------------------------------------------------------------------------
// Чат: вкладки (общий / клан / личка), личные сообщения в общем, кликабельные
// объекты-ссылки на бой и инфо игрока. Личка — отдельные закрываемые вкладки.
// ---------------------------------------------------------------------------

const chatLog = $('chat-log');
const chatTabsEl = $('chat-tabs');
const chatInput = $('chat-input');
const personalBar = $('chat-personal-bar');
const MAX_CHAT_LINES = 1000;   // суточная история без мелкого обрезания

let activeChat = 'common';          // 'common' | 'clan' | 'dm:<peerId>'
let personalTarget = null;          // {id, name} — следующее сообщение в общий чат как личное
const commonMsgs = [];              // {kind, author, authorId, text, to, toId}
const dmConvos = new Map();         // peerId(String) -> {name, msgs:[{mine,text,ts}], unread, loaded}

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

// ── Кликабельные объекты в тексте: «Бой #N», ссылки ?battle=N и ?info=Ник ──

function battleChip(id, label) {
  const a = document.createElement('a');
  a.className = 'chat-chip battle-link';
  a.href = '#';
  a.textContent = '⚔ ' + (label || ('Бой #' + id));
  a.addEventListener('click', (e) => { e.preventDefault(); openBattleInfo(Number(id)); });
  return a;
}
function infoChip(name) {
  const a = document.createElement('a');
  a.className = 'chat-chip info-link';
  a.href = '#';
  a.textContent = '👤 ' + name;
  a.addEventListener('click', (e) => { e.preventDefault(); openPlayerInfo({ name }); });
  return a;
}
/** Если URL — ссылка игры (?battle=N или ?info=Ник), вернуть чип, иначе null. */
function chipFromUrl(url) {
  try {
    const u = new URL(url);
    const b = u.searchParams.get('battle');
    if (b && /^\d+$/.test(b)) return battleChip(Number(b));
    const info = u.searchParams.get('info');
    if (info) return infoChip(info);
  } catch { /* не URL — ниже как текст */ }
  return null;
}
/** Разобрать текст на текстовые узлы и кликабельные объекты. */
function linkifyInto(el, text) {
  const re = /(https?:\/\/[^\s]+)|Бой #(\d+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const plain = text.slice(last, m.index).replace(/⚔\s*$/, '');
      if (plain) el.appendChild(document.createTextNode(plain));
    }
    if (m[1]) {
      const chip = chipFromUrl(m[1]);
      el.appendChild(chip || document.createTextNode(m[1]));
    } else {
      el.appendChild(battleChip(Number(m[2]), m[0]));
    }
    last = re.lastIndex;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

/** Кликабельный ник: открывает меню действий. Свой ник — тоже (меню урезано). */
function nickEl(name, id) {
  const b = document.createElement('b');
  b.className = 'chat-nick tappable';
  b.textContent = name;
  b.addEventListener('click', (e) => { e.stopPropagation(); openNickMenu(e, { id, name }); });
  return b;
}

// ── Построение строк чата ──

/** Время сообщения «ЧЧ:ММ» отдельным приглушённым значком в начале строки. */
function chatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function timeEl(ts) {
  const s = document.createElement('span');
  s.className = 'chat-time';
  s.textContent = chatTime(ts);
  return s;
}

function chatLineEl(msg) {
  const line = document.createElement('div');
  if (msg.ts) line.appendChild(timeEl(msg.ts));
  if (msg.kind === 'system') {
    line.className = 'chat-line system';
    const b = document.createElement('b');
    b.textContent = '[Система]';
    line.append(b, document.createTextNode(': '));
    linkifyInto(line, msg.text);
    return line;
  }
  line.className = 'chat-line' + (msg.to ? ' personal' : '');
  line.appendChild(nickEl(msg.author, msg.authorId));
  if (msg.to) {                       // личное в общем: «Игрок → Цель»
    line.appendChild(document.createTextNode(' → '));
    line.appendChild(nickEl(msg.to, msg.toId));
  }
  line.appendChild(document.createTextNode(': '));
  linkifyInto(line, msg.text);
  return line;
}

function dmLineEl(m) {
  const line = document.createElement('div');
  line.className = 'chat-line dm ' + (m.mine ? 'mine' : 'their');
  if (m.ts) line.appendChild(timeEl(m.ts));
  const b = document.createElement('b');
  b.textContent = m.mine ? 'Вы' : (m.peerName || '');
  line.append(b, document.createTextNode(': '));
  linkifyInto(line, m.text);
  return line;
}

// ── Рендер вкладок и активного журнала ──

function dmKey(id) { return 'dm:' + id; }

function renderChatTabs() {
  // статичные вкладки уже в HTML; динамически добавляем/убираем вкладки лички
  chatTabsEl.querySelectorAll('.chat-tab').forEach((t) => {
    const tab = t.dataset.chat;
    t.classList.toggle('active', tab === activeChat);
  });
  // убрать вкладки лички закрытых бесед
  chatTabsEl.querySelectorAll('.chat-tab.dm-tab').forEach((t) => {
    if (!dmConvos.has(t.dataset.peer)) t.remove();
  });
  for (const [pid, convo] of dmConvos) {
    let tab = chatTabsEl.querySelector(`.chat-tab.dm-tab[data-peer="${pid}"]`);
    if (!tab) {
      tab = document.createElement('button');
      tab.className = 'chat-tab dm-tab';
      tab.dataset.chat = dmKey(pid);
      tab.dataset.peer = pid;
      tab.innerHTML = `<span class="dm-tab-name"></span>`
        + `<span class="dm-tab-badge hidden"></span>`
        + `<span class="dm-tab-close" title="Закрыть">✕</span>`;
      chatTabsEl.appendChild(tab);
    }
    tab.querySelector('.dm-tab-name').textContent = convo.name;
    const badge = tab.querySelector('.dm-tab-badge');
    badge.textContent = convo.unread > 9 ? '9+' : String(convo.unread);
    badge.classList.toggle('hidden', !convo.unread);
    tab.classList.toggle('active', dmKey(pid) === activeChat);
  }
}

function renderActiveChat() {
  chatLog.innerHTML = '';
  if (activeChat === 'clan') {
    chatLog.innerHTML = '<div class="chat-empty">Клановый чат скоро появится.</div>';
  } else if (activeChat.startsWith('dm:')) {
    const convo = dmConvos.get(activeChat.slice(3));
    if (convo && convo.msgs.length) {
      for (const m of convo.msgs) chatLog.appendChild(dmLineEl({ ...m, peerName: convo.name }));
    } else {
      chatLog.innerHTML = `<div class="chat-empty">Личная переписка с «${esc(convo?.name || '')}».<br>`
        + `Напишите сообщение — оно придёт только этому игроку.</div>`;
    }
  } else {
    for (const msg of commonMsgs) chatLog.appendChild(chatLineEl(msg));
  }
  personalBar.classList.toggle('hidden', !(activeChat === 'common' && personalTarget));
  scrollChatToBottom();
}

function setActiveChat(tab) {
  activeChat = tab;
  if (tab.startsWith('dm:')) {        // открыли личку — сбросить непрочитанные
    const convo = dmConvos.get(tab.slice(3));
    if (convo) convo.unread = 0;
  }
  if (tab === 'common') mentionUnread = 0;   // увидели общий — гасим звоночек личных
  if (tab === 'common' && castleDockPane === 'chat') refreshCommonChatHistory();
  updateChatInputMode();
  renderChatTabs();
  renderActiveChat();
  updateChatBadge();
}

function updateChatInputMode() {
  if (activeChat.startsWith('dm:')) {
    const convo = dmConvos.get(activeChat.slice(3));
    chatInput.placeholder = convo ? `Сообщение для ${convo.name}…` : 'Сообщение…';
  } else if (activeChat === 'clan') {
    chatInput.placeholder = 'Клановый чат скоро…';
  } else {
    chatInput.placeholder = personalTarget
      ? `Личное для ${personalTarget.name}…` : 'Введите сообщение…';
  }
}

// ── Общий чат ──

function pushCommon(msg) {
  commonMsgs.push(msg);
  while (commonMsgs.length > MAX_CHAT_LINES) commonMsgs.shift();
  if (activeChat === 'common') {
    chatLog.appendChild(chatLineEl(msg));
    while (chatLog.children.length > MAX_CHAT_LINES) chatLog.firstChild.remove();
    scrollChatToBottom();
  }
}

/** Системная строка в общий чат (вход в локацию, объявления боёв, чек об оплате почты). */
function chatMessage(author, text, system = false) {
  const ts = Date.now();
  if (system || author === 'Система') pushCommon({ kind: 'system', text: String(text), ts });
  else pushCommon({ kind: 'msg', author, authorId: null, text: String(text), ts });
}
function chatSystem(text) { pushCommon({ kind: 'system', text: String(text), ts: Date.now() }); }

/** Входящее сообщение общего чата (из pub/sub): обычное или личное (to). */
function onCommonChat(m) {
  const ts = m.ts || Date.now();
  if (m.from === 'Система') { pushCommon({ kind: 'system', text: String(m.text), ts }); return; }
  pushCommon({ kind: 'msg', author: m.from, authorId: m.fromId ?? null, text: String(m.text),
    to: m.to || null, toId: m.toId ?? null, ts });
  // личное, адресованное мне — отметить «звоночком» над чатом (#10)
  if (m.toId != null && String(m.toId) === String(PLAYER.id)
      && String(m.fromId) !== String(PLAYER.id)) noteMention();
}

/** История общего чата локации: только сообщения игроков и полезные системные. */
function loadChatHistory(rows) {
  commonMsgs.length = 0;
  for (const h of rows) {
    if (isChatJunk(h.sender_name, h.body)) continue;
    const ts = h.created_at ? new Date(h.created_at).getTime() : null;
    if (h.sender_name === 'Система') commonMsgs.push({ kind: 'system', text: String(h.body), ts });
    else commonMsgs.push({ kind: 'msg', author: h.sender_name, authorId: h.sender_id ?? null,
      text: String(h.body), to: h.target_name || null, toId: null, ts });
  }
  if (activeChat === 'common') renderActiveChat();
}

let commonHistoryLoading = false;
async function refreshCommonChatHistory() {
  if (!online || commonHistoryLoading) return;
  commonHistoryLoading = true;
  try {
    loadChatHistory(await api.chatHistory());
  } catch (e) {
    console.error('История чата:', e);
  } finally {
    commonHistoryLoading = false;
  }
}

// ── Личка (DM) ──

function ensureConvo(peer) {
  const pid = String(peer.id);
  let convo = dmConvos.get(pid);
  if (!convo) {
    convo = { name: peer.name, msgs: [], unread: 0, loaded: false };
    dmConvos.set(pid, convo);
  } else if (peer.name) {
    convo.name = peer.name;
  }
  return convo;
}

/** Открыть (или создать) вкладку лички с игроком и переключиться на неё. */
/** Показать чат-панель, не сворачивая её повторным тапом (openCastleDock — тоггл). */
function ensureChatDock() { if (castleDockPane !== 'chat') openCastleDock('chat'); }

async function openDmTab(peer) {
  const pid = String(peer.id);
  const convo = ensureConvo(peer);
  closeMail(); closeBattleInfo();     // освободить чат из-под модалок
  ensureChatDock();                   // показать чат-панель (без сворачивания)
  setActiveChat(dmKey(pid));
  if (online) {
    try {
      const rows = await api.privateHistory(peer.id);
      convo.msgs = rows.map((r) => ({ mine: r.mine, text: r.body, ts: r.ts }));
      convo.loaded = true;
      if (activeChat === dmKey(pid)) renderActiveChat();
      else renderChatTabs();
    } catch (e) { console.error('История лички:', e); }
  }
  chatInput.focus();
}

function closeDmTab(pid) {
  dmConvos.delete(String(pid));
  if (activeChat === dmKey(pid)) activeChat = 'common';
  updateChatInputMode();
  renderChatTabs();
  renderActiveChat();
  updateChatBadge();
}

/** Входящее приватное сообщение. */
function onDmMessage(m) {
  const pid = String(m.peerId);
  const convo = ensureConvo({ id: pid, name: m.peerName });
  convo.msgs.push({ mine: !!m.mine, text: String(m.text), ts: m.ts });
  while (convo.msgs.length > MAX_CHAT_LINES) convo.msgs.shift();
  if (activeChat === dmKey(pid)) {
    chatLog.appendChild(dmLineEl({ mine: !!m.mine, text: String(m.text), peerName: convo.name }));
    while (chatLog.children.length > MAX_CHAT_LINES) chatLog.firstChild.remove();
    scrollChatToBottom();
  } else if (!m.mine) {
    convo.unread++;
  }
  renderChatTabs();
  updateChatBadge();
}

const CHAT_ERRORS = {
  recipient_not_found: 'Игрок с таким ником не найден',
  cannot_dm_self: 'Нельзя писать самому себе',
  muted: 'Вы не можете писать в чат',
};
/** Ошибка чата/лички с сервера — показываем строкой в открытом чате (видно над клавиатурой). */
function onServerChatError(m) {
  const text = CHAT_ERRORS[m.error] || ('Ошибка: ' + (m.error || 'неизвестно'));
  const line = document.createElement('div');
  line.className = 'chat-line system chat-error';
  line.textContent = '⚠ ' + text;
  chatLog.appendChild(line);
  while (chatLog.children.length > MAX_CHAT_LINES) chatLog.firstChild.remove();
  scrollChatToBottom();
}

// ── Личное сообщение в общий чат: цель ставится из меню ника ──

function setPersonalTarget(peer) {
  personalTarget = { id: peer.id, name: peer.name };
  closeMail(); closeBattleInfo();     // показать общий чат под модалками
  ensureChatDock();
  setActiveChat('common');
  $('cpb-name').textContent = peer.name;
  personalBar.classList.remove('hidden');
  updateChatInputMode();
  chatInput.focus();
}
function clearPersonalTarget() {
  personalTarget = null;
  personalBar.classList.add('hidden');
  updateChatInputMode();
}
$('cpb-clear').addEventListener('click', clearPersonalTarget);

// ── Переключение вкладок и отправка ──

chatTabsEl.addEventListener('click', (e) => {
  const close = e.target.closest('.dm-tab-close');
  if (close) { e.stopPropagation(); closeDmTab(close.closest('.dm-tab').dataset.peer); return; }
  const tab = e.target.closest('.chat-tab');
  if (tab) setActiveChat(tab.dataset.chat);
});

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  chatInput.value = '';
  chatInput.blur();                      // Enter — отправили и скрыли клавиатуру
  if (!text) return;
  if (!online) {                         // оффлайн: локальное эхо в общий
    chatMessage(PLAYER.name, text);
    return;
  }
  if (activeChat.startsWith('dm:')) {
    const convo = dmConvos.get(activeChat.slice(3));
    if (convo) api.sendPrivate(convo.name, text);   // эхо вернётся через chatDM
  } else if (activeChat === 'common' && personalTarget) {
    api.sendPersonal(personalTarget.name, text);    // вернётся всем в локации
    clearPersonalTarget();
  } else {
    api.sendChat(text);                  // обычный общий чат
  }
});

// ---------------------------------------------------------------------------
// Меню по тапу на ник игрока: личка / личное в общий / копировать / инфо
// ---------------------------------------------------------------------------

const nickmenuEl = $('nickmenu');
const nickmenuPop = $('nickmenu-pop');
let nickmenuPeer = null;

function openNickMenu(ev, peer) {
  const self = (peer.id != null && String(peer.id) === String(PLAYER.id))
    || (peer.id == null && peer.name === PLAYER.name);
  nickmenuPeer = { ...peer, self };
  $('nickmenu-head').textContent = peer.name;
  // себе не пишут — прячем «приватное» и «личное»
  nickmenuPop.querySelector('[data-act="private"]').classList.toggle('hidden', self);
  nickmenuPop.querySelector('[data-act="personal"]').classList.toggle('hidden', self);
  nickmenuEl.classList.remove('hidden');
  nickmenuPop.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const r = nickmenuPop.getBoundingClientRect();
    let x = (ev.clientX ?? 20), y = (ev.clientY ?? 20) + 10;
    x = Math.min(x, window.innerWidth - r.width - 8);
    y = Math.min(y, window.innerHeight - r.height - 8);
    nickmenuPop.style.left = Math.max(8, x) + 'px';
    nickmenuPop.style.top = Math.max(8, y) + 'px';
    nickmenuPop.style.visibility = '';
  });
}
function closeNickMenu() { nickmenuEl.classList.add('hidden'); nickmenuPeer = null; }
nickmenuEl.addEventListener('click', (e) => { if (e.target === nickmenuEl) closeNickMenu(); });

/** Гарантировать peer.id: если есть только ник — спросить сервер (для лички/инфо). */
async function resolvePeer(peer) {
  if (peer.id != null) return peer;
  try {
    const p = await api.playerInfo({ name: peer.name });
    return { id: p.id, name: p.name };
  } catch {
    showToast('Игрок не найден'); return null;
  }
}

nickmenuPop.addEventListener('click', (e) => {
  const btn = e.target.closest('.nickmenu-item');
  if (!btn) return;
  const peer = nickmenuPeer;
  closeNickMenu();
  if (!peer) return;
  switch (btn.dataset.act) {
    case 'private':  resolvePeer(peer).then((p) => p && openDmTab(p)); break;
    case 'personal': setPersonalTarget(peer); break;   // личное шлётся по нику
    case 'copy':     writeClipboard(peer.name)
      .then((ok) => showToast(ok ? 'Ник скопирован' : 'Не удалось скопировать')); break;
    case 'info':     openPlayerInfo(peer); break;
  }
});

/**
 * Секции карточки персонажа (характеристики · снаряжение · статистика боёв) из
 * publicInfo `p`. Общий рендер для карточки игрока и инфо-карточки боя (#C3).
 * Пустые блоки не рисуются (у ИИ нет stats/record).
 */
function pinfoSectionsHtml(p) {
  if (!p) return '';
  const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
  const statCell = (label, val) =>
    `<div class="pinfo-stat"><i>${label}</i><b>${val}</b></div>`;
  let html = '';
  if (p.stats) {                        // только базовые АТРИБУТЫ (задают школу); бой — в «Параметрах»
    const s = p.stats;
    const cells = [
      statCell('Сила', s.str), statCell('Ловкость', s.agi), statCell('Выносл.', s.vit),
      statCell('Интел.', s.intel), statCell('Мудрость', s.wis),
    ];
    html += `<div class="pinfo-sec">
      <div class="pinfo-sec-title">Атрибуты</div>
      <div class="pinfo-grid">${cells.join('')}</div></div>`;
  }
  if (p.params) {                       // модельные «ПАРАМЕТРЫ» (треугольник) + школа
    const m = p.params;
    const SCHOOL = { natisk: 'Натиск', uklon: 'Уклон', oplot: 'Оплот' };
    const order = [
      ['power', 'Мощь'], ['health', 'Здоровье'], ['mana', 'Мана'], ['rage', 'Ярость'],
      ['initiative', 'Инициатива'], ['defense', 'Защита'], ['accuracy', 'Точность'],
      ['dodge', 'Уклонение'], ['crit', 'Крит'], ['critPower', 'Сила Крита'],
      ['critResist', 'Сопр. Криту'], ['block', 'Блок'], ['blockDmg', 'Блок урона'],
      ['counter', 'Контратака'],
    ];
    const pctKeys = new Set(['critPower', 'blockDmg']);
    const cells2 = order.map(([k, label]) => statCell(label,
      m[k] == null ? '—' : (pctKeys.has(k) ? `${Math.round(m[k])}%` : Math.round(m[k])))).join('');
    const sLabel = SCHOOL[p.school] || '';
    html += `<div class="pinfo-sec">
      <div class="pinfo-sec-title">Параметры${sLabel ? ` · ${esc(sLabel)}` : ''}</div>
      <div class="pinfo-grid">${cells2}</div></div>`;
  }
  if (Array.isArray(p.equipment)) {
    const rows = p.equipment.map((e) => {
      const label = SLOT_META[slotNameFor(e.slot)]?.name || 'Слот';
      const ench = e.enchant > 0 ? ` <span class="pinfo-ench">+${e.enchant}</span>` : '';
      return `<div class="pinfo-equip-row">
        <span class="pinfo-equip-ico">${esc(itemIconText(e.icon, e.type, e.stats, e.slot))}</span>
        <span class="pinfo-equip-slot">${esc(label)}</span>
        <span class="pinfo-equip-name">${esc(e.name)}${ench}</span>
      </div>`;
    }).join('');
    html += `<div class="pinfo-sec">
      <div class="pinfo-sec-title">Снаряжение</div>
      ${p.equipment.length ? `<div class="pinfo-equip">${rows}</div>`
        : '<div class="pinfo-empty">Ничего не надето</div>'}</div>`;
  }
  if (p.record) {
    const r = p.record;
    const chip = (label, val, cls = '') =>
      `<div class="pinfo-rec-chip ${cls}"><b>${val}</b><i>${label}</i></div>`;
    html += `<div class="pinfo-sec">
      <div class="pinfo-sec-title">Статистика боёв</div>
      <div class="pinfo-rec">
        ${chip('боёв', r.battles)}
        ${chip('побед', r.wins, 'win')}
        ${chip('поражений', r.losses, 'lose')}
        ${chip('убийств', r.kills)}
        ${chip('смертей', r.deaths)}
      </div></div>`;
  }
  return html;
}

/** Карточка игрока (пункт «Информация»). Рисуем в окне #binfo, пряча «ссылку». */
async function openPlayerInfo(peer) {
  if (!online) { showToast('Нет связи с сервером'); return; }
  binfoId = null;
  clearInterval(binfoTimer); binfoTimer = null;
  binfoTitle.textContent = peer.name || 'Игрок';
  binfoBody.innerHTML = '<div class="bi-empty">Загрузка…</div>';
  if (binfoCopyBtn) binfoCopyBtn.style.display = 'none';
  binfoEl.classList.remove('hidden');
  let p;
  try {
    p = await api.playerInfo(peer);
  } catch (e) {
    binfoBody.innerHTML = `<div class="bi-empty">Не удалось загрузить: ${esc(e.message)}</div>`;
    return;
  }
  binfoTitle.textContent = p.name;
  const self = String(p.id) === String(PLAYER.id);
  const sectionsHtml = pinfoSectionsHtml(p);   // атрибуты · параметры · снаряжение · статистика
  const lastOnline = p.online ? 'сейчас' : (p.lastOnlineAt ? mailDate(p.lastOnlineAt) : '—');
  // распределение очков живёт во вкладке «Параметры» рюкзака; здесь карточка только показывает

  const actionsHtml = self ? '' : `
      <div class="pinfo-actions">
        <button type="button" class="bi-join-btn" data-pi="dm">Приватное сообщение</button>
        <button type="button" class="bi-join-btn" data-pi="mail">Письмо</button>
      </div>`;

  binfoBody.innerHTML = `
    <div class="pinfo">
      <div class="pinfo-head">
        <div class="pinfo-row"><span>Уровень</span><b>${p.level ?? '?'}</b></div>
        <div class="pinfo-row"><span>Локация</span><b>${esc(p.location || '—')}</b></div>
        <div class="pinfo-row"><span>Статус</span>
          <b class="${p.online ? 'pinfo-on' : 'pinfo-off'}">${p.online ? 'в сети' : 'не в сети'}</b></div>
        <div class="pinfo-row"><span>Был в сети</span><b>${esc(lastOnline)}</b></div>
      </div>
      ${p.about ? `<div class="pinfo-about">${esc(p.about)}</div>` : ''}
      ${sectionsHtml}
      ${actionsHtml}
    </div>`;
  // кнопки «написать» только для ЧУЖОГО профиля (себе писать нельзя, #B3)
  binfoBody.querySelectorAll('.pinfo-actions .bi-join-btn').forEach((b) => {
    b.addEventListener('click', () => {
      closeBattleInfo();
      if (b.dataset.pi === 'dm') openDmTab({ id: p.id, name: p.name });
      else openMail({ to: p.name });
    });
  });
}

// ---------------------------------------------------------------------------
// Почта: список писем · чтение · отправка (налог считает сервер)
// ---------------------------------------------------------------------------

const mailEl = $('mail');
const mailBody = $('mail-body');
const mailTitle = $('mail-title');
const mailBadge = $('mail-badge');
let mailUnreadN = 0;
let mailTariffs = { taxSend: 100, itemPct: 0.1, maxAtt: 8 };
let mailCompose = null;   // null | { to, attach:[{id,name,icon,price,qty,maxQty,stackable}] }
let mailBox = 'inbox';

function setMailBadge(n) {
  mailUnreadN = Math.max(0, Number(n) || 0);
  if (!mailBadge) return;
  mailBadge.textContent = mailUnreadN > 99 ? '99+' : String(mailUnreadN);
  mailBadge.classList.toggle('hidden', mailUnreadN === 0);
}
async function refreshMailUnread() {
  if (!online) return;
  try { setMailBadge((await api.mailUnread()).unread); } catch (e) { /* не критично */ }
}

/** Символ предмета: серверный icon-ключ (буквы вроде elixirHealth) — не символ. */
function itemIconText(icon, type, stats, slot) {
  if (type === 4) return ELIXIR_EMOJI[elixirKindFromStats(stats)] || '🧪';
  if (!icon || /[A-Za-z]/.test(String(icon))) return gearIconFromSlot(slot) || gearIconFromType(type);
  return icon;
}

function closeMail() { mailEl.classList.add('hidden'); mailCompose = null; }
$('mail-close').addEventListener('click', closeMail);
mailEl.addEventListener('click', (e) => { if (e.target === mailEl) closeMail(); });
mailEl.addEventListener('pointerdown', (e) => {
  const active = document.activeElement;
  if (!active || !mailEl.contains(active)) return;
  if (!active.matches('input, textarea')) return;
  if (e.target.closest('input, textarea')) return;
  active.blur();
});
$('mail-compose').addEventListener('click', () => openCompose());

/** Открыть почту: список писем (или сразу написать письмо адресату opts.to). */
async function openMail(opts = {}) {
  if (!online) { showToast('Почта доступна только онлайн'); return; }
  mailEl.classList.remove('hidden');
  if (opts.to) { await openCompose(opts.to); return; }
  await renderMailBox('inbox');
}

function renderInbox() { return renderMailBox('inbox'); }

function mailTabsHtml(active) {
  return `<div class="mail-tabs">
    <button type="button" class="mail-tab ${active === 'inbox' ? 'active' : ''}" data-mail-box="inbox">Входящие</button>
    <button type="button" class="mail-tab ${active === 'sent' ? 'active' : ''}" data-mail-box="sent">Отправленные</button>
  </div>`;
}

function bindMailTabs() {
  mailBody.querySelectorAll('.mail-tab').forEach((tab) => {
    tab.addEventListener('click', () => renderMailBox(tab.dataset.mailBox));
  });
}

async function renderMailBox(box = 'inbox') {
  mailBox = box === 'sent' ? 'sent' : 'inbox';
  mailCompose = null;
  mailTitle.textContent = 'Почта';
  $('mail-compose').style.display = '';
  mailBody.innerHTML = mailTabsHtml(mailBox) + '<div class="mail-list-wrap"><div class="bi-empty">Загрузка…</div></div>';
  bindMailTabs();
  const host = mailBody.querySelector('.mail-list-wrap');
  let data;
  try {
    data = mailBox === 'sent' ? await api.mailSent() : await api.mail();
  } catch (e) {
    host.innerHTML = `<div class="bi-empty">Не удалось загрузить: ${esc(e.message)}</div>`;
    return;
  }
  if (data.tariffs) mailTariffs = data.tariffs;
  setMailBadge(data.unread);
  if (!data.items.length) {
    host.innerHTML = mailBox === 'sent'
      ? '<div class="bi-empty">Отправленных писем нет.</div>'
      : '<div class="bi-empty">Писем нет. Нажмите «Написать», чтобы отправить.</div>';
    return;
  }
  const list = document.createElement('div');
  list.className = 'mail-list';
  for (const it of data.items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mail-row' + (mailBox === 'inbox' && !it.isRead ? ' unread' : '');
    const att = it.attCount ? `<span class="mail-clip" title="Вложения">📎${it.attCount}</span>` : '';
    const coin = mailValueChips(it.money, it.diamond);
    const peer = mailBox === 'sent'
      ? `Кому: ${esc(it.recipientName || '')}`
      : esc(it.senderName);
    const readState = mailBox === 'sent'
      ? `<span class="mail-read-state ${it.isRead ? 'read' : 'unread'}">${it.isRead ? 'прочитано' : 'не прочитано'}</span>`
      : '';
    row.innerHTML = `
      <span class="mail-dot" aria-hidden="true"></span>
      <span class="mail-row-main">
        <span class="mail-row-from">${peer}</span>
        <span class="mail-row-subj">${esc(it.subject || '(без темы)')}</span>
      </span>
      <span class="mail-row-meta">${readState}${coin}${att}<span class="mail-row-date">${mailDate(it.ts)}</span></span>`;
    row.addEventListener('click', () => openLetter(it.id, mailBox));
    list.appendChild(row);
  }
  host.innerHTML = '';
  host.appendChild(list);
}

function mailDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function openLetter(id, box = mailBox) {
  const sentBox = box === 'sent';
  mailBox = sentBox ? 'sent' : 'inbox';
  $('mail-compose').style.display = 'none';
  mailTitle.textContent = sentBox ? 'Отправленное письмо' : 'Письмо';
  mailBody.innerHTML = '<div class="bi-empty">Загрузка…</div>';
  let m;
  try {
    m = sentBox ? await api.mailReadSent(id) : await api.mailRead(id);
  } catch (e) {
    mailBody.innerHTML = `<div class="bi-empty">Не удалось открыть: ${esc(e.message)}</div>`;
    return;
  }
  if (!sentBox) refreshMailUnread();   // письмо стало прочитанным — обновить бейдж
  const peerId = sentBox ? m.recipientId : m.senderId;
  const peerName = sentBox ? m.recipientName : m.senderName;
  const peerTappable = peerId && String(peerId) !== String(PLAYER.id);
  const attachments = m.attachments || [];
  const att = attachments.map((a) => `
    <div class="mail-att">
      <span class="mail-att-icon">${esc(itemIconText(a.icon, a.type, a.stats))}</span>
      <span class="mail-att-name">${esc(a.name)}${a.quantity > 1 ? ` ×${a.quantity}` : ''}</span>
    </div>`).join('');
  const readState = sentBox
    ? `<span class="mail-status ${m.isRead ? 'read' : 'unread'}">${m.isRead ? 'Получатель прочитал' : 'Получатель еще не прочитал'}</span>`
    : '';
  const attTitle = sentBox ? 'Вложения' : `Вложения${m.canClaim ? '' : ' (получены)'}`;
  mailBody.innerHTML = `
    <div class="mail-read">
      <div class="mail-read-head">
        <span>${sentBox ? 'Кому' : 'От'}: <b class="mail-from ${peerTappable ? 'tappable' : ''}">${esc(peerName || 'Система')}</b></span>
        <span class="mail-read-date">${mailDate(m.ts)}</span>
      </div>
      ${readState}
      <div class="mail-read-subj">${esc(m.subject || '(без темы)')}</div>
      <div class="mail-read-body">${esc(m.body) || '<i>пусто</i>'}</div>
      ${(attachments.length || m.money > 0 || m.diamond > 0) ? `<div class="mail-att-box">
        <div class="mail-att-title">${attTitle}</div>
        ${mailValueRows(m.money, m.diamond)}${att}
        ${!sentBox && m.canClaim ? `<button type="button" class="mail-btn mail-take">Забрать${attachments.length ? ' в рюкзак' : ''}</button>` : ''}
      </div>` : ''}
      <div class="mail-read-actions">
        <button type="button" class="mail-btn mail-back">Назад</button>
        ${sentBox ? '<button type="button" class="mail-btn mail-del-sent">Удалить из отправленных</button>' : `
          <button type="button" class="mail-btn mail-reply">Ответить</button>
          <button type="button" class="mail-btn mail-del">Удалить</button>`}
      </div>
    </div>`;
  if (peerTappable) {
    mailBody.querySelector('.mail-from').addEventListener('click', (e) =>
      openNickMenu(e, { id: peerId, name: peerName }));
  }
  mailBody.querySelector('.mail-back').addEventListener('click', () => renderMailBox(mailBox));
  mailBody.querySelector('.mail-take')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api.mailTake(id);
      await refreshSelf();
      const got = [];
      if (r.taken) got.push('вещи в рюкзаке');
      const val = mailValueText(r.money, r.diamond);
      if (val) got.push(val);
      showToast(got.length ? 'Получено: ' + got.join(', ') : 'Уже получено');
      refreshMailUnread();
      openLetter(id, 'inbox');
    } catch (err) { e.target.disabled = false; showToast('Не удалось забрать: ' + err.message); }
  });
  mailBody.querySelector('.mail-reply')?.addEventListener('click', () => {
    if (m.senderId) openCompose(m.senderName);
    else showToast('Системному отправителю ответить нельзя');
  });
  mailBody.querySelector('.mail-del')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api.mailDelete(id);
      await refreshSelf();
      refreshMailUnread();
      renderMailBox('inbox');
    } catch (err) { e.target.disabled = false; showToast('Не удалось удалить: ' + err.message); }
  });
  mailBody.querySelector('.mail-del-sent')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api.mailDeleteSent(id);
      renderMailBox('sent');
    } catch (err) { e.target.disabled = false; showToast('Не удалось удалить: ' + err.message); }
  });
}

/** Экран написания письма: адресат, тема, текст, вложения, налог. */
async function openCompose(prefillTo = '') {
  $('mail-compose').style.display = 'none';
  mailTitle.textContent = 'Новое письмо';
  mailCompose = { to: prefillTo, attach: [] };
  mailBody.innerHTML = `
    <div class="mail-compose">
      <label class="mail-field"><span>Кому (ник)</span>
        <input id="mc-to" type="text" maxlength="24" autocomplete="off" value="${esc(prefillTo)}"></label>
      <label class="mail-field"><span>Тема</span>
        <input id="mc-subj" type="text" maxlength="80" autocomplete="off"></label>
      <label class="mail-field"><span>Сообщение</span>
        <textarea id="mc-body" maxlength="1000" rows="4"></textarea></label>
      <div class="mail-attach">
        <div class="mail-attach-head">
          <span>Вложения <span class="muted" id="mc-attn">0/${mailTariffs.maxAtt}</span></span>
          <button type="button" class="mail-btn sm" id="mc-add">+ Вещь</button>
        </div>
        <div id="mc-attach-list" class="mail-attach-list"></div>
      </div>
      <div class="mail-tax" id="mc-tax"></div>
      <div class="mail-error hidden" id="mc-error"></div>
      <div class="mail-read-actions">
        <button type="button" class="mail-btn mail-send" id="mc-send">Отправить</button>
        <button type="button" class="mail-btn" id="mc-cancel">Отмена</button>
      </div>
    </div>`;
  $('mc-cancel').addEventListener('click', () => renderMailBox(mailBox));
  $('mc-add').addEventListener('click', openAttachPicker);
  $('mc-send').addEventListener('click', sendComposed);
  renderComposeAttach();
}

function renderComposeAttach() {
  const box = $('mc-attach-list');
  if (!box) return;
  box.innerHTML = '';
  for (const a of mailCompose.attach) {
    const row = document.createElement('div');
    row.className = 'mail-attach-row';
    row.innerHTML = `
      <span class="mail-att-icon">${esc(a.icon || '📦')}</span>
      <span class="mail-att-name">${esc(a.name)}</span>
      ${a.stackable ? `<input class="mail-att-qty" type="number" min="1" max="${a.maxQty}" value="${a.qty}">` : ''}
      <span class="mail-att-tax">+${Math.ceil(a.price * a.qty * mailTariffs.itemPct)}</span>
      <button type="button" class="mail-att-del" title="Убрать">✕</button>`;
    if (a.stackable) {
      const qty = row.querySelector('.mail-att-qty');
      const taxEl = row.querySelector('.mail-att-tax');
      qty.addEventListener('input', () => {            // не перерисовываем строку — не теряем фокус
        a.qty = Math.max(1, Math.min(a.maxQty, Math.floor(+qty.value || 1)));
        taxEl.textContent = '+' + Math.ceil(a.price * a.qty * mailTariffs.itemPct);
        renderComposeTax();
      });
      qty.addEventListener('change', () => { qty.value = a.qty; });  // нормализуем по уходу
    }
    row.querySelector('.mail-att-del').addEventListener('click', () => {
      mailCompose.attach = mailCompose.attach.filter((x) => x !== a);
      renderComposeAttach();
    });
    box.appendChild(row);
  }
  const attn = $('mc-attn');
  if (attn) attn.textContent = `${mailCompose.attach.length}/${mailTariffs.maxAtt}`;
  renderComposeTax();
}

function renderComposeTax() {
  const el = $('mc-tax');
  if (!el) return;
  const itemsTax = mailCompose.attach.reduce(
    (s, a) => s + Math.ceil(a.price * a.qty * mailTariffs.itemPct), 0);
  const total = mailTariffs.taxSend + itemsTax;
  el.innerHTML = `Налог: <b>${mailTariffs.taxSend}</b> за письмо`
    + (itemsTax ? ` + <b>${itemsTax}</b> за вложения` : '')
    + ` = <b>${total}</b> меди`;
}

/** Выбор вещи для вложения из рюкзака (только торгуемые, не надетые). */
async function openAttachPicker() {
  // убрать клавиатуру: иначе пикерное окно центрируется под ней и не тапается (#5)
  document.activeElement?.blur();
  if (mailCompose.attach.length >= mailTariffs.maxAtt) {
    showToast(`Не больше ${mailTariffs.maxAtt} вложений`); return;
  }
  let inv;
  try { inv = await api.inventory(); }
  catch (e) { showToast('Не удалось загрузить рюкзак: ' + e.message); return; }
  const used = new Set(mailCompose.attach.map((a) => a.id));
  const items = inv.filter((it) => !it.equipped && it.tradable !== false && !used.has(it.id));
  const pop = document.createElement('div');
  pop.className = 'attach-picker';
  pop.innerHTML = `<div class="attach-picker-card">
    <div class="attach-picker-head">Выберите вещь
      <button type="button" class="attach-picker-close">✕</button></div>
    <div class="attach-picker-list"></div></div>`;
  const list = pop.querySelector('.attach-picker-list');
  if (!items.length) {
    list.innerHTML = '<div class="bi-empty">Нет вещей для отправки.</div>';
  } else for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'attach-pick-row';
    const tax = Math.ceil((it.price || 0) * mailTariffs.itemPct);
    b.innerHTML = `<span class="mail-att-icon">${esc(itemIconText(it.icon, it.type, it.stats))}</span>
      <span class="mail-att-name">${esc(it.name)}${it.quantity > 1 ? ` ×${it.quantity}` : ''}</span>
      <span class="attach-pick-price">${it.price || 0} · налог ${tax}/шт</span>`;
    b.addEventListener('click', () => {
      const stackable = it.quantity > 1;
      mailCompose.attach.push({ id: it.id, name: it.name,
        icon: itemIconText(it.icon, it.type, it.stats),
        price: it.price || 0, qty: 1, maxQty: it.quantity, stackable });
      pop.remove();
      renderComposeAttach();
    });
    list.appendChild(b);
  }
  pop.querySelector('.attach-picker-close').addEventListener('click', () => pop.remove());
  pop.addEventListener('click', (e) => { if (e.target === pop) pop.remove(); });
  document.body.appendChild(pop);
}

function mailError(text) {       // тосты в фуллскрине Telegram прячутся за шапкой —
  const el = $('mc-error');      // показываем ошибку прямо в форме
  if (!el) { showToast(text); return; }
  el.textContent = text;
  el.classList.remove('hidden');
}

async function sendComposed() {
  document.activeElement?.blur();           // убрать клавиатуру, чтобы видеть результат
  const to = $('mc-to').value.trim();
  const subject = $('mc-subj').value.trim();
  const body = $('mc-body').value.trim();
  $('mc-error').classList.add('hidden');
  if (!to) { mailError('Укажите получателя'); return; }
  if (!body && !mailCompose.attach.length) { mailError('Письмо пустое — добавьте текст или вещь'); return; }
  const btn = $('mc-send');
  btn.disabled = true;
  const items = mailCompose.attach.map((a) => ({ id: a.id, qty: a.qty }));
  try {
    const r = await api.mailSend({ to, subject, body, items });
    await refreshSelf();
    // чек об оплате — в общий чат
    chatSystem(`Письмо игроку «${r.recipientName}» отправлено. Списано ${r.tax} меди.`);
    showToast(`Письмо отправлено · налог ${r.tax} меди`);
    renderMailBox('sent');
  } catch (e) {
    btn.disabled = false;
    mailError(MAIL_ERRORS[e.message] || ('Не удалось отправить: ' + e.message));
  }
}

const MAIL_ERRORS = {
  recipient_not_found: 'Игрок с таким ником не найден',
  cannot_mail_self: 'Нельзя писать самому себе',
  insufficient_funds: 'Не хватает меди на налог',
  too_many_attachments: 'Слишком много вложений',
  item_not_tradable: 'Эту вещь нельзя отправить',
  recipient_required: 'Укажите получателя',
};

/** Обновить себя после операций с деньгами/вещами (кошелёк + рюкзак). */
async function refreshSelf() {
  if (!online) return;
  try {
    applyCharacter(await api.me());
    registerServerItems(await api.inventory());
  } catch (e) { console.error('Обновление состояния:', e); }
}

/** Применить кошелёк из ответа сервера сразу (без полного refreshSelf). */
function applyWallet(w) {
  if (!w) return;
  PLAYER.wallet = { copper: 0, silver: 0, gold: 0, diamond: 0, ...w };
  delete PLAYER.wallet.valor;
  renderMoney();
}

// ===========================================================================
// Аукцион и биржа (модуль #auction). Сервер — единственный источник правды по
// ценам, налогам и переходам вещей/денег (все операции транзакционны на бэке).
// ===========================================================================
const auctionEl = $('auction');
const aucBody = $('auction-body');
const QUALITY_NAME = { 1: 'Обычный', 2: 'Необычный', 3: 'Редкий', 4: 'Эпический', 5: 'Легендарный' };
const MARKET_CURRENCIES = [
  { id: 1, code: 'copper', label: 'Медь', gen: 'меди', icon: '<span class="coin coin-copper auc-coin"></span>' },
  { id: 2, code: 'silver', label: 'Серебро', gen: 'серебра', icon: '<span class="coin coin-silver auc-coin"></span>' },
  { id: 3, code: 'gold', label: 'Золото', gen: 'золота', icon: '<span class="coin coin-gold auc-coin"></span>' },
  { id: 4, code: 'diamond', label: 'Бриллианты', gen: 'бриллиантов', icon: '<span class="gem auc-coin"></span>' },
];
const MARKET_MONEY_BASE = 1000;
const MARKET_CURRENCY_BY_ID = Object.fromEntries(MARKET_CURRENCIES.map((c) => [c.id, c]));
const MARKET_CURRENCY_BY_CODE = Object.fromEntries(MARKET_CURRENCIES.map((c) => [c.code, c]));
const MARKET_CATEGORY_OPTIONS = [
  ['', 'Все категории'], [1, 'Оружие'], [2, 'Броня'], [3, 'Ресурсы'],
  [4, 'Эликсиры'], [5, 'Артефакты'], [6, 'Скальпы'], [7, 'Подарки'],
];

let aucTab = 'auction';     // 'auction' | 'exchange'
let aucView = 'browse';     // 'browse' | 'mylots' | 'mybids' | 'new'
let aucSearch = '';
let aucFilters = { category: '', quality: '', levelMin: '', levelMax: '' };
let aucTariffs = { listingPct: 0.05, salePct: 0.15, maxLots: 3, minIncPct: 0.05,
  featuredFee: 500, antiSnipeMin: 5, durations: [2, 6, 12, 24, 48] };
let aucActiveLots = 0, aucMaxLots = 3, aucMyBids = 0;
let aucNew = { item: null, qty: 1 };
let aucInvItems = [];

const AUC_ERRORS = {
  item_required: 'Выберите вещь для продажи', bad_start_price: 'Некорректная стартовая цена',
  buyout_below_start: 'Выкуп не может быть ниже старта', bad_duration: 'Выберите длительность',
  lot_limit_reached: 'Достигнут лимит активных лотов', item_not_tradable: 'Эту вещь нельзя продать',
  item_bound: 'Вещь привязана — продать нельзя', not_enough_quantity: 'Недостаточно количества',
  insufficient_funds: 'Не хватает денег', item_not_found: 'Вещь не найдена',
  lot_not_found: 'Лот не найден', lot_closed: 'Лот уже закрыт', lot_ended: 'Торги завершены',
  cannot_bid_own: 'Нельзя ставить на свой лот', already_high_bidder: 'Вы уже лидер ставок',
  bid_too_low: 'Ставка слишком мала', use_buyout: 'Достигнут выкуп — нажмите «Купить»',
  cannot_buy_own: 'Нельзя выкупить свой лот', no_buyout: 'У лота нет цены выкупа',
  has_bids: 'По лоту есть ставки — снять нельзя', not_owner: 'Это не ваш лот',
  price_too_high: 'Слишком большая цена', conflict: 'Лот изменился — обновите список',
  bad_currency: 'Выберите валюту',
  // биржа (доска заявок на покупку)
  bad_price: 'Некорректная цена', bad_quantity: 'Некорректное количество',
  instrument_inactive: 'Товар недоступен', instrument_not_found: 'Товар не найден',
  bad_tick: 'Цена не кратна шагу', bad_lot: 'Количество не кратно лоту',
  not_enough_items: 'Недостаточно товара в рюкзаке', order_not_found: 'Заявка не найдена',
  order_closed: 'Заявка уже закрыта', order_expired: 'Срок заявки истёк',
  order_limit_reached: 'Достигнут лимит заявок', cannot_sell_own: 'Нельзя продавать в свою заявку',
  order_filled: 'Заявка уже исполнена', not_a_buy_order: 'Это не заявка на покупку',
};
const aucErr = (e) => AUC_ERRORS[e?.message] || ('Ошибка: ' + (e?.message || ''));
const aucFmt = (n) => (Number(n) || 0).toLocaleString('ru-RU');
function marketCurrency(cur) {
  if (cur && typeof cur === 'object') return cur;
  return MARKET_CURRENCY_BY_CODE[cur] || MARKET_CURRENCY_BY_ID[Number(cur)] || MARKET_CURRENCY_BY_CODE.copper;
}
function splitMarketMoney(total) {
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  return {
    gold: Math.floor(n / (MARKET_MONEY_BASE * MARKET_MONEY_BASE)),
    silver: Math.floor(n / MARKET_MONEY_BASE) % MARKET_MONEY_BASE,
    copper: n % MARKET_MONEY_BASE,
  };
}
function priceModeFor(cur) {
  return marketCurrency(cur).code === 'diamond' || cur === 'diamond' ? 'diamond' : 'money';
}
function priceHtml(n, cur = 'money') {
  if (priceModeFor(cur) === 'diamond') return `${aucFmt(n)}${marketCurrency('diamond').icon}`;
  const p = splitMarketMoney(n);
  const parts = [];
  if (p.gold) parts.push(`${aucFmt(p.gold)}${marketCurrency('gold').icon}`);
  if (p.silver) parts.push(`${aucFmt(p.silver)}${marketCurrency('silver').icon}`);
  if (p.copper || !parts.length) parts.push(`${aucFmt(p.copper)}${marketCurrency('copper').icon}`);
  return parts.join(' ');
}
const coinsHtml = priceHtml;
function moneyText(n, cur = 'money') {
  if (priceModeFor(cur) === 'diamond') return `${aucFmt(n)} бриллиантов`;
  const p = splitMarketMoney(n);
  const parts = [];
  if (p.gold) parts.push(`${aucFmt(p.gold)} золота`);
  if (p.silver) parts.push(`${aucFmt(p.silver)} серебра`);
  if (p.copper || !parts.length) parts.push(`${aucFmt(p.copper)} меди`);
  return parts.join(' ');
}
function currencyOptionsHtml(selected = 'copper') {
  const cur = marketCurrency(selected);
  return MARKET_CURRENCIES.map((c) =>
    `<option value="${c.id}" ${c.id === cur.id ? 'selected' : ''}>${c.label}</option>`).join('');
}
// Ценности во вложении письма. money — медь-тотал (раскладывается на золото/
// серебро/медь, без «переполнения» в одну гигантскую медь), diamond — отдельно.
function mailValueChips(money, diamond) {
  const out = [];
  if (Number(money) > 0) out.push(`<span class="mail-clip" title="Деньги">${priceHtml(money)}</span>`);
  if (Number(diamond) > 0) out.push(`<span class="mail-clip" title="Бриллианты">${aucFmt(diamond)}${marketCurrency('diamond').icon}</span>`);
  return out.join('');
}
function mailValueRows(money, diamond) {
  let h = '';
  if (Number(money) > 0) h += `<div class="mail-att"><span class="mail-att-icon">🪙</span><span class="mail-att-name">${moneyText(money)}</span></div>`;
  if (Number(diamond) > 0) h += `<div class="mail-att"><span class="mail-att-icon">💎</span><span class="mail-att-name">${aucFmt(diamond)} бриллиантов</span></div>`;
  return h;
}
function mailValueText(money, diamond) {
  const out = [];
  if (Number(money) > 0) out.push(moneyText(money));
  if (Number(diamond) > 0) out.push(`${aucFmt(diamond)} бриллиантов`);
  return out.join(', ');
}
function priceFieldsHtml(prefix, price = 0, cur = 'money', opts = {}) {
  const mode = priceModeFor(cur);
  const p = mode === 'diamond' ? { gold: 0, silver: 0, copper: 0, diamond: Math.max(0, Math.trunc(Number(price) || 0)) }
    : { ...splitMarketMoney(price), diamond: 0 };
  const small = opts.small ? ' small' : '';
  const optional = opts.optional ? ' optional' : '';
  const locked = opts.lockMode ? ' locked' : '';
  return `<div class="auc-price-editor ${mode}${small}${optional}${locked}" data-price-editor="${prefix}">
    <label class="auc-price-mode"><span>Валюта</span><select id="${prefix}-mode">
      <option value="money" ${mode === 'money' ? 'selected' : ''}>Золото / серебро / медь</option>
      <option value="diamond" ${mode === 'diamond' ? 'selected' : ''}>Бриллианты</option>
    </select></label>
    <div class="auc-money-fields">
      <label><span>Золото</span><input id="${prefix}-gold" type="number" min="0" inputmode="numeric" value="${p.gold}"></label>
      <label><span>Серебро</span><input id="${prefix}-silver" type="number" min="0" max="999" inputmode="numeric" value="${p.silver}"></label>
      <label><span>Медь</span><input id="${prefix}-copper" type="number" min="0" max="999" inputmode="numeric" value="${p.copper}"></label>
    </div>
    <label class="auc-diamond-field"><span>Бриллианты</span><input id="${prefix}-diamond" type="number" min="0" inputmode="numeric" value="${p.diamond}"></label>
  </div>`;
}
function bindPriceEditor(prefix, onChange = null) {
  const root = document.querySelector(`[data-price-editor="${prefix}"]`);
  if (!root) return;
  const modeEl = $(`${prefix}-mode`);
  const sync = () => {
    const mode = modeEl?.value === 'diamond' ? 'diamond' : 'money';
    root.classList.toggle('diamond', mode === 'diamond');
    root.classList.toggle('money', mode === 'money');
    if (onChange) onChange();
  };
  modeEl?.addEventListener('change', sync);
  ['silver', 'copper'].forEach((k) => $(`${prefix}-${k}`)?.addEventListener('input', (e) => {
    const v = Math.max(0, Math.min(999, Math.trunc(+e.target.value || 0)));
    if (String(v) !== e.target.value) e.target.value = v;
    if (onChange) onChange();
  }));
  ['gold', 'diamond'].forEach((k) => $(`${prefix}-${k}`)?.addEventListener('input', () => { if (onChange) onChange(); }));
  sync();
}
function setPriceEditorMode(prefix, mode) {
  const el = $(`${prefix}-mode`);
  if (!el) return;
  el.value = mode === 'diamond' ? 'diamond' : 'money';
  el.dispatchEvent(new Event('change'));
}
function readPriceEditor(prefix) {
  const mode = $(`${prefix}-mode`)?.value === 'diamond' ? 'diamond' : 'money';
  if (mode === 'diamond') return {
    priceMode: 'diamond',
    diamond: Math.max(0, Math.trunc(+$(`${prefix}-diamond`)?.value || 0)),
  };
  return {
    priceMode: 'money',
    money: {
      gold: Math.max(0, Math.trunc(+$(`${prefix}-gold`)?.value || 0)),
      silver: Math.max(0, Math.min(999, Math.trunc(+$(`${prefix}-silver`)?.value || 0))),
      copper: Math.max(0, Math.min(999, Math.trunc(+$(`${prefix}-copper`)?.value || 0))),
    },
  };
}
function priceEditorValue(prefix) {
  const p = readPriceEditor(prefix);
  if (p.priceMode === 'diamond') return { price: p.diamond, currency: 'diamond' };
  const m = p.money;
  return { price: (m.gold * MARKET_MONEY_BASE * MARKET_MONEY_BASE) + (m.silver * MARKET_MONEY_BASE) + m.copper,
    currency: 'money' };
}
function filterOptionsHtml(options, selected) {
  return options.map(([value, label]) =>
    `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`).join('');
}
function marketFilterHtml(prefix, filters) {
  const qualityOptions = [['', 'Все цвета'], ...Object.entries(QUALITY_NAME)];
  return `<div class="auc-filters">
    <label class="auc-filter-field"><span>Категория</span><select id="${prefix}-cat">${filterOptionsHtml(MARKET_CATEGORY_OPTIONS, filters.category)}</select></label>
    <label class="auc-filter-field"><span>Цвет</span><select id="${prefix}-quality">${filterOptionsHtml(qualityOptions, filters.quality)}</select></label>
    <label class="auc-filter-field lvl"><span>Ур. от</span><input id="${prefix}-lvl-min" type="number" min="1" inputmode="numeric" value="${esc(filters.levelMin)}"></label>
    <label class="auc-filter-field lvl"><span>до</span><input id="${prefix}-lvl-max" type="number" min="1" inputmode="numeric" value="${esc(filters.levelMax)}"></label>
  </div>`;
}
function readMarketFilters(prefix, filters) {
  filters.category = $(`${prefix}-cat`)?.value || '';
  filters.quality = $(`${prefix}-quality`)?.value || '';
  filters.levelMin = ($(`${prefix}-lvl-min`)?.value || '').trim();
  filters.levelMax = ($(`${prefix}-lvl-max`)?.value || '').trim();
}
function clearMarketFilters(filters) {
  filters.category = ''; filters.quality = ''; filters.levelMin = ''; filters.levelMax = '';
}
function marketFilterPayload(search, filters) {
  return { q: search, cat: filters.category, quality: filters.quality,
    levelMin: filters.levelMin, levelMax: filters.levelMax };
}
function marketCategoryName(type) {
  const hit = MARKET_CATEGORY_OPTIONS.find(([id]) => Number(id) === Number(type));
  return hit ? hit[1] : 'Предмет';
}
function marketItemPreviewHtml(it, opts = {}) {
  if (!it) return '';
  const q = it.quality || 1;
  // характеристики (сила/ловкость/эффект эликсира) показываем ТОЛЬКО в превью-окне;
  // на карточках/строках/выбранном предмете их не рисуем (opts.stats === false)
  const desc = opts.stats === false ? '' : (Number(it.type) === 4
    ? elixirEffectText(elixirKindFromStats(it.stats), it.stats)
    : gearStatsText(it.stats));
  return `<div class="auc-item-preview${qClass(true, q)}">
    <div class="auc-preview-ico${qClass(true, q)}">${esc(itemIconText(it.icon, it.type, it.stats, it.slot))}</div>
    <div class="auc-preview-info">
      <div class="auc-preview-name${qClass(true, q)}">${esc(it.name)}</div>
      <div class="auc-preview-meta">
        <span>${esc(QUALITY_NAME[q] || 'Обычный')}</span>
        <span>${esc(marketCategoryName(it.type))}</span>
        <span>ур. ${aucFmt(it.level || it.levelReq || 1)}</span>
      </div>
      ${desc ? `<div class="auc-preview-desc">${esc(desc)}</div>` : ''}
    </div>
  </div>`;
}

// Превью предмета — отдельное небольшое окно поверх (а не разворот внизу карточки).
// Полные характеристики (сила/ловкость/эффект) показываем ТОЛЬКО здесь.
let marketPopEl = null;
function closeMarketPreview() {
  if (marketPopEl) { marketPopEl.remove(); marketPopEl = null; }
  document.removeEventListener('keydown', onMarketPopKey);
}
function onMarketPopKey(e) { if (e.key === 'Escape') closeMarketPreview(); }
function openMarketPreview(item) {
  closeMarketPreview();
  if (!item) return;
  const pop = document.createElement('div');
  pop.className = 'market-pop-overlay';
  pop.innerHTML = `<div class="market-pop" role="dialog" aria-label="Предмет">
    <button type="button" class="market-pop-close" aria-label="Закрыть">✕</button>
    ${marketItemPreviewHtml(item)}
  </div>`;
  document.body.appendChild(pop);
  marketPopEl = pop;
  pop.addEventListener('click', (e) => { if (e.target === pop) closeMarketPreview(); });
  pop.querySelector('.market-pop-close').addEventListener('click', closeMarketPreview);
  document.addEventListener('keydown', onMarketPopKey);
}

function aucTimeLeft(endsAt) {
  const ms = endsAt - Date.now();
  if (ms <= 0) return 'Завершается…';
  const min = Math.floor(ms / 60000);
  if (min < 60) return 'Менее 1 часа';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' ч';
  return Math.floor(h / 24) + ' д ' + (h % 24) + ' ч';
}

function openAuction() {
  if (!online) { showToast('Аукцион доступен только онлайн'); return; }
  auctionEl.classList.remove('hidden');
  aucTab = 'auction'; aucView = 'browse';
  syncAucTabs();
  renderAuction();
}
function closeAuction() { auctionEl.classList.add('hidden'); }
function syncAucTabs() {
  auctionEl.querySelectorAll('.auc-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.aucTab === aucTab));
  const btn = $('auc-new');
  btn.style.display = '';
  btn.textContent = aucTab === 'exchange'
    ? (aucView === 'exch-new' ? '← К бирже' : '＋ Выставить заявку')
    : (aucView === 'new' ? '← К аукциону' : '＋ Новый лот');
}

$('auction-close').addEventListener('click', closeAuction);
auctionEl.addEventListener('click', (e) => { if (e.target === auctionEl) closeAuction(); });
auctionEl.querySelector('.auc-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.auc-tab'); if (!b) return;
  aucTab = b.dataset.aucTab; aucView = 'browse'; syncAucTabs(); renderAuction();
});
$('auc-new').addEventListener('click', () => {
  if (aucTab === 'exchange') aucView = aucView === 'exch-new' ? 'browse' : 'exch-new';
  else aucView = aucView === 'new' ? 'browse' : 'new';
  syncAucTabs();
  renderAuction();
});

function renderAuction() {
  if (aucTab === 'exchange') return aucView === 'exch-new' ? renderExchNew() : renderExchange();
  if (aucView === 'new') return renderNewLot();
  return renderAucBrowse();
}

// --- список лотов -----------------------------------------------------------
function aucToolbarHtml() {
  return `<div class="auc-toolbar">
    <div class="auc-searchbar">
      <input class="auc-search" id="auc-search" type="search" placeholder="Введите название предмета" value="${esc(aucSearch)}">
      <button type="button" class="auc-btn ghost" id="auc-search-btn">Искать</button>
      <button type="button" class="auc-btn ghost" id="auc-reset-btn">Сбросить</button>
    </div>
    ${marketFilterHtml('auc', aucFilters)}
    <div class="auc-views">
      <button type="button" data-auc-view="browse" class="${aucView === 'browse' ? 'active' : ''}">Все лоты</button>
      <button type="button" data-auc-view="mylots" class="${aucView === 'mylots' ? 'active' : ''}">Мои лоты <span id="auc-mylots-n">${aucActiveLots}/${aucMaxLots}</span></button>
      <button type="button" data-auc-view="mybids" class="${aucView === 'mybids' ? 'active' : ''}">Мои ставки <span id="auc-mybids-n">${aucMyBids}</span></button>
    </div>
  </div>`;
}
function bindAucToolbar() {
  const doSearch = () => {
    aucSearch = ($('auc-search').value || '').trim();
    readMarketFilters('auc', aucFilters);
    aucView = 'browse';
    renderAuction();
  };
  $('auc-search-btn').addEventListener('click', doSearch);
  $('auc-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('auc-reset-btn').addEventListener('click', () => { aucSearch = ''; clearMarketFilters(aucFilters); aucView = 'browse'; renderAuction(); });
  ['auc-cat', 'auc-quality', 'auc-lvl-min', 'auc-lvl-max'].forEach((id) => {
    const el = $(id); if (!el) return;
    const ev = el.tagName === 'SELECT' ? 'change' : 'keydown';
    el.addEventListener(ev, (e) => {
      if (ev === 'keydown' && e.key !== 'Enter') return;
      doSearch();
    });
  });
  aucBody.querySelectorAll('[data-auc-view]').forEach((b) =>
    b.addEventListener('click', () => { aucView = b.dataset.aucView; renderAuction(); }));
}

async function renderAucBrowse() {
  aucBody.innerHTML = aucToolbarHtml() + '<div class="auc-list"><div class="auc-empty">Загрузка…</div></div>';
  bindAucToolbar();
  let data;
  try {
    if (aucView === 'mylots') data = await api.auctionMyLots();
    else if (aucView === 'mybids') data = await api.auctionMyBids();
    else data = await api.auction(marketFilterPayload(aucSearch, aucFilters));
  } catch (e) {
    aucBody.querySelector('.auc-list').innerHTML = `<div class="auc-empty">Не удалось загрузить: ${esc(e.message)}</div>`;
    return;
  }
  if (data.tariffs) aucTariffs = { ...aucTariffs, ...data.tariffs };
  if (data.activeLotsMine != null) aucActiveLots = data.activeLotsMine;
  if (data.maxLots != null) aucMaxLots = data.maxLots;
  if (data.myBidsCount != null) aucMyBids = data.myBidsCount;
  if ($('auc-mylots-n')) $('auc-mylots-n').textContent = `${aucActiveLots}/${aucMaxLots}`;
  if ($('auc-mybids-n')) $('auc-mybids-n').textContent = String(aucMyBids);

  const list = aucBody.querySelector('.auc-list');
  const lots = data.lots || [];
  if (!lots.length) {
    const txt = aucView === 'mylots' ? 'У вас нет выставленных лотов.'
      : aucView === 'mybids' ? 'Вы не лидируете ни в одних торгах.'
      : 'Лотов не найдено.';
    list.innerHTML = `<div class="auc-empty">${txt}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const lot of lots) list.appendChild(aucLotCard(lot));
}

function aucLotCard(lot) {
  const q = lot.quality || 1;
  const card = document.createElement('div');
  card.className = 'auc-lot' + qClass(true, q) + (lot.featured ? ' featured' : '');
  const closed = lot.status !== 1;
  const statusLabel = { 2: 'Продан', 3: 'Выкуплен', 4: 'Истёк', 5: 'Снят' }[lot.status] || '';

  let actions = '';
  if (closed) {
    actions = `<div class="auc-lot-status">${statusLabel}</div>`;
  } else if (lot.isMine) {
    actions = `<div class="auc-lot-actions">
      <button type="button" class="auc-btn ghost auc-edit">Изменить</button>
      <button type="button" class="auc-btn danger auc-cancel">Снять</button></div>`;
  } else {
    const bidPrefix = `auc-bid-${lot.id}`;
    const bid = `<div class="auc-bid">
      ${priceFieldsHtml(bidPrefix, lot.minNextBid, lot.currency, { small: true, lockMode: true })}
      <button type="button" class="auc-btn auc-bidbtn">Повысить</button></div>`;
    const buy = lot.buyoutPrice != null
      ? `<button type="button" class="auc-btn buy auc-buyout">Купить</button>` : '';
    actions = `<div class="auc-lot-actions">${bid}${buy}</div>`;
  }

  card.innerHTML = `
    <button type="button" class="auc-lot-ico${qClass(true, q)}">${esc(itemIconText(lot.icon, lot.type, lot.stats, lot.slot))}</button>
    <div class="auc-lot-main">
      <div class="auc-lot-name">${esc(lot.name)}${lot.quantity > 1 ? `<span class="auc-lot-qty">×${lot.quantity}</span>` : ''}</div>
      <div class="auc-lot-sub">
        <span class="auc-chip">ур. ${lot.level}</span>
        <span class="auc-chip">${esc(lot.sellerName)}</span>
        <span class="auc-chip time">${aucTimeLeft(lot.endsAt)}</span>
        ${lot.bidCount ? `<span class="auc-chip">ставок: ${lot.bidCount}</span>` : ''}
      </div>
    </div>
    <div class="auc-lot-prices">
      <div class="auc-price-row"><span>Старт</span><b>${coinsHtml(lot.startPrice, lot.currency)}</b></div>
      ${lot.currentBid != null ? `<div class="auc-price-row bid"><span>Ставка</span><b>${coinsHtml(lot.currentBid, lot.currency)}</b></div>` : ''}
      ${lot.buyoutPrice != null ? `<div class="auc-price-row buyout"><span>Выкуп</span><b>${coinsHtml(lot.buyoutPrice, lot.currency)}</b></div>` : ''}
    </div>
    ${actions}`;

  bindPriceEditor(`auc-bid-${lot.id}`);
  card.querySelector('.auc-buyout')?.addEventListener('click', (ev) => aucDoBuyout(lot, ev.target));
  card.querySelector('.auc-bidbtn')?.addEventListener('click', (ev) => {
    aucDoBid(lot, readPriceEditor(`auc-bid-${lot.id}`), ev.target);
  });
  card.querySelector('.auc-lot-ico')?.addEventListener('click', () => openMarketPreview(lot));
  card.querySelector('.auc-cancel')?.addEventListener('click', (ev) => aucDoCancel(lot, ev.target));
  card.querySelector('.auc-edit')?.addEventListener('click', () => aucInlineEdit(lot, card));
  return card;
}

async function aucDoBid(lot, pricePayload, btn) {
  const value = pricePayload.priceMode === 'diamond'
    ? { price: pricePayload.diamond, currency: 'diamond' }
    : priceEditorValue(`auc-bid-${lot.id}`);
  if (!(value.price > 0)) { showToast('Введите сумму ставки'); return; }
  btn.disabled = true;
  try {
    const r = await api.auctionBid(lot.id, pricePayload);
    applyWallet(r.wallet); refreshSelf();
    showToast(`Ставка ${moneyText(value.price, value.currency)} принята`);
    renderAuction();
  } catch (e) { btn.disabled = false; showToast(aucErr(e)); }
}
async function aucDoBuyout(lot, btn) {
  btn.disabled = true;
  try {
    const r = await api.auctionBuyout(lot.id);
    applyWallet(r.wallet); refreshMailUnread();
    showToast(`Выкуплено: ${lot.name} · вещь придёт письмом`);
    renderAuction();
  } catch (e) { btn.disabled = false; showToast(aucErr(e)); }
}
async function aucDoCancel(lot, btn) {
  btn.disabled = true;
  try {
    await api.auctionCancel(lot.id);
    refreshMailUnread();
    showToast('Лот снят · вещь придёт письмом');
    renderAuction();
  } catch (e) { btn.disabled = false; showToast(aucErr(e)); }
}
function aucInlineEdit(lot, card) {
  const box = card.querySelector('.auc-lot-actions');
  const startPrefix = `ae-start-${lot.id}`;
  const buyoutPrefix = `ae-buyout-${lot.id}`;
  box.innerHTML = `<div class="auc-edit-form">
    <div class="auc-edit-price"><span>Старт</span>${priceFieldsHtml(startPrefix, lot.startPrice, lot.currency, { small: true })}</div>
    <div class="auc-edit-price"><span>Выкуп</span>${priceFieldsHtml(buyoutPrefix, lot.buyoutPrice || 0, lot.currency, { small: true, optional: true })}</div>
    <button type="button" class="auc-btn buy ae-save">Сохранить</button>
    <button type="button" class="auc-btn ghost ae-cancel">Отмена</button></div>`;
  bindPriceEditor(startPrefix, () => setPriceEditorMode(buyoutPrefix, $(`${startPrefix}-mode`)?.value));
  bindPriceEditor(buyoutPrefix);
  box.querySelector('.ae-cancel').addEventListener('click', () => renderAuction());
  box.querySelector('.ae-save').addEventListener('click', async (ev) => {
    const start = readPriceEditor(startPrefix);
    const buyout = readPriceEditor(buyoutPrefix);
    ev.target.disabled = true;
    try {
      await api.auctionEdit(lot.id, { priceMode: start.priceMode,
        startMoney: start.money, startDiamond: start.diamond,
        buyoutMoney: buyout.money, buyoutDiamond: buyout.diamond });
      showToast('Лот изменён'); renderAuction();
    } catch (e) { ev.target.disabled = false; showToast(aucErr(e)); }
  });
}

// --- создание лота ----------------------------------------------------------
function renderNewLot() {
  const durOpts = aucTariffs.durations.map((h) => {
    const label = h < 24 ? `${h} ч` : `${Math.floor(h / 24)} дн`;
    return `<option value="${h}">${label}</option>`;
  }).join('');
  aucBody.innerHTML = `
    <div class="auc-new">
      <div class="auc-new-form">
        <div class="auc-new-title">Новый лот продажи</div>
        <div class="auc-sel-preview" id="auc-sel-preview"></div>
        <div class="auc-field"><span>Стартовая цена</span>${priceFieldsHtml('anc-start', 0, 'money')}</div>
        <div class="auc-field"><span>Цена выкупа</span>${priceFieldsHtml('anc-buyout', 0, 'money', { optional: true })}</div>
        <div class="auc-field row"><span>Налог с продажи</span><b id="anc-saletax">—</b></div>
        <label class="auc-field"><span>Длительность торгов</span>
          <select id="anc-duration">${durOpts}</select></label>
        <div class="auc-field row"><span>Налог на выставление</span><b id="anc-listfee">—</b></div>
        <label class="auc-flag"><input type="checkbox" id="anc-extend"> Автопродление при поздней ставке</label>
        <label class="auc-flag"><input type="checkbox" id="anc-anon"> Выставить анонимно</label>
        <label class="auc-flag"><input type="checkbox" id="anc-featured"> Выделить лот (+${moneyText(aucTariffs.featuredFee, 'copper')})</label>
        <div class="auc-lots-left">Осталось лотов: <b id="anc-left">${aucMaxLots - aucActiveLots}/${aucMaxLots}</b></div>
        <div class="auc-error hidden" id="anc-error"></div>
        <div class="auc-new-actions">
          <button type="button" class="auc-btn danger" id="anc-cancel">Отмена</button>
          <button type="button" class="auc-btn buy" id="anc-submit">Выставить</button>
        </div>
      </div>
      <div class="auc-new-shop">
        <div class="auc-shop-head"><span>Рюкзак</span>
          <input class="auc-shop-search" id="anc-search" type="search" placeholder="Поиск…"></div>
        <div class="auc-shop-grid" id="anc-grid"><div class="auc-empty">Загрузка…</div></div>
      </div>
    </div>`;
  $('anc-cancel').addEventListener('click', () => { aucView = 'browse'; renderAuction(); });
  $('anc-submit').addEventListener('click', aucSubmitNew);
  bindPriceEditor('anc-start', () => {
    setPriceEditorMode('anc-buyout', $('anc-start-mode')?.value);
    aucRecalcFees();
  });
  bindPriceEditor('anc-buyout', aucRecalcFees);
  $('anc-featured').addEventListener('change', aucRecalcFees);
  $('anc-search').addEventListener('input', () => aucRenderInvGrid());
  aucRenderSelPreview();
  aucRecalcFees();
  aucLoadInvGrid();
}

async function aucLoadInvGrid() {
  try { aucInvItems = (await api.inventory()).filter((it) => !it.equipped && it.tradable !== false); }
  catch (e) { $('anc-grid').innerHTML = '<div class="auc-empty">Не удалось загрузить рюкзак</div>'; return; }
  aucRenderInvGrid();
}
function aucRenderInvGrid() {
  const grid = $('anc-grid'); if (!grid) return;
  const term = ($('anc-search')?.value || '').trim().toLowerCase();
  const items = term ? aucInvItems.filter((it) => (it.name || '').toLowerCase().includes(term)) : aucInvItems;
  if (!items.length) { grid.innerHTML = '<div class="auc-empty">Нет вещей для продажи</div>'; return; }
  grid.innerHTML = '';
  for (const it of items) {
    const q = it.quality || 1;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'auc-shop-cell' + qClass(true, q) + (aucNew.item && aucNew.item.id === it.id ? ' sel' : '');
    cell.innerHTML = `<span class="auc-cell-ico">${esc(itemIconText(it.icon, it.type, it.stats, it.slot))}</span>` +
      (it.quantity > 1 ? `<span class="auc-cell-qty">${it.quantity}</span>` : '');
    cell.addEventListener('click', () => {
      aucNew = { item: it, qty: 1 };
      grid.querySelectorAll('.auc-shop-cell').forEach((c) => c.classList.remove('sel'));
      cell.classList.add('sel');
      aucRenderSelPreview(); aucRecalcFees();
    });
    grid.appendChild(cell);
  }
}
function aucRenderSelPreview() {
  const host = $('auc-sel-preview'); if (!host) return;
  const it = aucNew.item;
  if (!it) { host.innerHTML = '<div class="auc-sel-hint">Выберите вещь из рюкзака справа →</div>'; return; }
  const q = it.quality || 1;
  const stackable = it.quantity > 1;
  host.innerHTML = `
    <div class="auc-sel-ico clickable${qClass(true, q)}" title="Подробнее">${esc(itemIconText(it.icon, it.type, it.stats, it.slot))}</div>
    <div class="auc-sel-info">
      <div class="auc-sel-name${qClass(true, q)}">${esc(it.name)}</div>
      <div class="auc-sel-meta">${QUALITY_NAME[q] || ''}</div>
      ${stackable ? `<label class="auc-sel-qty">Кол-во: <input id="anc-qty" type="number" min="1" max="${it.quantity}" value="${aucNew.qty}"></label>` : ''}
    </div>`;
  host.querySelector('.auc-sel-ico')?.addEventListener('click', () => openMarketPreview(it));
  if (stackable) {
    $('anc-qty').addEventListener('input', () => {
      aucNew.qty = Math.max(1, Math.min(it.quantity, Math.trunc(+$('anc-qty').value || 1)));
    });
  }
}
function aucRecalcFees() {
  if (!$('anc-listfee')) return;
  const startVal = priceEditorValue('anc-start');
  const buyoutVal = priceEditorValue('anc-buyout');
  const start = startVal.price;
  const buyout = buyoutVal.price > 0 ? buyoutVal.price : null;
  const t = aucTariffs;
  const listFee = (start > 0 ? Math.max(1, Math.ceil(start * t.listingPct)) : 0)
    + ($('anc-featured').checked ? (t.featuredFee || 0) : 0);
  const saleTax = Math.ceil((buyout != null ? buyout : start) * t.salePct);
  $('anc-listfee').innerHTML = coinsHtml(listFee, 'copper');
  $('anc-saletax').innerHTML = coinsHtml(saleTax, startVal.currency);
}
async function aucSubmitNew() {
  const errEl = $('anc-error');
  errEl.classList.add('hidden');
  if (!aucNew.item) { errEl.textContent = 'Выберите вещь'; errEl.classList.remove('hidden'); return; }
  const start = readPriceEditor('anc-start');
  const buyout = readPriceEditor('anc-buyout');
  const payload = {
    itemId: aucNew.item.id, qty: aucNew.qty,
    priceMode: start.priceMode, startMoney: start.money, startDiamond: start.diamond,
    buyoutMoney: buyout.money, buyoutDiamond: buyout.diamond,
    durationHours: Math.trunc(+$('anc-duration').value || 0),
    anonymous: $('anc-anon').checked, featured: $('anc-featured').checked,
    autoExtend: $('anc-extend').checked,
  };
  const btn = $('anc-submit'); btn.disabled = true;
  try {
    const r = await api.auctionCreate(payload);
    applyWallet(r.wallet); await refreshSelf();
    showToast(`Лот выставлен · сбор ${moneyText(r.fee, 'copper')}`);
    aucNew = { item: null, qty: 1 }; aucView = 'mylots'; renderAuction();
  } catch (e) {
    btn.disabled = false; errEl.textContent = aucErr(e); errEl.classList.remove('hidden');
  }
}

// --- биржа: доска ЗАЯВОК НА ПОКУПКУ -----------------------------------------
// Игрок выставляет «хочу купить N по P», другие продают в заявку. Товар приходит
// покупателю письмом при закрытии заявки; возвраты приходят письмом, выручка зачисляется в кошелёк.
let exchSel = null;
let exchInstruments = [];
let exchSearch = '';
let exchFilters = { category: '', quality: '', levelMin: '', levelMax: '' };
let exchPickSearch = '';
let exchPickFilters = { category: '', quality: '', levelMin: '', levelMax: '' };
let exchPickOptions = [];
let exchPickSel = null;
let exchPickItem = null;
let exchSuggestTimer = null;

function exchPickHasCriteria() {
  return !!(exchPickSearch || exchPickFilters.category || exchPickFilters.quality
    || exchPickFilters.levelMin || exchPickFilters.levelMax);
}

function clearExchPickDetail() {
  const detail = $('exch-detail');
  if (detail) detail.innerHTML = '<div class="auc-empty">Выберите товар для заявки</div>';
}

async function renderExchNew() {
  aucBody.innerHTML = `<div class="exch-create">
    <div class="exch-picker">
      <div class="auc-new-title">Новая заявка на покупку</div>
      <label class="auc-field exch-suggest-wrap"><span>Товар</span>
        <input class="auc-search" id="exch-pick-search" type="search" placeholder="Начните вводить название" value="${esc(exchPickSearch)}" autocomplete="off">
        <div class="exch-suggest" id="exch-suggest"></div>
      </label>
      ${marketFilterHtml('exch-pick', exchPickFilters)}
      <button type="button" class="auc-btn ghost" id="exch-pick-reset">Сбросить</button>
      <div class="exch-pick-selected" id="exch-pick-selected"><div class="auc-empty">Выберите товар из списка</div></div>
    </div>
    <div class="exch-detail" id="exch-detail"><div class="auc-empty">Выберите товар для заявки</div></div>
  </div>`;
  bindExchPickTools();
  renderExchPickOptions();
  renderExchPickSelected(exchPickItem);
  if (exchPickSel != null) loadExchBoard(exchPickSel, { showForm: true, showOrders: false });
  if (exchPickHasCriteria()) loadExchPickOptions();
}

function bindExchPickTools() {
  const input = $('exch-pick-search');
  const schedule = () => {
    clearTimeout(exchSuggestTimer);
    exchSuggestTimer = setTimeout(loadExchPickOptions, 180);
  };
  input.addEventListener('input', () => {
    exchPickSearch = input.value.trim();
    exchPickSel = null;
    exchPickItem = null;
    renderExchPickSelected(null);
    clearExchPickDetail();
    schedule();
  });
  input.addEventListener('focus', () => { if (exchPickHasCriteria()) loadExchPickOptions(); });
  $('exch-pick-reset').addEventListener('click', () => {
    exchPickSearch = ''; clearMarketFilters(exchPickFilters); exchPickSel = null; exchPickItem = null; exchPickOptions = [];
    renderExchNew();
  });
  ['exch-pick-cat', 'exch-pick-quality', 'exch-pick-lvl-min', 'exch-pick-lvl-max'].forEach((id) => {
    const el = $(id); if (!el) return;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      readMarketFilters('exch-pick', exchPickFilters);
      exchPickSel = null;
      exchPickItem = null;
      renderExchPickSelected(null);
      clearExchPickDetail();
      schedule();
    });
  });
}

async function loadExchPickOptions() {
  readMarketFilters('exch-pick', exchPickFilters);
  if (!exchPickHasCriteria()) { exchPickOptions = []; renderExchPickOptions(); return; }
  const box = $('exch-suggest');
  if (box) box.innerHTML = '<div class="exch-suggest-empty">Поиск…</div>';
  try {
    const data = await api.exchange(marketFilterPayload(exchPickSearch, exchPickFilters));
    exchPickOptions = (data.instruments || []).slice(0, 24);
  } catch {
    exchPickOptions = [];
  }
  renderExchPickOptions();
}

function renderExchPickOptions() {
  const box = $('exch-suggest'); if (!box) return;
  if (!exchPickHasCriteria()) {
    box.innerHTML = '<div class="exch-suggest-empty">Введите название или выберите фильтр</div>';
    return;
  }
  if (!exchPickOptions.length) {
    box.innerHTML = '<div class="exch-suggest-empty">Нет вариантов</div>';
    return;
  }
  box.innerHTML = '';
  for (const ins of exchPickOptions) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'exch-suggest-row';
    row.innerHTML = `
      <span class="exch-i-ico${qClass(true, ins.quality)}">${esc(itemIconText(ins.icon, ins.type, ins.stats, ins.slot))}</span>
      <span class="exch-suggest-name">${esc(ins.name)}</span>
      <span class="exch-i-meta">ур. ${aucFmt(ins.level || 1)}</span>`;
    row.addEventListener('click', () => {
      exchPickSel = ins.instrumentId;
      exchPickItem = ins;
      exchPickSearch = ins.name;
      $('exch-pick-search').value = ins.name;
      exchPickOptions = [ins];
      renderExchPickSelected(ins);
      box.innerHTML = '';
      loadExchBoard(ins.instrumentId, { showForm: true, showOrders: false });
    });
    box.appendChild(row);
  }
}

function renderExchPickSelected(ins) {
  const host = $('exch-pick-selected'); if (!host) return;
  if (!ins) { host.innerHTML = '<div class="auc-empty">Выберите товар из списка</div>'; return; }
  host.innerHTML = marketItemPreviewHtml(ins, { stats: false });
  const card = host.querySelector('.auc-item-preview');
  if (card) {
    card.classList.add('clickable');
    card.title = 'Подробнее';
    card.addEventListener('click', () => openMarketPreview(ins));
  }
}

async function renderExchange() {
  aucBody.innerHTML = `<div class="exch">
    <div class="exch-side">
      <div class="exch-side-head">Товары</div>
      <div class="exch-tools">
        <div class="auc-searchbar">
          <input class="auc-search" id="exch-search" type="search" placeholder="Название товара" value="${esc(exchSearch)}">
          <button type="button" class="auc-btn ghost" id="exch-search-btn">Искать</button>
        </div>
        ${marketFilterHtml('exch', exchFilters)}
        <button type="button" class="auc-btn ghost" id="exch-reset-btn">Сбросить</button>
      </div>
      <div class="exch-list" id="exch-list"><div class="auc-empty">Загрузка…</div></div>
    </div>
    <div class="exch-detail" id="exch-detail"><div class="auc-empty">Выберите товар слева</div></div>
  </div>`;
  bindExchTools();
  let data;
  try { data = await api.exchange(marketFilterPayload(exchSearch, exchFilters)); }
  catch (e) { $('exch-list').innerHTML = `<div class="auc-empty">Ошибка: ${esc(e.message)}</div>`; return; }
  exchInstruments = (data.instruments || []).filter((i) => Number(i.openOrders) > 0);
  if (!exchInstruments.some((i) => i.instrumentId === exchSel)) exchSel = exchInstruments[0]?.instrumentId ?? null;
  renderExchList();
  if (exchSel != null) loadExchBoard(exchSel, { showForm: false, showOrders: true });
  else $('exch-detail').innerHTML = '<div class="auc-empty">Нет активных заявок</div>';
}
function bindExchTools() {
  const doSearch = () => {
    exchSearch = ($('exch-search').value || '').trim();
    readMarketFilters('exch', exchFilters);
    exchSel = null;
    renderExchange();
  };
  $('exch-search-btn').addEventListener('click', doSearch);
  $('exch-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('exch-reset-btn').addEventListener('click', () => {
    exchSearch = ''; clearMarketFilters(exchFilters); exchSel = null; renderExchange();
  });
  ['exch-cat', 'exch-quality', 'exch-lvl-min', 'exch-lvl-max'].forEach((id) => {
    const el = $(id); if (!el) return;
    const ev = el.tagName === 'SELECT' ? 'change' : 'keydown';
    el.addEventListener(ev, (e) => {
      if (ev === 'keydown' && e.key !== 'Enter') return;
      doSearch();
    });
  });
}
function renderExchList() {
  const list = $('exch-list'); if (!list) return;
  if (!exchInstruments.length) { list.innerHTML = '<div class="auc-empty">Нет товаров</div>'; return; }
  list.innerHTML = '';
  for (const ins of exchInstruments) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'exch-irow' + (ins.instrumentId === exchSel ? ' sel' : '');
    const best = exchBestBidHtml(ins.bestBids);
    const meta = `${ins.openOrders} заявок${best ? ' · ' + best : ''}`;
    row.innerHTML = `
      <span class="exch-i-ico${qClass(true, ins.quality)}">${esc(itemIconText(ins.icon, ins.type, ins.stats, ins.slot))}</span>
      <span class="exch-i-name">${esc(ins.name)}</span>
      <span class="exch-i-meta">${meta}</span>`;
    row.addEventListener('click', () => {
      exchSel = ins.instrumentId;
      renderExchList();
      loadExchBoard(ins.instrumentId, { showForm: false, showOrders: true });
    });
    list.appendChild(row);
  }
}
function exchBestBidHtml(bestBids) {
  const entries = Object.entries(bestBids || {}).filter(([, v]) => v != null);
  if (!entries.length) return '';
  if (entries.length > 1) return 'несколько валют';
  const [currencyId, price] = entries[0];
  return 'до ' + coinsHtml(price, Number(currencyId));
}
async function loadExchBoard(instrumentId, opts = {}) {
  const host = $('exch-detail'); if (!host) return;
  host.innerHTML = '<div class="auc-empty">Загрузка заявок…</div>';
  let d;
  try { d = await api.exchangeBoard(instrumentId); }
  catch (e) { host.innerHTML = `<div class="auc-empty">Ошибка: ${esc(e.message)}</div>`; return; }
  renderExchBoard(d, opts);
}
function exchOrderRow(o, owned, ins) {
  let act;
  if (o.isMine) {
    act = `<button type="button" class="auc-btn ghost sm exch-cancel" data-order="${o.id}">Снять</button>`;
  } else if (owned > 0) {
    const maxSell = Math.min(o.remaining, owned);
    act = `<input class="exch-sell-qty" type="number" min="1" max="${maxSell}" value="${maxSell}" inputmode="numeric">
      <button type="button" class="auc-btn buy sm exch-sell" data-order="${o.id}">Продать</button>`;
  } else {
    act = `<span class="exch-o-none">нет товара</span>`;
  }
  return `<div class="exch-bo-row${o.isMine ? ' mine' : ''}">
    <button type="button" class="exch-bo-ico${qClass(true, ins.quality)}">${esc(itemIconText(ins.icon, ins.type, ins.stats, ins.slot))}</button>
    <div class="exch-bo-main">
      <div class="exch-bo-price">${coinsHtml(o.price, o.currency)} <span class="exch-bo-per">/ шт</span></div>
      <div class="exch-bo-sub">${esc(o.buyerName)} · куплено ${aucFmt(o.filled)}/${aucFmt(o.quantity)}${o.endsAt ? ' · ' + aucTimeLeft(o.endsAt) : ''}</div>
    </div>
    <div class="exch-bo-act">${act}</div>
  </div>`;
}
function renderExchBoard(d, opts = {}) {
  const host = $('exch-detail'); if (!host) return;
  const ins = d.instrument;
  const showForm = opts.showForm === true;
  const showOrders = opts.showOrders !== false;
  const durOpts = (d.tariffs?.durations || [6, 12, 24, 48]).map((h) =>
    `<option value="${h}">${h < 24 ? h + ' ч' : Math.floor(h / 24) + ' дн'}</option>`).join('');
  host.innerHTML = `
    <div class="exch-d-head">
      <button type="button" class="exch-d-ico${qClass(true, ins.quality)}">${esc(itemIconText(ins.icon, ins.type, ins.stats, ins.slot))}</button>
      <span class="exch-d-name">${esc(ins.name)}</span>
      ${showForm ? '' : `<span class="exch-d-owned">У вас в рюкзаке: <b>${aucFmt(d.owned)}</b></span>`}
    </div>
    <div class="exch-newform">
      <div class="exch-newform-row">
        <div class="auc-field exch-price-cell"><span>Цена за шт</span>${priceFieldsHtml('exch-price', 0, 'money')}</div>
        <label class="auc-field"><span>Количество</span><input id="exch-qty" type="number" min="${ins.lotSize}" step="${ins.lotSize}" inputmode="numeric" value="${ins.lotSize}"></label>
        <label class="auc-field"><span>Срок</span><select id="exch-dur">${durOpts}</select></label>
      </div>
      <div class="exch-newform-foot">
        <div class="auc-field row"><span>Заблокируется</span><b id="exch-total">0</b></div>
        <button type="button" class="auc-btn buy" id="exch-submit">Выставить заявку</button>
      </div>
      <div class="auc-error hidden" id="exch-error"></div>
    </div>
    <div class="exch-board">
      <div class="exch-board-title">Заявки на покупку (${d.orders.length})</div>
      ${d.orders.length ? d.orders.map((o) => exchOrderRow(o, d.owned, ins)).join('')
        : '<div class="exch-book-empty">Заявок пока нет — выставьте первую.</div>'}
    </div>`;

  if (!showForm) host.querySelector('.exch-newform')?.remove();
  if (!showOrders) host.querySelector('.exch-board')?.remove();
  if (showForm) {
    const qtyEl = $('exch-qty'), totalEl = $('exch-total');
    const recalc = () => {
      const price = priceEditorValue('exch-price');
      totalEl.innerHTML = coinsHtml(price.price * (Math.trunc(+qtyEl.value || 0)), price.currency);
    };
    bindPriceEditor('exch-price', recalc);
    qtyEl.addEventListener('input', recalc); recalc();
    $('exch-submit').addEventListener('click', () => exchCreateOrder(ins, qtyEl, $('exch-dur')));
  }
  const showPreview = () => openMarketPreview(ins);
  host.querySelector('.exch-d-ico')?.addEventListener('click', showPreview);
  host.querySelectorAll('.exch-bo-ico').forEach((b) => b.addEventListener('click', showPreview));
  host.querySelectorAll('.exch-cancel').forEach((b) =>
    b.addEventListener('click', () => exchCancelOrder(b.dataset.order, b)));
  host.querySelectorAll('.exch-sell').forEach((b) => b.addEventListener('click', () => {
    const qtyInput = b.parentElement.querySelector('.exch-sell-qty');
    exchSellInto(b.dataset.order, Math.trunc(+qtyInput.value || 0), b);
  }));
}
async function exchCreateOrder(ins, qtyEl, durEl) {
  const errEl = $('exch-error'); errEl.classList.add('hidden');
  const price = priceEditorValue('exch-price');
  const quantity = Math.trunc(+qtyEl.value || 0);
  if (!(price.price > 0) || !(quantity > 0)) { errEl.textContent = 'Укажите цену и количество'; errEl.classList.remove('hidden'); return; }
  const btn = $('exch-submit'); btn.disabled = true;
  try {
    const p = readPriceEditor('exch-price');
    const r = await api.exchangeOrder({ instrumentId: ins.instrumentId, quantity,
      priceMode: p.priceMode, money: p.money, diamond: p.diamond,
      durationHours: Math.trunc(+durEl.value || 0) });
    applyWallet(r.wallet); refreshMailUnread();
    showToast('Заявка на покупку выставлена');
    if (aucTab === 'exchange' && aucView === 'exch-new') {
      exchSel = ins.instrumentId;
      aucView = 'browse';
      syncAucTabs();
      renderExchange();
    } else if (r.board) renderExchBoard(r.board);
    else loadExchBoard(ins.instrumentId);
  } catch (e) { btn.disabled = false; errEl.textContent = aucErr(e); errEl.classList.remove('hidden'); }
}
async function exchSellInto(orderId, quantity, btn) {
  if (!(quantity > 0)) { showToast('Укажите количество'); return; }
  btn.disabled = true;
  try {
    const r = await api.exchangeSell(orderId, quantity);
    applyWallet(r.wallet); await refreshSelf(); refreshMailUnread();
    showToast(`Продано ${r.sold} шт · выручка зачислена`);
    if (aucTab === 'exchange' && aucView === 'browse') renderExchange();
    else if (r.board) renderExchBoard(r.board);
  } catch (e) { btn.disabled = false; showToast(aucErr(e)); }
}
async function exchCancelOrder(orderId, btn) {
  btn.disabled = true;
  try {
    const r = await api.exchangeCancel(orderId);
    applyWallet(r.wallet); refreshMailUnread();
    showToast('Заявка снята · возврат придёт письмом');
    if (aucTab === 'exchange' && aucView === 'browse') renderExchange();
    else if (r.board) renderExchBoard(r.board);
  } catch (e) { btn.disabled = false; showToast(aucErr(e)); }
}

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

// иконки действий в списке игроков
const ICON_SWORD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/></svg>`;
const ICON_INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg>`;
const ICON_DM = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/></svg>`;
const ICON_SAY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 20 5v13l-17-4.5z"/><path d="M7 13.5V18l3 1"/></svg>`;

function playerActBtn(cls, svg, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg;
  b.addEventListener('click', onClick);
  return b;
}

async function refreshPlayers() {
  if (!online) return;
  try {
    const players = await api.players();
    playersList.innerHTML = '';
    const head = document.createElement('div');     // всего игроков в локации (#9)
    head.className = 'players-head';
    head.textContent = `Игроков в локации: ${players.length}`;
    playersList.appendChild(head);
    for (const p of players) {
      const self = String(p.id) === String(PLAYER.id);
      const row = document.createElement('div');
      row.className = 'player-row';
      const name = document.createElement('span');
      name.className = 'player-name';
      name.textContent = p.name + ' ';
      const lvl = document.createElement('span');
      lvl.className = 'm-lvl';
      lvl.textContent = `[${p.level}]`;
      name.appendChild(lvl);
      if (!self) {                                   // тап по нику — меню действий
        name.classList.add('tappable');
        name.addEventListener('click', (e) => openNickMenu(e, { id: p.id, name: p.name }));
      }
      row.appendChild(name);
      const acts = document.createElement('div');
      acts.className = 'player-actions';
      const peer = { id: p.id, name: p.name };
      acts.appendChild(playerActBtn('player-act', ICON_INFO,
        self ? 'Моя информация' : `Информация: ${p.name}`, () => openPlayerInfo(peer)));
      if (!self) {                       // личка/общий/атака — только для других
        acts.append(
          playerActBtn('player-act', ICON_DM, `Личное сообщение: ${p.name}`,
            () => openDmTab(peer)),
          playerActBtn('player-act', ICON_SAY, `Написать ${p.name} в общий чат`,
            () => setPersonalTarget(peer)),
          playerActBtn('pvp-btn', ICON_SWORD, `Напасть на ${p.name}`,
            () => startPvp(p)),
        );
      }
      row.appendChild(acts);
      playersList.appendChild(row);
    }
  } catch (e) {
    console.error('Список игроков:', e);
  }
}

// ── Бейджи над иконками: идущие бои (#8) и личные сообщения мне (#10) ──

const battlesBadge = $('battles-badge');
const chatBadge = $('chat-badge');
let mentionUnread = 0;        // личные мне (в общем чате), ещё не просмотренные

function setBattlesBadge(n) {
  if (!battlesBadge) return;
  n = Math.max(0, Number(n) || 0);
  battlesBadge.textContent = n > 99 ? '99+' : String(n);
  battlesBadge.classList.toggle('hidden', n === 0);
}
async function refreshBattlesBadge() {
  if (!online) return;
  try { setBattlesBadge((await api.locationBattles()).length); } catch (e) { /* не критично */ }
}

/** Бейдж чата = непрочитанная личка + личные мне в общем чате. */
function updateChatBadge() {
  if (!chatBadge) return;
  let dm = 0;
  for (const c of dmConvos.values()) dm += c.unread;
  const total = dm + mentionUnread;
  chatBadge.textContent = total > 99 ? '99+' : String(total);
  chatBadge.classList.toggle('hidden', total === 0);
}
function noteMention() {       // личное мне пришло — звоночек, если не смотрим общий чат
  if (!(castleDockPane === 'chat' && activeChat === 'common')) mentionUnread++;
  updateChatBadge();
}
function clearMentions() { mentionUnread = 0; updateChatBadge(); }

/** Подсветить активную вкладку панели боёв. */
function syncBattlesTabs() {
  document.querySelectorAll('#battles-tabs .battles-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.bt === battlesTab));
}

/** Строка идущего боя — с кнопкой «вмешаться/смотреть». */
function activeBattleRow(b) {
  const row = document.createElement('div');
  row.className = 'battle-row';
  const kind = b.kind === 'pvp' ? 'дуэль' : 'охота';
  const left = (b.teams?.left || []).join(', ') || '—';
  const right = (b.teams?.right || []).join(', ') || '—';
  const label = document.createElement('span');
  label.className = 'battle-row-label';
  label.innerHTML = `<b>Бой #${b.battleId}</b> <span class="m-lvl">(${kind}, ход ${b.turn})</span>`
    + `<span class="battle-row-teams">${esc(left)} vs ${esc(right)}</span>`;
  row.appendChild(label);
  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'pvp-btn';
  info.title = b.allowJoin ? 'Вмешаться' : 'Смотреть состав';
  info.textContent = b.allowJoin ? '⚔' : 'ℹ';
  info.addEventListener('click', () => { closeBattlesPanel(); openBattleInfo(b.battleId); });
  row.appendChild(info);
  return row;
}

/** Строка завершённого боя — с итогом (кто победил) и переходом в таблицу итогов. */
function finishedBattleRow(b) {
  const row = document.createElement('div');
  row.className = 'battle-row';
  const kind = b.kind === 'pvp' ? 'дуэль' : 'охота';
  const left = (b.teams?.left || []).join(', ') || '—';
  const right = (b.teams?.right || []).join(', ') || '—';
  const outcome = b.status === 'aborted' ? 'прерван'
    : b.winnerSide === 1 ? 'победа 1-х'
    : b.winnerSide === 2 ? 'победа 2-х' : 'ничья';
  const label = document.createElement('span');
  label.className = 'battle-row-label';
  label.innerHTML = `<b>Бой #${b.battleId}</b> <span class="m-lvl">(${kind} · ${outcome})</span>`
    + `<span class="battle-row-teams">${esc(left)} vs ${esc(right)}</span>`;
  row.appendChild(label);
  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'pvp-btn';
  info.title = 'Итоги боя';
  info.textContent = 'ℹ';
  info.addEventListener('click', () => { closeBattlesPanel(); openBattleInfo(b.battleId); });
  row.appendChild(info);
  return row;
}

/** Список боёв локации — вкладки «Текущие» / «Завершённые» (#C2). */
async function refreshBattles() {
  if (!online || !battlesList) return;
  syncBattlesTabs();
  const finished = battlesTab === 'finished';
  try {
    const battles = finished
      ? await api.locationBattlesFinished()
      : await api.locationBattles();
    if (!finished) setBattlesBadge(battles.length);   // бейдж = только идущие
    battlesList.innerHTML = '';
    if (!battles.length) {
      battlesList.innerHTML = `<div class="bi-empty">${finished
        ? 'Завершённых боёв пока нет' : 'В локации нет идущих боёв'}</div>`;
      return;
    }
    for (const b of battles) {
      battlesList.appendChild(finished ? finishedBattleRow(b) : activeBattleRow(b));
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
let biSummaryData = null;          // данные завершённого боя (для пересортировки без запроса)
let biSort = 'default';            // сортировка таблицы итогов: 'default' | 'damage' | 'kills'

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

/** Время «ЧЧ:ММ» и человекочитаемая длительность боя. */
function fmtClock(ts) {
  if (!ts) return '?';
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)} ч ${m % 60} мин`;
  return m > 0 ? `${m} мин ${s % 60} с` : `${s} с`;
}

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
    const started = d.startedAt ? new Date(d.startedAt).getTime() : null;
    const metaBar = `<div class="bi-meta">Начало ${fmtClock(started)}`
      + ` · идёт ${fmtDuration(started ? Date.now() - started : null)}</div>`;
    binfoBody.innerHTML = `${metaBar}
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

  // бой завершён или прерван — таблица итогов по командам (адаптив + сортировка)
  clearInterval(binfoTimer);
  binfoTimer = null;
  binfoTitle.textContent = `Бой #${id} — ${d.status === 'aborted' ? 'прерван' : 'завершён'}`;
  biSummaryData = d;                 // запоминаем — для пересортировки без запроса
  renderBattleSummary();
}

/**
 * Итоги завершённого боя: компактная таблица по командам (Игрок · Опыт · Урон ·
 * Убийства), адаптив под телефон (команды столбцами на широком экране, друг под
 * другом на узком). Сортировка строк ВНУТРИ команды — по урону/убийствам или по
 * умолчанию (как пришло с сервера). Перерисовывается из biSummaryData без запроса.
 */
function renderBattleSummary() {
  const d = biSummaryData;
  if (!d) return;
  const showValor = d.results.some((r) => Number(r.valor) > 0);
  const num = (v) => (v == null ? '—' : v);

  // группируем по командам: 1я (left) и 2я (right) — разные цвета (#1.2)
  const teams = { 1: [], 2: [] };
  for (const r of d.results) (teams[r.side] || (teams[r.side] = [])).push(r);
  // сортировка внутри команды (по убыванию); 'default' — порядок с сервера
  const sortRows = (list) => {
    if (biSort === 'damage') return [...list].sort((a, b) => (b.damage || 0) - (a.damage || 0));
    if (biSort === 'kills') return [...list].sort((a, b) => (b.kills || 0) - (a.kills || 0)
      || (b.damage || 0) - (a.damage || 0));
    return list;
  };

  const rowHtml = (r) => {
    const res = RESULT_LABELS[r.result] || '';
    const resCls = r.result === 1 ? 'win' : r.result === 2 ? 'lose'
      : r.result === 4 ? 'flee' : '';
    return `<tr class="${r.isAI ? 'ai' : ''}">
      <td class="bi-c-name"><span class="bi-name-in">
        <span class="bi-dot ${resCls}" title="${res}"></span>
        <span class="bi-nm">${esc(r.name)}</span><span class="m-lvl">[${r.level ?? '?'}]</span>
      </span></td>
      <td class="bi-c-num">${r.exp != null ? num(r.exp) : '—'}</td>
      <td class="bi-c-num">${num(r.damage)}</td>
      <td class="bi-c-num${r.kills > 0 ? ' hot' : ''}">${num(r.kills)}</td>
      ${showValor ? `<td class="bi-c-num">${r.valor != null ? num(r.valor) : '—'}</td>` : ''}
    </tr>`;
  };
  // «N я команда» — буква «я» верхним индексом (степень, #1.2)
  const teamBlock = (side) => {
    const list = teams[side] || [];
    if (!list.length) return '';
    return `<div class="bi-teamcol bi-side-${side}">
      <div class="bi-team-cap"><b class="bi-tnum">${side}<sup>я</sup></b> команда</div>
      <table class="bi-tt">
        <thead><tr>
          <th class="bi-c-name">Игрок</th><th class="bi-c-num">Опыт</th>
          <th class="bi-c-num">Урон</th><th class="bi-c-num">Убийств</th>
          ${showValor ? '<th class="bi-c-num">Добл.</th>' : ''}
        </tr></thead>
        <tbody>${sortRows(list).map(rowHtml).join('')}</tbody>
      </table>
    </div>`;
  };
  // тулбар сортировки (#2): по умолчанию / по урону / по убийствам
  const sortBtn = (key, label) =>
    `<button type="button" class="bi-sort-btn${biSort === key ? ' active' : ''}" data-bi-sort="${key}">${label}</button>`;
  const toolbar = `<div class="bi-sortbar"><span class="bi-sortbar-k">Сортировка:</span>
    ${sortBtn('default', 'по умолчанию')}${sortBtn('damage', 'по урону')}${sortBtn('kills', 'по убийствам')}</div>`;

  const started = d.startedAt ? new Date(d.startedAt).getTime() : null;
  const ended = d.endedAt ? new Date(d.endedAt).getTime() : null;
  const metaBar = `<div class="bi-meta">Начало ${fmtClock(started)}`
    + ` · длилась ${fmtDuration(started && ended ? ended - started : null)}</div>`;
  binfoBody.innerHTML = `${metaBar}${toolbar}
    <div class="bi-summary">${teamBlock(1)}${teamBlock(2)}</div>`;
  binfoBody.querySelectorAll('.bi-sort-btn').forEach((b) =>
    b.addEventListener('click', () => { biSort = b.dataset.biSort; renderBattleSummary(); }));
}

// ---------------------------------------------------------------------------
// Инвентарь: рюкзак игрока, надеть/снять можно только своего персонажа
// ---------------------------------------------------------------------------

// последний снимок инвентаря с сервера: каждая вещь — отдельная строка
let serverInv = [];

/** Ключ шаблона предмета в ITEMS: знакомые получают 3D, остальные — без. */
const itemKeyFor = (it) => {
  const icon = it?.icon;
  if (icon && !/[A-Za-z]/.test(String(icon))) return icon;
  return 'srv' + (it?.templateId ?? it?.id ?? '');
};

// Эмодзи-иконка эликсира по его эффекту. Серверные icon-строки шаблонов
// (вроде 'elixirHealth') в ITEMS не маппятся — без этого в рюкзаке висела бы
// коробка 📦 вместо колбы. Вид определяем по base_stats (как на сервере).
const ELIXIR_EMOJI = { health: '🧪', power: '⚗️', mana: '🔮', blood: '🩸',
  escape: '🏃', poison: '☠️', heal_scroll: '🩹', cleanse: '🌀' };
// Подписи/действия по виду расходника (карточки превью, журнал боя).
const ELIXIR_KIND_LABEL = { health: 'Эликсир жизни', power: 'Эликсир мощи',
  mana: 'Эликсир маны', blood: 'Эликсир крови', escape: 'Эликсир побега',
  poison: 'Свиток отравления', heal_scroll: 'Свиток исцеления', cleanse: 'Свиток очищения' };
function elixirKindFromStats(stats) {
  const s = stats || {};
  if (s.escape) return 'escape';
  if (s.scroll === 'poison') return 'poison';
  if (s.scroll === 'heal') return 'heal_scroll';
  if (s.scroll === 'cleanse') return 'cleanse';
  if (s.kind === 'mana' || s.mana_pct != null) return 'mana';
  if (s.kind === 'blood' || s.crit_add != null) return 'blood';
  if (s.power_mult != null) return 'power';
  if (s.heal_pct != null || s.heal != null) return 'health';
  return null;
}

const ELIXIR_ACTION = { health: 'Восстановить здоровье', power: 'Усилить урон',
  mana: 'Восстановить ману', blood: 'Повысить шанс крита', escape: 'Покинуть бой',
  poison: 'Отравить врага', heal_scroll: 'Исцелить цель', cleanse: 'Снять эффекты' };

/** Короткое описание эффекта расходника по base_stats (для превью рюкзака). */
function elixirEffectText(kind, s) {
  s = s || {};
  const p = (v) => Math.round((Number(v) || 0) * 100);
  const tk = (v) => Math.max(1, Number(v) || 5);     // период тика (сек), дефолт 5 (#3)
  switch (kind) {
    case 'health': return s.heal_pct != null
      ? `+${p(s.heal_pct)}% HP за ${s.secs} c (каждые ${tk(s.tick)} c)` : `+${s.heal} HP`;
    case 'mana':   return `+${p(s.mana_pct)}% маны за ${s.secs} c (каждые ${tk(s.tick)} c)`;
    case 'power':  return `урон +${p((Number(s.power_mult) || 1) - 1)}% на ${s.power_turns} х.`;
    case 'blood':  return `крит +${p(s.crit_add)}% на ${s.turns || 1} х.`;
    case 'poison': return `−${p(s.dmg_pct)}% HP за ${s.secs} c (каждые ${tk(s.tick)} c) · тайм-аут ${s.cooldown} c`;
    case 'heal_scroll': return `+${p(s.heal_pct)}% HP за ${s.secs} c (каждые ${tk(s.tick)} c) · тайм-аут ${s.cooldown} c`;
    case 'cleanse': return `снимает яд/исцеление · тайм-аут ${s.cooldown} c`;
    case 'escape': return 'выход из боя';
    default: return '';
  }
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
    const ek = it.type === 4 ? elixirKindFromStats(it.stats) : null;
    const icon = ek ? ELIXIR_EMOJI[ek] : gearIconForItem(it);
    if (!ITEMS[key]) {
      ITEMS[key] = { name: it.name, slot: slotName, icon, quality: it.quality || 1, noModel: true };
    } else {
      ITEMS[key].name = it.name || ITEMS[key].name;
      ITEMS[key].slot = slotName || ITEMS[key].slot;
      ITEMS[key].quality = it.quality || ITEMS[key].quality || 1;
      if (!ITEMS[key].icon || ITEMS[key].icon === '📦' || /[A-Za-z]/.test(String(ITEMS[key].icon))) ITEMS[key].icon = icon;
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
const battleEffects = new Map();       // fighterId -> [{ icon, time, kind, label }]
let beltLive = false;                  // можно ли использовать пояс прямо сейчас
let beltSnapshot = null;               // состав пояса на старте боя — для автозаполнения (#2)
let scrollCdEnd = {};                  // тайм-аут свитка по виду (ts) — для серой зоны слота
const cdMax = {};                      // запомненный «полный» остаток по виду — доля заливки
let effectAccum = {};                  // fighterId -> накопленный Δ HP эффекта (порог показа всплывашки)
let cooldownTimer = null;              // тикер пересчёта серой зоны/таймера слотов (250мс)

const elixirGlyph = (kind) => ELIXIR_EMOJI[kind] || '🧪';

function normalizeTimedEffect(e, now = Date.now()) {
  if (!e || typeof e !== 'object') return null;
  const rawEnd = Number(e.endsAt);
  const rawRemainMs = Number(e.remainMs);
  const rawRemain = Number(e.remainSec);
  // Якорь локального отсчёта: уже зафиксированный endsAt → точный remainMs с
  // сервера → грубый remainSec. Привязываем ОДИН раз на свежий объект эффекта
  // (события приносят новые объекты с remainMs и ресинкают отсчёт точно).
  if (Number.isFinite(rawEnd) && rawEnd > 0) {
    e.endsAt = rawEnd;
  } else if (Number.isFinite(rawRemainMs) && rawRemainMs > 0) {
    e.endsAt = now + rawRemainMs;
  } else if (Number.isFinite(rawRemain) && rawRemain > 0) {
    e.endsAt = now + rawRemain * 1000;
  } else {
    e.remainSec = 0;
    return e;
  }
  e.remainSec = Math.max(0, Math.ceil((e.endsAt - now) / 1000));
  return e;
}

function activeTimedEffects(f) {
  if (!f || !Array.isArray(f.effects)) return [];
  const now = Date.now();
  for (const e of f.effects) normalizeTimedEffect(e, now);
  return f.effects.filter((e) => Number(e.remainSec) > 0);
}

/**
 * Состояние «недоступности» слота расходника (серая зона + таймер). Эликсир недоступен,
 * пока его эффект того же вида активен НА МНЕ (по умолчанию цель — я); свиток — пока идёт
 * тайм-аут. Возвращает { cooling, num, frac }: num — число в таймере (секунды или ходы),
 * frac — доля оставшегося (1→0) для «постепенно осветляющейся» заливки. Свитки яда/
 * исцеления стакаются — их слот НЕ серый (ограничивает только тайм-аут на свой свиток).
 */
function slotCoolState(kind) {
  const left = battle?.sides?.left;
  let remain = 0, unit = 'sec';        // remain: секунды (sec) или ходы (turn)
  if (kind === 'power') { remain = selfBuffTurns; unit = 'turn'; }
  else if (kind === 'blood') { remain = Number(left?.critBuffTurns) || 0; unit = 'turn'; }
  else if (kind === 'health') {
    const e = activeTimedEffects(left).filter((x) => x.kind === 'health' || x.kind === 'heal_scroll');
    remain = e.length ? Math.max(...e.map((x) => x.remainSec || 0)) : 0;
  } else if (kind === 'mana') {
    const e = activeTimedEffects(left).find((x) => x.kind === 'mana');
    remain = e ? (e.remainSec || 0) : 0;
  } else if (kind === 'poison' || kind === 'heal_scroll' || kind === 'cleanse') {
    remain = Math.max(0, Math.ceil(((scrollCdEnd[kind] || 0) - Date.now()) / 1000));
  }
  if (remain <= 0) { cdMax[kind] = 0; return { cooling: false, num: 0, frac: 0, unit }; }
  cdMax[kind] = Math.max(cdMax[kind] || 0, remain);          // «полный» отсчёт = максимум виденного
  return { cooling: true, num: remain, frac: remain / cdMax[kind], unit };
}

/** Подтянуть состав пояса с сервера (сервер его помнит между сессиями). */
async function loadBelt() {
  if (!online || !api.belt) return;
  try { elixirBelt = await api.belt(); } catch (e) { console.warn('Пояс эликсиров:', e); }
}

/** Снимок состава пояса: какая ячейка какой эликсир держала (для восстановления). */
function snapshotBelt() {
  return elixirBelt.map((c) => c ? { slot: c.slot, templateId: c.templateId } : null);
}

/**
 * Автозаполнение пояса после боя (#2): возвращаем в каждую ячейку тот же эликсир,
 * что стоял до боя, и доливаем до лимита из рюкзака. Сервер — судья лимитов и
 * наличия (стоп по not_enough/slot_occupied/belt_full). Адресная вставка по слоту
 * восстанавливает прежнюю раскладку, даже если ячейка опустела за бой.
 */
async function autofillBeltAfterBattle() {
  if (!beltAutofillPref() || !online || !api.belt || !beltSnapshot) return;
  try {
    await loadBelt();   // актуальный остаток после боя
    for (const snap of beltSnapshot) {
      if (!snap) continue;
      for (let n = 0; n < 24; n++) {             // потолок с запасом под мощь ×10
        try { elixirBelt = await api.beltEquip(snap.templateId, snap.slot); }
        catch { break; }                          // в рюкзаке пусто / ячейка заполнена
      }
    }
  } catch (e) { console.warn('Автозаполнение пояса:', e); }
}

/** Превью эффекта по тапу на его значок в окне боя (#8). */
function showEffectPreview(eff) {
  if (!eff || !fxPreviewEl || !fxPreviewCardEl) return;
  const rows = [];
  if (eff.label) rows.push(['Эффект', eff.label]);
  rows.push(['Вид', eff.kind === 'debuff' ? 'Ослабление' : 'Усиление']);
  if (eff.time != null && eff.time !== '') {
    rows.push(['Осталось', eff.unit === 'sec' ? eff.time + ' c' : eff.time + ' х.']);
  }
  if (eff.every) rows.push(['Тик', 'каждые ' + eff.every + ' c']);
  fxPreviewCardEl.className = 'fx-preview-card ' + (eff.kind === 'debuff' ? 'debuff' : 'buff');
  fxPreviewCardEl.innerHTML = `
    <div class="fx-head"><span class="fx-ico">${esc(eff.icon || '✦')}</span>
      <button type="button" class="fx-close" title="Закрыть">✕</button></div>
    <div class="fx-rows">${rows.map(([k, v]) =>
      `<div class="fx-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('')}</div>`;
  fxPreviewCardEl.querySelector('.fx-close').addEventListener('click', hideEffectPreview);
  fxPreviewEl.classList.remove('hidden');
}
function hideEffectPreview() { fxPreviewEl?.classList.add('hidden'); }

const fxPreviewEl = $('fx-preview');
const fxPreviewCardEl = $('fx-preview-card');
// тап вне карточки превью эффекта — закрыть (#8)
fxPreviewEl?.addEventListener('click', (e) => { if (e.target === fxPreviewEl) hideEffectPreview(); });

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
    // смена соперника — это переход с одного ЖИВОГО фокуса на другого (не первый показ)
    const isSwitch = currentFocusId != null && focus.id != null
      && String(focus.id) !== String(currentFocusId);
    currentFocusId = focus.id ?? null;
    ui.setOpponent(focus, { switched: isSwitch });
    // NvN: фокус перешёл на нового живого врага. На РЕАЛЬНОЙ смене соперника
    // модель «выезжает» сбоку (#1.5 — момент очевиден); иначе просто поднимаем
    // правую модель, если она лежит после гибели прошлого соперника (#6).
    const live = focus.alive !== false && (focus.hp == null || focus.hp > 0);
    if (live && fighters.right && fighters.right.root) {
      if (isSwitch) fighters.right.enterFromSide();
      else if (fighters.right.alive === false) fighters.right.revive();
    }
  }
  if (focus.maxHp) showHP('right', focus.hp, focus.maxHp);
  syncEffectFromFighter(focus);
  refreshHeaderEffects();
  setOpponentVisible(true);
}

/** Карточка «информация об игроке» (модалка боя): имя, уровень, HP, сторона. */
function effectsInfoHtml(list = []) {
  if (!list.length) return '<div class="finfo-effects-empty">Активных эффектов нет</div>';
  return `<div class="finfo-effects">${list.map((e) =>
    `<span class="effect-chip ${e.kind === 'debuff' ? 'debuff' : 'buff'}" title="${esc(e.label || '')}">
       <span class="effect-ico">${esc(e.icon || '✦')}</span>
       ${e.time != null && e.time !== '' ? `<span class="effect-time">${esc(e.time)}</span>` : ''}
     </span>`).join('')}</div>`;
}

function fighterCard(info, teamLabel) {
  const name = info?.name;
  const level = info?.level;
  const hp = info?.hp;
  const maxHp = info?.maxHp;
  syncEffectFromFighter(info);
  const rows = [`<div class="finfo-row"><span>Уровень</span><b>${esc(String(level ?? '?'))}</b></div>`];
  if (maxHp) rows.push(
    `<div class="finfo-row"><span>Здоровье</span><b>${Math.max(0, Math.round(hp))} / ${maxHp}</b></div>`);
  if (teamLabel) rows.push(`<div class="finfo-row"><span>Сторона</span><b>${teamLabel}</b></div>`);
  binfoTitle.textContent = name || '—';
  binfoBody.innerHTML = `<div class="finfo">${rows.join('')}
    <div class="finfo-block-title">Активные эффекты</div>
    ${effectsInfoHtml(effectsFor(info?.id))}
    <div class="finfo-sections pinfo" data-fid="${esc(String(info?.id ?? ''))}"></div>
  </div>`;
  if (binfoCopyBtn) binfoCopyBtn.style.display = 'none';   // не бой — ссылку не копируем
  clearInterval(binfoTimer); binfoTimer = null; binfoId = null;
  binfoEl.classList.remove('hidden');
  // характеристики/снаряжение/статистика игрока (#C3): подгружаем по charId.
  // ИИ-бойцы (нечисловой id, напр. 'npc-2-1') пропускаем — публичной карточки нет.
  const charId = Number(info?.id);
  if (online && Number.isFinite(charId) && String(charId) === String(info?.id)) {
    const host = binfoBody.querySelector(`.finfo-sections[data-fid="${charId}"]`);
    if (host) {
      host.innerHTML = '<div class="bi-empty">Загрузка…</div>';
      api.playerInfo({ id: charId })
        .then((p) => { if (host.isConnected) host.innerHTML = pinfoSectionsHtml(p) || ''; })
        .catch(() => { if (host.isConnected) host.innerHTML = ''; });
    }
  }
}

/** «Инфо» у ника в шапке боя (своя плашка / сфокусированный соперник). */
function showFighterInfo(side) {
  if (!battle || !battle.sides) return;
  const base = battle.sides[side] || {};
  const info = side === 'right' && battle.focus ? battle.focus : base;
  fighterCard({ ...base, ...info,
    hp: info.hp != null ? info.hp : base.hp,
    maxHp: info.maxHp ?? base.maxHp },
    side === 'left' ? 'Союзники' : 'Противники');
}

/** «Инфо» у участника в окне «Участники боя» — ищем бойца в ростере по id. */
function showMemberInfo(id) {
  if (!battle || !battle.roster) return;
  for (const side of ['left', 'right']) {
    const f = (battle.roster[side] || []).find((x) => String(x.id) === String(id));
    if (f) {
      fighterCard(f, side === 'left' ? 'Союзники' : 'Противники');
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
  battleEffects.clear();
  selfBuffTurns = 0;
  selfBuffPct = 0;
  beltLive = false;
  scrollCdEnd = {};
  effectAccum = {};
  for (const k in cdMax) cdMax[k] = 0;
  renderCombatBar();
  refreshSelfEffects();
}

/** Всплывашки урона/лечения ОТ ЭФФЕКТОВ по времени. Берём `dHp` с сервера — чистое
 *  изменение HP именно от эффекта за тик (полоса HP двигается и от ударов, поэтому
 *  считать по разнице HP нельзя, #2). Копим до заметной величины, чтобы не спамить. */
function showEffectNumbers(changed) {
  if (!ui || !arena) return;
  const selfId = battle?.sides?.left?.id;
  const focusId = (battle?.focus || battle?.sides?.right)?.id;
  for (const c of changed || []) {
    // dHp — РОВНО то, что эффект изменил на этом тике (сервер уже применил его к HP,
    // и этот же effectTick двигает полосу HP). Показываем число тик-в-тик, без
    // накопления порога: «−14 на табло ⇔ −14 с полоски» (ТЗ #3).
    const shown = Math.round(Number(c.dHp) || 0);
    if (!shown) continue;
    // число вешаем ТОЛЬКО на того, кто реально на сцене: себя (left) и
    // сфокусированного врага (right). Тики прочих бойцов в NvN видны в ростере —
    // иначе «−N» от не-сфокусированного бандита прыгал бы на чужую модель.
    const onSelf  = c.side === 'left'  && (selfId  == null || String(c.id) === String(selfId));
    const onFocus = c.side === 'right' && focusId != null && String(c.id) === String(focusId);
    if (!onSelf && !onFocus) continue;
    const side = c.side === 'left' ? 'left' : 'right';   // позиция: я слева, фокус справа
    const fighter = fighters[side];
    const pos = fighter
      ? arena.worldToScreen(fighter.headPoint()) : { x: side === 'left' ? 70 : 220, y: 110 };
    // лечение от свитков/HoT — зелёным «+N»; урон ОТ ЭФФЕКТА (яд/DoT) — СЕРЫМ «−N»,
    // чтобы отличать его от красного урона удара (ТЗ #7)
    ui.popup(pos, shown > 0 ? `+${shown}` : `${shown}`, shown > 0 ? 'heal' : 'effect-dmg');
  }
}

// Чипы эффектов по виду (over-time): иконка + цвет (усиление/ослабление).
const OT_CHIP = {
  health:      { icon: '🧪', kind: 'buff',   label: 'Лечение' },
  heal_scroll: { icon: '🩹', kind: 'buff',   label: 'Исцеление' },
  mana:        { icon: '🔮', kind: 'buff',   label: 'Мана' },
  poison:      { icon: '☠️', kind: 'debuff', label: 'Отравление' },
};

/** Все активные эффекты бойца чипами (мощь, крит, лечение/яд/мана по времени).
 *  q — качество расходника (цвет рамки чипа, ТЗ #3). */
function effectsForFighter(f) {
  const out = [];
  const turns = Number(f?.buffTurns || 0);
  if (turns > 0) {
    const pct = Math.round(((Number(f?.buffMult) || 1.5) - 1) * 100);
    out.push({ icon: '💪', time: turns, unit: 'turn', kind: 'buff',
      label: `Эликсир мощи: урон +${pct}%`, pct, q: f?.buffQuality || 0 });
  }
  const critT = Number(f?.critBuffTurns || 0);
  if (critT > 0) {
    const pct = Math.round((Number(f?.critBuffAdd) || 0) * 100);
    out.push({ icon: '🩸', time: critT, unit: 'turn', kind: 'buff',
      label: `Эликсир крови: крит +${pct}%`, q: f?.critBuffQuality || 0 });
  }
  for (const e of activeTimedEffects(f)) {
    const m = OT_CHIP[e.kind] || { icon: '✦', kind: 'buff', label: 'Эффект' };
    const every = Number(e.everySec) || 0;
    out.push({ icon: m.icon, time: e.remainSec, unit: 'sec', every, kind: m.kind,
      label: `${m.label}: ${e.remainSec} c${every ? `, каждые ${every} c` : ''}`, q: e.q || 0 });
  }
  return out;
}

function syncEffectFromFighter(f) {
  if (!f || f.id == null) return;
  const eff = effectsForFighter(f);
  const key = String(f.id);
  if (eff.length) battleEffects.set(key, eff);
  else battleEffects.delete(key);
}

function syncEffectsFromRoster(roster) {
  for (const side of ['left', 'right']) {
    for (const f of roster?.[side] || []) syncEffectFromFighter(f);
  }
}

function effectsFor(id) {
  return id == null ? [] : (battleEffects.get(String(id)) || []);
}

function refreshHeaderEffects() {
  if (!ui) return;
  syncEffectFromFighter(battle?.sides?.left);
  syncEffectFromFighter(battle?.focus || battle?.sides?.right);
  const leftId = battle?.sides?.left?.id;
  const right = battle?.focus || battle?.sides?.right;
  const selfPower = effectsFor(leftId).find((e) => e.pct != null) || null;
  selfBuffTurns = selfPower ? Number(selfPower.time) || 0 : 0;
  selfBuffPct = selfPower ? selfPower.pct || selfBuffPct : 0;
  ui.setEffects('left', effectsFor(leftId));
  ui.setEffects('right', effectsFor(right?.id));
  // полоса маны (синяя) в шапке боя — из mp/maxMp бойцов («Эликсир маны»)
  const leftF = battle?.sides?.left;
  if (leftF && leftF.maxMp != null) ui.setEnergy('left', leftF.mp || 0, leftF.maxMp || 0);
  if (right && right.maxMp != null) ui.setEnergy('right', right.mp || 0, right.maxMp || 0);
}

function applyBattleRoster(roster) {
  if (!roster || !ui) return;
  ui.setRoster(roster);
  syncEffectsFromRoster(roster);
  refreshHeaderEffects();
}

/** Показать активные эффекты игрока иконками с таймером в шапке боя. */
function refreshSelfEffects() {
  refreshHeaderEffects();
}

function effectPopupSide(d) {
  if (d.onSelf) return 'left';
  const right = battle?.focus || battle?.sides?.right;
  if (d.targetSide === 'right' && right && String(right.id) === String(d.targetId)) {
    return 'right';
  }
  return null;
}

function setBeltLive(v) {
  beltLive = v;
  if (v) startCooldownTicker();
  else { stopCooldownTicker(); scrollCdEnd = {}; for (const k in cdMax) cdMax[k] = 0; }
  renderCombatBar();
}

function startCooldownTicker() {
  if (cooldownTimer) return;
  cooldownTimer = setInterval(tickCombatCooldowns, 250);
}
function stopCooldownTicker() {
  clearInterval(cooldownTimer);
  cooldownTimer = null;
}

/** Каждые 250мс: осветляем серую зону и тикаем число; слот освободился/занялся → пересбор. */
function tickCombatCooldowns() {
  if (mode !== 'battle' || !elixirSlotsEl) { stopCooldownTicker(); return; }
  refreshHeaderEffects();
  const filled = elixirSlotsEl.querySelectorAll('.combat-slot.elixir.filled');
  let needRerender = false, idx = 0;
  for (let i = 0; i < ELIXIR_SLOTS; i++) {
    const cell = elixirBelt[i];
    if (!cell || (cell.qty != null && cell.qty <= 0)) continue;   // пустые не среди .filled
    const el = filled[idx++];
    if (!el) continue;
    const wasCooling = el.classList.contains('cooling');
    const cd = slotCoolState(cell.kind);
    if (cd.cooling && wasCooling) {
      const veil = el.querySelector('.cd-veil');
      const num = el.querySelector('.cd-num');
      if (veil) veil.style.opacity = (0.14 + 0.6 * cd.frac).toFixed(2);
      if (num) num.textContent = cd.num;
    } else if (cd.cooling !== wasCooling) {
      needRerender = true;                       // занялся или освободился — пересобрать слот
    }
  }
  if (needRerender) renderCombatBar();
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
      // серая зона + таймер, пока расходник недоступен (эффект эликсира идёт / тайм-аут свитка)
      const cd = slotCoolState(cell.kind);
      const qty = cell.qty != null ? cell.qty : 1;
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = `combat-slot elixir filled kind-${cell.kind || 'health'}`
        + ' q' + (cell.quality || 1) + (cd.cooling ? ' cooling' : '');
      slot.disabled = cd.cooling || !beltLive;
      slot.title = cd.cooling
        ? `${cell.name} — недоступен ещё ${cd.num}${cd.unit === 'turn' ? ' х.' : ' c'}`
        : `${cell.name} ×${qty} — использовать`;
      // счётчик зарядов в уголке (#1) + серая «вуаль» с таймером (CSS .cd-veil/.cd-num)
      slot.innerHTML = `<span class="bs-ico">${elixirGlyph(cell.kind)}</span>`
        + `<span class="bs-qty">${qty}</span>`
        + (cd.cooling ? `<span class="cd-veil" style="opacity:${(0.14 + 0.6 * cd.frac).toFixed(2)}"></span>`
            + `<span class="cd-num">${cd.num}</span>` : '');
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
  // применяет эффект. Параметры — с сервера; клиент шлёт номер ячейки и цель.
  // Цель имеет смысл лишь у свитков (ТЗ §A): исцеление→союзник, яд→враг,
  // очищение→любой. Эликсиры применяются только на себя — цель не шлём.
  const targeted = cell.kind === 'heal_scroll' || cell.kind === 'poison'
    || cell.kind === 'cleanse';
  battle.useElixir({ slot: i, target: targeted ? (ui?.target ?? null) : null });
  ui.log(`<b>${esc(battle.sides.left.name)}</b> выпивает «${esc(cell.name)}»…`);
}

/** Пояс в гардеробе: пряжка + все ячейки. Клик по заполненной — убрать; клик
 *  по пустой — выбрать её для адресной вставки эликсира из рюкзака (#4). */
function renderDressingBelt() {
  if (!dressingBeltEl) return;
  // выбор живёт только пока ячейка пуста (после заливки сбрасываем)
  if (selectedBeltSlot != null && elixirBelt[selectedBeltSlot]) selectedBeltSlot = null;
  dressingBeltEl.innerHTML = '<span class="belt-buckle" aria-hidden="true"></span>';
  for (let i = 0; i < ELIXIR_SLOTS; i++) {
    const cell = elixirBelt[i];
    const cap = cell ? (cell.cap ?? beltCapFor(cell.kind)) : 0;
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'belt-slot elixir round'
      + (cell ? ` filled kind-${cell.kind || 'health'} q${cell.quality || 1}` : '')
      + (!cell && selectedBeltSlot === i ? ' selected' : '');
    slot.title = cell
      ? `${cell.name} ×${cell.qty != null ? cell.qty : 1} из ${cap} (клик — убрать из пояса)`
      : (selectedBeltSlot === i
          ? `Ячейка ${i + 1} выбрана — нажмите эликсир в рюкзаке`
          : `Пустая ячейка ${i + 1} — выберите для вставки эликсира`);
    slot.innerHTML = cell
      ? `<span class="bs-ico">${elixirGlyph(cell.kind)}</span>`
        + `<span class="bs-qty">${cell.qty != null ? cell.qty : 1}</span>`
      : FLASK_SVG;
    slot.addEventListener('click', () => {
      if (cell) { removeElixirFromBelt(i); return; }
      selectedBeltSlot = selectedBeltSlot === i ? null : i;
      renderDressingBelt();
      renderInventory();   // обновить подпись кнопки «В ячейку N» в превью
      if (selectedBeltSlot != null) showToast(`Ячейка ${i + 1} выбрана — нажмите эликсир`);
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

/** Надеть один заряд эликсира (по templateId). slot задан (#4) — кладём именно
 *  в эту ячейку; иначе сервер доливает свою стопку до лимита, иначе занимает
 *  свободную (#1). Нельзя надеть больше, чем лежит в рюкзаке (сервер — судья). */
async function addElixirToBelt(templateId, slot = null) {
  if (!online) { showToast('Пояс требует подключения к серверу'); return; }
  if (templateId == null) return;
  try { elixirBelt = await api.beltEquip(templateId, slot); }
  catch (e) {
    const msg = { belt_full: 'Пояс эликсиров заполнен',
      not_enough: 'Больше нет в рюкзаке — нечего надеть',
      not_owned: 'Этого эликсира нет в рюкзаке',
      slot_occupied: 'Ячейка занята или заполнена доверху',
      bad_slot: 'Неверная ячейка пояса' }[e.message];
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
const invTabsEl = $('inv-tabs');
const invGridEl = $('inv-grid');
const invPreviewEl = $('inv-preview');
const dressing = new DressingRoom($('dressing-view'));
const dressingSide = 'left';   // одевать можно только себя

// Рюкзак: категория (вещи/эликсиры/разное), выбранная ячейка-превью и выбранная
// ячейка пояса (для адресной вставки эликсира — #4).
let invCategory = 'gear';            // 'gear' | 'elixir' | 'misc' | 'params'
let selectedInvId = null;            // id строки рюкзака, открытой в превью
let selectedBeltSlot = null;         // выбранная ячейка пояса (вставить эликсир сюда)
let paramsData = null;               // кеш /api/me для вкладки «Параметры» (статы/школа/очки)

// вкладки категорий рюкзака
invTabsEl?.querySelectorAll('.inv-tab').forEach((b) => {
  b.addEventListener('click', () => {
    invCategory = b.dataset.cat;
    selectedInvId = null;            // смена категории закрывает превью
    selectedSlot = null;             // и снимает подсветку слота куклы
    if (invCategory === 'params') refreshParams(); else renderInventory();
  });
});

/** Обновить данные вкладки «Параметры» (статы/школа/очки) и перерисовать рюкзак. */
async function refreshParams() {
  try { paramsData = await api.me(); } catch (e) { paramsData = null; }
  renderInventory();
}

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
        + qClass(!!item, item?.quality || 1)
        + (selectedSlot === slot ? ' selected' : '');
      cell.title = item ? `${meta.name}: ${item.name} (клик — снять)` : meta.name;
      cell.innerHTML = item
        ? `<span class="dc-item">${item.icon || gearIconFromSlot(slot) || '📦'}</span>`
        : `<span class="dc-ghost">${SLOT_ICONS[slot] || ''}</span>`;
      cell.addEventListener('click', () => {
        if (item) {                       // надето — клик снимает
          selectedSlot = null;
          toggleDressingEquip(key);
        } else {                          // пусто — подсветить подходящие вещи
          selectedSlot = selectedSlot === slot ? null : slot;
          selectedInvId = null;
          renderDressingUI();
          if (selectedSlot && !invGridEl.querySelector('.inv-cell.match')) {
            showToast(`Нет вещей в слот «${meta.name}»`);
          }
        }
      });
      col.appendChild(cell);
    }
  }
}

/** Строки рюкзака. Фейковые демо-вещи больше не подмешиваем (#3): онлайн —
 *  только серверный рюкзак; оффлайн (демо без сервера) — набор из ITEMS. */
function invRows() {
  if (!(online && serverInv.length)) {
    return Object.keys(ITEMS).map((key) => ({ id: key, key, inst: null }));
  }
  // расходники (type 4) стакаются в рюкзаке без ограничений — одна запись на
  // шаблон (суммарный остаток), даже если лежат в нескольких item_instances (#1).
  const rows = [];
  const elixByTpl = new Map();
  for (const it of serverInv) {
    if (it.type === 4) {
      const ex = elixByTpl.get(it.templateId);
      if (ex) { ex.inst.quantity = (ex.inst.quantity || 0) + (it.quantity || 0); continue; }
      const row = { id: 'tpl' + it.templateId, key: itemKeyFor(it), inst: { ...it } };
      elixByTpl.set(it.templateId, row);
      rows.push(row);
    } else {
      rows.push({ id: 'srv' + it.id, key: itemKeyFor(it), inst: it });
    }
  }
  return rows;
}

/** Разбор строки рюкзака: вещь/эликсир, слот, вид, заряды, категория (#5). */
function invRowMeta(row) {
  const { key, inst } = row;
  const base = ITEMS[key] || { name: inst?.name, icon: '📦',
    slot: inst ? slotNameFor(inst.slot) : null };
  // имя — всегда из серверной записи: тиры эликсира делят один ITEMS-ключ по эмодзи,
  // но имена у них разные (Малый/Лёгкий/… эликсир жизни)
  const item = inst ? { ...base, name: inst.name } : base;
  const slotName = inst ? slotNameFor(inst.slot) : item.slot;
  const isElixir = inst ? inst.type === 4 : item.type === 'elixir';
  const ekind = isElixir
    ? (inst ? elixirKindFromStats(inst.stats) : (item.kind || null)) : null;
  // все боевые расходники кладутся в пояс (включая эликсир побега и свитки)
  const beltable = isElixir && ekind != null;
  const tplId = inst ? inst.templateId : null;
  const stats = inst ? inst.stats : null;
  const quality = inst ? (inst.quality || 1) : 1;
  const owned = inst ? (inst.quantity || 1) : 1;            // всего в рюкзаке (стопка)
  // зарезервировано поясом: надетое в пояс «вычитается» из рюкзака (#2)
  const reserved = beltable && tplId != null
    ? elixirBelt.reduce((n, c) => c && c.templateId === tplId ? n + (c.qty || 0) : n, 0) : 0;
  const available = Math.max(0, owned - reserved);
  const equipped = !isElixir && !!slotName && equipState[dressingSide][slotName] === key;
  // категории рюкзака: вещи (надеваются) · эликсиры · разное
  const category = isElixir ? 'elixir' : (slotName ? 'gear' : 'misc');
  return { item, slotName, isElixir, ekind, beltable, tplId, stats, quality,
    qty: owned, owned, reserved, available, equipped, category };
}

const INV_EMPTY_TEXT = { gear: 'Нет вещей', elixir: 'Нет эликсиров', misc: 'Здесь пусто' };

/** Рюкзак: сетка квадратиков по выбранной категории + превью (#5, #6, #7). */
function renderInventory() {
  if (!invGridEl) return;
  const rows = invRows().map((r) => ({ ...r, meta: invRowMeta(r) }));
  // выбран пустой слот куклы → смотрим «Вещи» с подсветкой подходящих
  const effCat = selectedSlot ? 'gear' : invCategory;
  invTabsEl?.querySelectorAll('.inv-tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.cat === effCat));

  // вкладка «Параметры»: вместо сетки рисуем панель статов/школы/распределения
  const paramsEl = $('inv-params');
  if (effCat === 'params') {
    invGridEl.classList.add('hidden');
    invPreviewEl?.classList.add('hidden');
    if (paramsEl) { paramsEl.classList.remove('hidden'); renderParamsPanel(paramsEl); }
    return;
  }
  if (paramsEl) paramsEl.classList.add('hidden');
  invGridEl.classList.remove('hidden');

  // 0 шт. в рюкзаке не показываем: эликсир, целиком надетый в пояс, исчезает из
  // сетки рюкзака (его «свободный» остаток 0) — пустые квадратики не нужны (ТЗ #10)
  const shown = rows.filter((r) => r.meta.category === effCat
    && !(r.meta.isElixir && r.meta.available <= 0));
  if (!shown.some((r) => r.id === selectedInvId)) selectedInvId = null;

  invGridEl.innerHTML = '';
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'inv-empty';
    empty.textContent = INV_EMPTY_TEXT[effCat] || 'Пусто';
    invGridEl.appendChild(empty);
  }
  for (const r of shown) {
    const { item, slotName, isElixir, available, qty, quality, equipped } = r.meta;
    const count = isElixir ? available : qty;     // эликсиры: свободно в рюкзаке (#2)
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'inv-cell' + qClass(isElixir || !!slotName, quality)
      + (equipped ? ' equipped' : '')
      + (selectedInvId === r.id ? ' selected' : '');
    // выбран пустой слот куклы: подходящие подсвечиваем, прочие гасим
    if (selectedSlot) cell.classList.add(slotName === selectedSlot ? 'match' : 'dim');
    cell.title = item.name + (count !== 1 || isElixir ? ` ×${count}` : '');
    const showQty = isElixir || qty > 1;
    cell.innerHTML = `<span class="inv-cell-ico">${item.icon || gearIconFromSlot(slotName) || '📦'}</span>`
      + (showQty ? `<span class="inv-cell-qty">${count}</span>` : '')
      + (equipped ? '<span class="inv-cell-on" title="Надето">✓</span>' : '');
    cell.addEventListener('click', () => {
      selectedInvId = selectedInvId === r.id ? null : r.id;
      renderInventory();
    });
    invGridEl.appendChild(cell);
  }
  renderInvPreview(shown.find((r) => r.id === selectedInvId) || null);
}

/** Панель вкладки «Параметры»: 14 модельных статов + школа + распределение очков. */
function renderParamsPanel(el) {
  const d = paramsData;
  if (!d) { el.innerHTML = '<div class="inv-empty">Загрузка…</div>'; return; }
  const SCHOOL = { natisk: 'Натиск', uklon: 'Уклон', oplot: 'Оплот' };
  const m = d.params || {};
  const order = [
    ['power', 'Мощь'], ['health', 'Здоровье'], ['mana', 'Мана'], ['rage', 'Ярость'],
    ['initiative', 'Инициатива'], ['defense', 'Защита'], ['accuracy', 'Точность'],
    ['dodge', 'Уклонение'], ['crit', 'Крит'], ['critPower', 'Сила Крита'],
    ['critResist', 'Сопр. Криту'], ['block', 'Блок'], ['blockDmg', 'Блок урона'],
    ['counter', 'Контратака'],
  ];
  const pctKeys = new Set(['critPower', 'blockDmg']);
  const stat = (label, val) => `<div class="pinfo-stat"><i>${label}</i><b>${val}</b></div>`;
  const cells = order.map(([k, label]) => stat(label,
    m[k] == null ? '—' : (pctKeys.has(k) ? `${Math.round(m[k])}%` : Math.round(m[k])))).join('');
  const a = d.attrs || {};
  const fp = Number(d.freePoints) || 0;
  const buff = d.buff && d.buff.active
    ? `<div class="pinfo-row" style="color:#8fd089"><span>💧 Живая вода</span>
        <b>+${d.buff.hpPct || 10}% HP/урон · ${Math.ceil((d.buff.remainSec || 0) / 60)} мин</b></div>` : '';
  // урон за удар выводим из Мощи (сервер: урон = Мощь × powerToDamage 0.10), ±15% разброс.
  // Это БАЗОВЫЙ урон до защиты/блока соперника; Силу качаешь → растёт Мощь → растёт урон.
  const dmg = Math.round((Number(m.power) || 0) * 0.10);
  const dmgRow = `<div class="pinfo-row" style="color:var(--gold-bright)">
      <span>⚔ Базовый урон (от Мощи)</span><b>≈ ${dmg} (${Math.round(dmg * 0.85)}–${Math.round(dmg * 1.15)})</b></div>`;
  // сет-бонус по классам надетых вещей (статы выше уже учитывают его)
  const sb = Number(d.setBonus) || 1;
  const setRow = sb === 1 ? '' :
    `<div class="pinfo-row" style="color:${sb > 1 ? '#8fd089' : '#e07a6a'}">
      <span>🎽 Сет</span><b>${sb > 1 ? '+5% — всё своего класса' : '−15% — вещи разных классов'}</b></div>`;
  el.innerHTML = `
    <div class="pinfo-sec">
      <div class="pinfo-sec-title">Параметры · ${esc(SCHOOL[d.school] || '—')}</div>
      ${dmgRow}
      ${setRow}
      ${buff}
      <div class="pinfo-grid">${cells}</div></div>
    <div class="pinfo-sec">
      <div class="pinfo-sec-title">Распределение очков</div>
      <div class="pinfo-grid">
        ${stat('Сила', a.str ?? 0)}${stat('Ловкость', a.agi ?? 0)}${stat('Выносл.', a.vit ?? 0)}</div>
      <div class="pinfo-row" style="margin-top:6px"><span>Свободных очков</span><b>${fp}</b></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        <button type="button" class="bi-join-btn" data-alloc="str"${fp < 1 ? ' disabled' : ''}>+Сила → Натиск</button>
        <button type="button" class="bi-join-btn" data-alloc="agi"${fp < 1 ? ' disabled' : ''}>+Ловкость → Уклон</button>
        <button type="button" class="bi-join-btn" data-alloc="vit"${fp < 1 ? ' disabled' : ''}>+Выносл. → Оплот</button>
      </div>
      <div style="font-size:11px;color:var(--muted);line-height:1.45;margin-top:8px">
        Очки питают школу (растят все боевые статы своего угла) и дают:
        Сила — Мощь (урон), Ловкость — Инициативу и Крит, Выносливость — Здоровье.
        Сбросить очки можно у Травницы Леи — задание «Зелье забвения».</div></div>`;
  el.querySelectorAll('[data-alloc]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (fp < 1) return;
      try { await api.allocate(b.dataset.alloc, 1); await refreshParams(); }
      catch (e) { showToast('Не удалось распределить: ' + (e.message || '')); }
    });
  });
}

/** Превью выбранного предмета: иконка, инфо, кнопка действия (#7). */
function renderInvPreview(row) {
  if (!invPreviewEl) return;
  if (!row) { invPreviewEl.classList.add('hidden'); invPreviewEl.innerHTML = ''; return; }
  const { item, slotName, isElixir, ekind, beltable, tplId, stats, quality,
    owned, reserved, available, equipped } = row.meta;
  const rows = [];
  if (isElixir) {
    rows.push(['Тип', ELIXIR_KIND_LABEL[ekind] || 'Расходник']);
    rows.push(['Действие', ELIXIR_ACTION[ekind] || '—']);
    const fx = elixirEffectText(ekind, stats);
    if (fx) rows.push(['Эффект', fx]);
    if (beltable) rows.push(['В ячейку', 'до ' + beltCapFor(ekind, stats) + ' шт']);
    rows.push(['В рюкзаке', '×' + available]);
    if (reserved) rows.push(['В поясе', '×' + reserved]);
  } else {
    if (slotName) rows.push(['Слот', SLOT_META[slotName]?.name || slotName]);
    const clsName = { natisk: 'Натиск', uklon: 'Уклон', oplot: 'Оплот' }[stats && stats.cls];
    if (clsName) rows.push(['Класс', clsName]);
    const gs = gearStatsText(stats);                 // характеристики предмета (модель)
    if (gs) rows.push(['Характеристики', gs]);
    rows.push(['В рюкзаке', '×' + owned]);
  }

  // рамка и подложка превью подкрашиваются качеством предмета (q1–q5)
  invPreviewEl.className = 'inv-preview' + qClass(isElixir || !!slotName, quality);
  invPreviewEl.innerHTML = `
    <div class="ip-head">
      <span class="ip-ico${qClass(isElixir || !!slotName, quality)}">${item.icon || gearIconFromSlot(slotName) || '📦'}</span>
      <span class="ip-name">${esc(item.name)}</span>
      <button type="button" class="ip-close" title="Закрыть">✕</button>
    </div>
    <div class="ip-rows">${rows.map(([k, v]) =>
      `<div class="ip-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('')}</div>
    <div class="ip-actions"></div>`;
  invPreviewEl.querySelector('.ip-close').addEventListener('click', () => {
    selectedInvId = null; renderInventory();
  });

  const actions = invPreviewEl.querySelector('.ip-actions');
  if (beltable) {
    const cap = beltCapFor(ekind, stats);
    // куда поместится: выбранная ячейка (пустая/своя ниже лимита) ИЛИ авторазмещение
    const fitsSelected = selectedBeltSlot != null && (() => {
      const c = elixirBelt[selectedBeltSlot];
      return !c || (c.templateId === tplId && (c.qty || 0) < cap);
    })();
    const fitsAuto = elixirBelt.some((c) => !c)
      || elixirBelt.some((c) => c && c.templateId === tplId && (c.qty || 0) < cap);
    const fits = selectedBeltSlot != null ? fitsSelected : fitsAuto;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ip-btn';
    b.disabled = !online || tplId == null || reserved >= owned || !fits;
    b.textContent = selectedBeltSlot != null ? `В ячейку ${selectedBeltSlot + 1}`
      : (reserved ? `В пояс (×${reserved})` : 'В пояс');
    b.addEventListener('click', () => addElixirToBelt(tplId, selectedBeltSlot));
    actions.appendChild(b);
  } else if (slotName && !isElixir) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ip-btn' + (equipped ? ' equipped' : '');
    b.disabled = dressingBusy;
    b.textContent = dressingBusy ? 'Загрузка…' : (equipped ? 'Снять' : 'Надеть');
    b.addEventListener('click', () => { selectedSlot = null; toggleDressingEquip(row.key); });
    actions.appendChild(b);
  }
}

async function openDressing() {
  dressingEl.classList.remove('hidden');
  $('doll-level').textContent = PLAYER.level;
  dressing.start();
  dressingBusy = true;
  selectedSlot = null;
  selectedInvId = null;
  selectedBeltSlot = null;
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
    if (invCategory === 'params') refreshParams();   // открыта вкладка «Параметры» — свежие статы
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

const CASTLE_STUBS = {};

castlePerimeter?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-castle]');
  if (!btn) return;
  const id = btn.dataset.castle;
  if (id === 'bag') openDressing();
  else if (id === 'mail') openMail();
  else if (id === 'auction') openAuction();
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
    // чат: история без системного шума, затем живые сообщения; личка и почта
    api.onChat(onCommonChat);
    api.onChatDM(onDmMessage);
    api.onMail(() => refreshMailUnread());
    api.onError(onServerChatError);
    loadChatHistory(await api.chatHistory());
    refreshMailUnread();

    serverLocId = ch.location_id;
    setLocation(LOC_BY_ID[ch.location_id] || 'village', { quiet: true });
    refreshPlayers();
    refreshBattlesBadge();
    // счётчик идущих боёв над иконкой — обновляем периодически (когда вкладка видна)
    setInterval(() => { if (!document.hidden && mode !== 'battle') refreshBattlesBadge(); }, 15000);

    // ссылки из адреса: ?battle=N — статистика боя, ?info=Ник — карточка игрока
    const params = new URLSearchParams(location.search);
    const deepBattle = params.get('battle');
    if (deepBattle && /^\d+$/.test(deepBattle)) openBattleInfo(Number(deepBattle));
    const deepInfo = params.get('info');
    if (deepInfo) openPlayerInfo({ name: deepInfo });
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
