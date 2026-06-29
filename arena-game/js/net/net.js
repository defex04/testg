/**
 * Сетевой адаптер для arena-game: js/net/net.js.
 *
 * ServerBattle повторяет интерфейс BattleSystem (события turnStart / timer /
 * resolve / battleEnd + submitMove / finishTurn), но бой целиком ведёт сервер.
 * События буферизуются до activate(): пока грузятся 3D-модели, ни один ход
 * не теряется. После F5/обрыва связи сервер сам возвращает идущий бой
 * сообщением battleResume — подпишись через api.onBattleResume(cb) ДО login.
 */
// Адрес сервера выбирает игрок на стартовом экране (index.html) —
// выбор кладётся в window.API_URL до загрузки этого модуля.
const API = window.API_URL || 'http://localhost:8080';
console.log('Сервер игры:', API);

let token = sessionStorage.getItem('token');
let socket = null;
const socketHandlers = new Map();
let currentBattle = null;
let pendingHunt = null;
let resumeCb = null;
let genericErrorCb = null;   // ошибки вне боя (чат/личка) — показать игроку
let socketCloseIntent = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let visibleReconnectBusy = false;
let pageShowSeen = false;

function socketOpen() {
  return socket && socket.readyState === WebSocket.OPEN;
}

function socketActive() {
  return socket && (socket.readyState === WebSocket.OPEN
    || socket.readyState === WebSocket.CONNECTING);
}

function reconnectPaused() {
  return document.hidden;
}

function sendWs(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }
  scheduleReconnect();
  return false;
}

function gracefulCloseSocket() {
  socketCloseIntent = true;
  try {
    if (socketOpen()) socket.send(JSON.stringify({ type: 'clientClose' }));
    if (socket) socket.close(1000, 'page_close');
  } catch { /* page is closing */ }
}

window.addEventListener('beforeunload', gracefulCloseSocket);
window.addEventListener('pagehide', (e) => {
  if (!e.persisted) gracefulCloseSocket();
});

function sendVisibility(hidden) {
  try {
    if (socketOpen()) socket.send(JSON.stringify({ type: 'visibility', hidden }));
  } catch { /* reconnect path will handle it */ }
}

async function reconnectWhenVisible() {
  if (!token || reconnectPaused() || visibleReconnectBusy) return;
  if (socketActive()) {
    sendVisibility(false);
    return;
  }
  visibleReconnectBusy = true;
  socketCloseIntent = false;
  try {
    await connectSocket();
    sendVisibility(false);
    await checkResumeBattle();
  } catch (e) {
    scheduleReconnect();
  } finally {
    visibleReconnectBusy = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    sendVisibility(true);
  } else reconnectWhenVisible();
});
window.addEventListener('pageshow', () => {
  if (!pageShowSeen) {
    pageShowSeen = true;
    return;
  }
  if (!document.hidden) reconnectWhenVisible();
});

async function rest(path, body) {
  const r = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}

