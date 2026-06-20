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
    const res = (tg && tg.initData)
      ? await rest('/api/auth/telegram', { initData: tg.initData })
      : await rest('/api/auth/dev', { name: devName });
    token = res.token;
    sessionStorage.setItem('token', token);
    api.isAdmin = !!res.isAdmin;          // вход из Telegram админом → предложить выбор
    await connectSocket();
    // страховка к push battleResume: сами спрашиваем сервер про идущий бой
    try {
      const cur = await rest('/api/battle/current');
      if (cur && cur.battleId) {
        console.log('Идущий бой с сервера (REST):', cur.battleId);
        socketHandlers.get('battleResume')(cur);
      }
    } catch (e) {
      console.warn('Проверка идущего боя:', e);
    }
    return res.character;
  },
  me:        () => rest('/api/me'),
  locations: () => rest('/api/locations'),
  move:      (to) => rest('/api/locations/move', { to }),
  players:   () => rest('/api/locations/players'),
  locationBattles: () => rest('/api/locations/battles'),
  inventory: () => rest('/api/inventory'),
  equip:     (itemId) => rest('/api/inventory/equip', { itemId }),
  unequip:   (slot) => rest('/api/inventory/unequip', { slot }),
  // пояс эликсиров (сервер помнит состав): массив ячеек ELIXIR_SLOTS
  belt:        () => rest('/api/belt'),
  // сервер сам выбирает ячейку: мощь копит в стопку, жизнь — в новый слот
  beltEquip:   (templateId) => rest('/api/belt/equip', { templateId }),
  beltUnequip: (slot) => rest('/api/belt/unequip', { slot }),
  chatHistory: () => rest('/api/chat/history'),
  battleInfo: (id) => rest('/api/battles/' + Number(id)),
  sendChat:  (text) => socket && socket.send(JSON.stringify({ type: 'chat', text })),
  onChat:    (fn) => socketHandlers.set('chat', fn),
  /** Регистрировать ДО login: cb получит ServerBattle, если бой ещё идёт. */
  onBattleResume: (fn) => { resumeCb = fn; },
};

function connectSocket() {
  wireBattleHandlers();
  return new Promise((resolve, reject) => {
    socket = new WebSocket(API.replace('http', 'ws') + '/ws?token=' + token);
    socket.addEventListener('open', resolve);
    // без этого login зависал бы навсегда, если REST доступен, а WS — нет
    socket.addEventListener('error',
      () => reject(new Error('ws_unavailable')), { once: true });
    socket.addEventListener('message', (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      const h = socketHandlers.get(msg.type);
      if (h) h(msg);
    });
  });
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
        && currentBattle.phase !== 'ended') return;
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
    currentBattle && currentBattle._on('elixir',
      { byId: m.byId, onSelf: !!m.onSelf, isUser: !!m.isUser,
        kind: m.kind, heal: m.heal, mult: m.mult, turns: m.turns,
        buffTurns: m.buffTurns, hp: m.hp, maxHp: m.maxHp,
        slot: m.slot, slotQty: m.slotQty, roster: m.roster }));
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
    if (currentBattle) currentBattle._on('serverError', { error: m.error, ...m });
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

  static hunt() {
    return new Promise((resolve, reject) => {
      pendingHunt = { resolve, reject };
      socket.send(JSON.stringify({ type: 'hunt' }));
    });
  }

  /** Дуэль PvP: напасть на игрока из списка игроков локации. */
  static attack(targetId) {
    return new Promise((resolve, reject) => {
      pendingHunt = { resolve, reject };
      socket.send(JSON.stringify({ type: 'attack', targetId }));
    });
  }

  /** Вмешательство: войти в идущий бой #battleId на сторону side ('left'|'right'). */
  static join(battleId, side) {
    return new Promise((resolve, reject) => {
      pendingHunt = { resolve, reject };
      socket.send(JSON.stringify({ type: 'join', battleId, side }));
    });
  }

  _applySides(s) {
    if (!s) return;
    if (s.left) {
      this.sides.left.hp = s.left.hp;
      if (s.left.buffTurns != null) this.sides.left.buffTurns = s.left.buffTurns;
    }
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
      this.sides.left.hp = detail.hp;
      if (detail.maxHp != null) this.sides.left.maxHp = detail.maxHp;
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
    socket.send(JSON.stringify(
      { type: 'move', attack: move.attack ?? null, block,
        pass: !!move.pass, target: move.target ?? null }));
    return true;
  }
  /** Использовать боевой эликсир: { kind:'health'|'power', potency, turns }. */
  useElixir(payload) { socket.send(JSON.stringify({ type: 'elixir', ...payload })); }
  finishTurn()    { socket.send(JSON.stringify({ type: 'turnDone' })); }
  /** Покинуть бой: сервер сам спишет Эликсир побега или откажет. */
  requestEscape() { socket.send(JSON.stringify({ type: 'escape' })); }
  destroy()       { if (currentBattle === this) currentBattle = null; }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