export const api = {
  isAdmin: false,        // выставляется в login() из ответа сервера (Telegram-админ)
  /** Вход: Telegram initData в Mini App, иначе dev-вход по имени. */
  async login(devName = 'ИгрокА') {
    const tg = window.Telegram && window.Telegram.WebApp;
    // После F5/обновления страницы (в т.ч. кнопкой «Обновить игру») Telegram
    // отдаёт ТОТ ЖЕ initData, а сервер отклоняет повторный как replay
    // (auth.js: nonceOnce — одноразовый). Из-за этого игра уходила в оффлайн.
    // Поэтому если остался валидный токен прошлого входа (sessionStorage) —
    // входим по нему через /api/me, без повторной авторизации.
    if (token) {
      try {
        const character = await rest('/api/me');
        api.isAdmin = false;        // на обновлении страницы админ-выбор не переспрашиваем
        await connectSocket();
        await checkResumeBattle();
        return character;
      } catch (e) {
        console.warn('Сохранённый токен не подошёл — обычный вход:', e);
        token = null;
        sessionStorage.removeItem('token');
      }
    }
    const res = (tg && tg.initData)
      ? await rest('/api/auth/telegram', { initData: tg.initData })
      : await rest('/api/auth/dev', { name: devName });
    token = res.token;
    sessionStorage.setItem('token', token);
    api.isAdmin = !!res.isAdmin;          // вход из Telegram админом → предложить выбор
    await connectSocket();
    await checkResumeBattle();
    return res.character;
  },
  me:        () => rest('/api/me'),
  locations: () => rest('/api/locations'),
  move:      (to) => rest('/api/locations/move', { to }),
  players:   () => rest('/api/locations/players'),
  locationBattles: () => rest('/api/locations/battles'),
  locationBattlesFinished: () => rest('/api/locations/battles/finished'),
  inventory: () => rest('/api/inventory'),
  equip:     (itemId) => rest('/api/inventory/equip', { itemId }),
  unequip:   (slot) => rest('/api/inventory/unequip', { slot }),
  // распределить очко в атрибут (str/agi/vit/intel/wis) — задаёт школу треугольника
  allocate:  (attr, amount = 1) => rest('/api/character/allocate', { attr, amount }),
  // испить живой воды: бафф +10% HP/урона на 10 минут
  drinkWater: () => rest('/api/character/drink', {}),
  shop:      () => rest('/api/shop'),
  shopBuy:   (templateId, quantity = 1) => rest('/api/shop/buy', { templateId, quantity }),
  // пояс эликсиров (сервер помнит состав): массив ячеек ELIXIR_SLOTS
  belt:        () => rest('/api/belt'),
  // slot задан — кладём в эту ячейку (#4); иначе сервер выбирает сам (долить
  // свою стопку до лимита, иначе занять свободную)
  beltEquip:   (templateId, slot = null) =>
    rest('/api/belt/equip', slot != null ? { templateId, slot } : { templateId }),
  beltUnequip: (slot) => rest('/api/belt/unequip', { slot }),
  chatHistory: () => rest('/api/chat/history'),
  battleInfo: (id) => rest('/api/battles/' + Number(id)),
  sendChat:  (text) => sendWs({ type: 'chat', text }),
  onChat:    (fn) => socketHandlers.set('chat', fn),
  // личные сообщения в общий чат и приватная личка (отдельный канал на пару)
  sendPersonal: (to, text) =>
    sendWs({ type: 'chatPersonal', to, text }),
  sendPrivate:  (to, text) =>
    sendWs({ type: 'chatPrivate', to, text }),
  privateHistory: (peerId) => rest('/api/chat/private/' + Number(peerId)),
  onChatDM:  (fn) => socketHandlers.set('chatDM', fn),
  onMail:    (fn) => socketHandlers.set('mail', fn),
  onError:   (fn) => { genericErrorCb = fn; },   // серверные ошибки вне боя
  // публичная карточка игрока: по id или нику
  playerInfo: ({ id, name }) => rest('/api/players/info?' +
    (id ? 'id=' + Number(id) : 'name=' + encodeURIComponent(name))),
  // ── почта ──
  mail:       () => rest('/api/mail'),
  mailSent:   () => rest('/api/mail/sent'),
  mailUnread: () => rest('/api/mail/unread'),
  mailRead:   (id) => rest('/api/mail/' + Number(id)),
  mailReadSent: (id) => rest('/api/mail/sent/' + Number(id)),
  mailSend:   (payload) => rest('/api/mail/send', payload),
  mailTake:   (id) => rest('/api/mail/' + Number(id) + '/take', {}),
  mailDelete: (id) => rest('/api/mail/' + Number(id) + '/delete', {}),
  mailDeleteSent: (id) => rest('/api/mail/sent/' + Number(id) + '/delete', {}),
  // ── аукцион ──
  auction:       (q = {}) => rest('/api/auction' + qstr(q)),
  auctionMyLots: () => rest('/api/auction/mylots'),
  auctionMyBids: () => rest('/api/auction/mybids'),
  auctionCreate: (payload) => rest('/api/auction/lot', payload),
  auctionBid:    (lotId, price) => rest('/api/auction/bid', { lotId, ...(price || {}) }),
  auctionBuyout: (lotId) => rest('/api/auction/buyout', { lotId }),
  auctionCancel: (lotId) => rest('/api/auction/cancel', { lotId }),
  auctionEdit:   (lotId, payload) => rest('/api/auction/edit', { lotId, ...(payload || {}) }),
  // ── биржа (доска заявок на покупку) ──
  exchange:       (q = {}) => rest('/api/exchange' + qstr(q)),
  exchangeBoard:  (id) => rest('/api/exchange/board/' + Number(id)),
  exchangeOrder:  (payload) => rest('/api/exchange/order', payload),   // создать заявку на покупку
  exchangeSell:   (orderId, quantity) => rest('/api/exchange/sell', { orderId, quantity }),
  exchangeCancel: (orderId) => rest('/api/exchange/cancel', { orderId }),
  /** Регистрировать ДО login: cb получит ServerBattle, если бой ещё идёт. */
  onBattleResume: (fn) => { resumeCb = fn; },
};

/** Сборка query-строки (?a=1&b=2), пустые значения опускаются. */
function qstr(q) {
  const parts = Object.entries(q || {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v));
  return parts.length ? '?' + parts.join('&') : '';
}

/** Страховка к push battleResume: сами спрашиваем сервер про идущий бой. */
async function checkResumeBattle() {
  try {
    const cur = await rest('/api/battle/current');
    if (cur && cur.battleId) {
      console.log('Идущий бой с сервера (REST):', cur.battleId);
      socketHandlers.get('battleResume')(cur);
    }
  } catch (e) {
    console.warn('Проверка идущего боя:', e);
  }
}

function connectSocket() {
  wireBattleHandlers();
  return new Promise((resolve, reject) => {
    socketCloseIntent = false;
    const ws = new WebSocket(API.replace('http', 'ws') + '/ws?token=' + token);
    socket = ws;
    let opened = false;
    ws.addEventListener('open', () => {
      opened = true;
      reconnectDelay = 1000;
      resolve();
    });
    // без этого login зависал бы навсегда, если REST доступен, а WS — нет
    ws.addEventListener('error',
      () => { if (!opened) reject(new Error('ws_unavailable')); }, { once: true });
    ws.addEventListener('close', () => {
      if (socket === ws && !socketCloseIntent) scheduleReconnect();
    });
    ws.addEventListener('message', (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      const h = socketHandlers.get(msg.type);
      if (h) h(msg);
    });
  });
}

function scheduleReconnect() {
  if (!token || socketCloseIntent || reconnectTimer || reconnectPaused()) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (reconnectPaused()) return;
    try {
      await connectSocket();
      await checkResumeBattle();
    } catch (e) {
      reconnectDelay = Math.min(30000, Math.round(reconnectDelay * 1.7));
      scheduleReconnect();
    }
  }, reconnectDelay);
}

function wireBattleHandlers() {
  socketHandlers.set('battleStart', (m) => {
    // повторный battleStart (вмешательство в уже идущий бой) не пересоздаёт окно
    if (currentBattle && currentBattle.battleId === m.battleId
        && currentBattle.phase !== 'ended') return;
    currentBattle = new ServerBattle(
      { battleId: m.battleId, phase: 'choose', kind: m.kind,
        left: m.left, right: m.right, roster: m.roster, focus: m.focus,
        policy: m.policy });
    if (pendingHunt) { pendingHunt.resolve(currentBattle); pendingHunt = null; }
    else if (resumeCb) {
      // бой начат не нами (на нас напали / мы вмешались) — входим как при resume
      currentBattle.fresh = true;
      resumeCb(currentBattle);
    }
  });
  socketHandlers.set('battleResume', (m) => {
    // бой уже подхвачен (push и REST-страховка могут прийти оба) — не дублируем
    if (currentBattle && currentBattle.battleId === m.battleId
        && currentBattle.phase !== 'ended') {
      if (m.sides) {
        currentBattle._applySides(m.sides);
        currentBattle.sides.right = { ...(m.sides.right || m.focus || currentBattle.sides.right || {}) };
      }
      if (m.roster) currentBattle.roster = m.roster;
      if ('focus' in m) currentBattle._applyFocus(m.focus);
      if (m.policy) currentBattle.policy = m.policy;
      currentBattle.phase = m.phase || currentBattle.phase;
      if (m.phase === 'choose') {
        currentBattle._on('turnStart', { turn: m.turn, timeLeft: m.timeLeft,
          canAct: m.canAct !== false, active: m.active, waiting: !!m.waiting,
          focus: m.focus, targets: m.targets || [], roster: m.roster });
      } else if (m.roster) {
        currentBattle._on('rosterUpdate', { roster: m.roster });
      }
      return;
    }
    console.log('battleResume:', m.battleId, 'фаза', m.phase);
    const b = new ServerBattle(
      { battleId: m.battleId, phase: m.phase, kind: m.kind,
        left: m.sides.left, right: m.sides.right, roster: m.roster,
        focus: m.focus, policy: m.policy });
    currentBattle = b;
    if (m.phase === 'choose') {
      b._on('turnStart', { turn: m.turn, timeLeft: m.timeLeft,
        canAct: m.canAct !== false, active: m.active, waiting: !!m.waiting,
        focus: m.focus, targets: m.targets || [], roster: m.roster });
    }
    if (resumeCb) resumeCb(b);
  });
  socketHandlers.set('turnStart', (m) =>
    currentBattle && currentBattle._on('turnStart', {
      turn: m.turn, timeLeft: m.timeLeft,
      canAct: m.canAct !== false, active: m.active, waiting: !!m.waiting,
      focus: m.focus, targets: m.targets || [], roster: m.roster }));
  socketHandlers.set('timer', (m) =>
    currentBattle && currentBattle._on('timer', { timeLeft: m.timeLeft }));
  socketHandlers.set('resolve', (m) =>
    currentBattle && currentBattle._on('resolve',
      { turn: m.turn, strikes: m.strikes, passed: m.passed || [], sides: m.sides,
        focus: m.focus, roster: m.roster }));
  socketHandlers.set('rosterUpdate', (m) =>
    currentBattle && currentBattle._on('rosterUpdate', { roster: m.roster }));
  socketHandlers.set('elixir', (m) =>
    // пробрасываем ВСЕ поля события (itemName/amount/secs/critAdd/cooldownUntil/
    // removed/mp/maxMp и т.д.), приводим только флаги к boolean
    currentBattle && currentBattle._on('elixir',
      { ...m, onSelf: !!m.onSelf, isUser: !!m.isUser }));
  socketHandlers.set('effectTick', (m) =>
    currentBattle && currentBattle._on('effectTick',
      { self: m.self, changed: m.changed || [], deaths: m.deaths || [], roster: m.roster }));
  socketHandlers.set('policy', (m) =>
    currentBattle && currentBattle._on('policy', { intervention: m.intervention }));
  socketHandlers.set('battleEnd', (m) =>
    currentBattle && currentBattle._on('battleEnd',
      { winner: m.winner, victory: m.victory, aborted: !!m.aborted,
        reason: m.reason, sides: m.sides, reward: m.reward }));
  socketHandlers.set('error', (m) => {
    const wrap = () => {
      const e = new Error(m.error || 'server_error');
      if (m.battleId != null) e.battleId = m.battleId;
      if (m.targetSide) e.targetSide = m.targetSide;
      if (m.allowJoin != null) e.allowJoin = m.allowJoin;
      return e;
    };
    if (pendingHunt) { pendingHunt.reject(wrap()); pendingHunt = null; return; }
    if (currentBattle) { currentBattle._on('serverError', { error: m.error, ...m }); return; }
    if (genericErrorCb) genericErrorCb(m);
    else console.warn('Сервер:', m.error);
  });
}

export class ServerBattle extends EventTarget {
  constructor(init) {
    super();
    this.battleId = init.battleId;
    this.phase = init.phase || 'choose';
    this.kind = init.kind || 'hunt';   // 'hunt' | 'pvp'
    this.sides = { left: { ...init.left }, right: { ...(init.right || init.focus || {}) } };
    // ростер обеих команд (своя — left) и текущий сфокусированный соперник
    this.roster = init.roster || { left: [init.left].filter(Boolean),
                                   right: [init.right || init.focus].filter(Boolean) };
    this.focus = init.focus || init.right || null;
    this.policy = init.policy || {};
    this.active = false;
    this.queue = [];
  }

  static hunt(npc = null) {
    return new Promise((resolve, reject) => {
      pendingHunt = { resolve, reject };
      if (!sendWs({ type: 'hunt', npc })) { pendingHunt = null; reject(new Error('ws_unavailable')); }
    });
  }

  /** Дуэль PvP: напасть на игрока из списка игроков локации. */
  static attack(targetId) {
    return new Promise((resolve, reject) => {
      pendingHunt = { resolve, reject };
      if (!sendWs({ type: 'attack', targetId })) { pendingHunt = null; reject(new Error('ws_unavailable')); }
    });
  }

  /** Вмешательство: войти в идущий бой #battleId на сторону side ('left'|'right'). */
  static join(battleId, side) {
    return new Promise((resolve, reject) => {
      pendingHunt = { resolve, reject };
      if (!sendWs({ type: 'join', battleId, side })) { pendingHunt = null; reject(new Error('ws_unavailable')); }
    });
  }

  _applySides(s) {
    if (!s) return;
    // s.left = pub(me): полный снимок бойца (hp/mp/buffTurns/critBuffTurns/effects/…).
    // Сливаем его ЦЕЛИКОМ, иначе серверный сброс счётчиков (крит/мощь) не доходит до
    // плашки, и чип «Эликсира крови» висит после того, как заряд кончился (#2).
    if (s.left) this.sides.left = { ...this.sides.left, ...s.left };
    if (s.right) this.sides.right = { ...s.right };
  }
  _applyFocus(focus) {
    if (focus !== undefined) this.focus = focus;
    if (focus) this.sides.right = { ...focus };
  }

  /** Состояние применяется сразу; события — после activate(). */
  _on(type, detail) {
    if (detail && detail.roster) this.roster = detail.roster;
    if (type === 'turnStart') {
      this.phase = 'choose';
      if ('focus' in detail) this._applyFocus(detail.focus);
    }
    if (type === 'policy') this.policy.intervention = detail.intervention;
    if (type === 'resolve') {
      this.phase = 'resolving';
      if ('focus' in detail) this._applyFocus(detail.focus);
      this._applySides(detail.sides);
      detail.sides = this.sides;
    }
    if (type === 'elixir' && detail.onSelf) {   // эффект пришёлся мне — обновить плашку
      // target = pub(me): несёт hp/mp/effects/critBuffTurns — подмешиваем целиком,
      // чтобы чипы и «серая зона» слота появились сразу, не дожидаясь тика эффектов
      if (detail.target) this.sides.left = { ...this.sides.left, ...detail.target };
      this.sides.left.hp = detail.hp;
      if (detail.maxHp != null) this.sides.left.maxHp = detail.maxHp;
      if (detail.buffTurns != null) this.sides.left.buffTurns = detail.buffTurns;
      if (detail.mult != null) this.sides.left.buffMult = detail.mult;
    }
    if (type === 'elixir' && detail.targetSide === 'right' && detail.target) {
      if (this.sides.right && String(this.sides.right.id) === String(detail.target.id)) {
        this.sides.right = { ...this.sides.right, ...detail.target };
      }
      if (this.focus && String(this.focus.id) === String(detail.target.id)) {
        this.focus = { ...this.focus, ...detail.target };
      }
    }
    if (type === 'effectTick') {
      // тик эффектов по времени: подмешиваем свежие HP/MP/эффекты в плашки
      if (detail.self) this.sides.left = { ...this.sides.left, ...detail.self };
      for (const c of detail.changed || []) {
        if (c.side === 'right') {
          if (this.sides.right && String(this.sides.right.id) === String(c.id))
            this.sides.right = { ...this.sides.right, ...c };
          if (this.focus && String(this.focus.id) === String(c.id))
            this.focus = { ...this.focus, ...c };
        } else if (this.sides.left && String(this.sides.left.id) === String(c.id)) {
          this.sides.left = { ...this.sides.left, ...c };
        }
      }
    }
    if (type === 'battleEnd') {
      this.phase = 'ended';
      this._applySides(detail.sides);
      detail.sides = this.sides;
    }
    if (this.active) this._emit(type, detail);
    else this.queue.push([type, detail]);
  }

  /** Вызвать, когда модели загружены и слушатели навешаны. */
  activate() {
    this.active = true;
    const q = this.queue;
    this.queue = [];
    for (const [t, d] of q) this._emit(t, d);
  }
  start() { this.activate(); }  // совместимость с интерфейсом BattleSystem

  /** move: { attack, block, pass, target } — target = id выбранного врага (NvN). */
  submitMove(side, move) {
    const block = move.block ? String(move.block).replace(/^b-/, '') : null;
    sendWs({ type: 'move', attack: move.attack ?? null, block,
      pass: !!move.pass, target: move.target ?? null });
    return true;
  }
  /** Использовать боевой эликсир: { kind:'health'|'power', potency, turns }. */
  useElixir(payload) { sendWs({ type: 'elixir', ...payload }); }
  finishTurn()    { sendWs({ type: 'turnDone' }); }
  /** Покинуть бой: сервер сам спишет Эликсир побега или откажет. */
  requestEscape() { sendWs({ type: 'escape' }); }
  destroy()       { if (currentBattle === this) currentBattle = null; }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
