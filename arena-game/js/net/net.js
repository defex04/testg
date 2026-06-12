/**
 * Сетевой адаптер для arena-game: js/net/net.js.
 *
 * ServerBattle повторяет интерфейс BattleSystem (события turnStart / timer /
 * resolve / battleEnd + submitMove / finishTurn), но бой целиком ведёт сервер.
 * События буферизуются до activate(): пока грузятся 3D-модели, ни один ход
 * не теряется. После F5/обрыва связи сервер сам возвращает идущий бой
 * сообщением battleResume — подпишись через api.onBattleResume(cb) ДО login.
 */
// Выбор сервера: локальный запуск (localhost / file://) — локальный API,
// иначе (GitHub Pages и любой внешний хостинг) — сервер на Azure.
// window.API_URL, заданный до загрузки модуля, перекрывает автовыбор.
const AZURE_API = 'https://4.231.90.10.sslip.io';
const isLocal = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const API = window.API_URL || (isLocal ? 'http://localhost:8080' : AZURE_API);
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
  /** Вход: Telegram initData в Mini App, иначе dev-вход по имени. */
  async login(devName = 'ИгрокА') {
    const tg = window.Telegram && window.Telegram.WebApp;
    const res = (tg && tg.initData)
      ? await rest('/api/auth/telegram', { initData: tg.initData })
      : await rest('/api/auth/dev', { name: devName });
    token = res.token;
    sessionStorage.setItem('token', token);
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
  inventory: () => rest('/api/inventory'),
  equip:     (itemId) => rest('/api/inventory/equip', { itemId }),
  unequip:   (slot) => rest('/api/inventory/unequip', { slot }),
  chatHistory: () => rest('/api/chat/history'),
  battleInfo: (id) => rest('/api/battles/' + Number(id)),
  sendChat:  (text) => socket && socket.send(JSON.stringify({ type: 'chat', text })),
  onChat:    (fn) => socketHandlers.set('chat', fn),
  /** Регистрировать ДО login: cb получит ServerBattle, если бой ещё идёт. */
  onBattleResume: (fn) => { resumeCb = fn; },
};

function connectSocket() {
  wireBattleHandlers();
  return new Promise((resolve) => {
    socket = new WebSocket(API.replace('http', 'ws') + '/ws?token=' + token);
    socket.addEventListener('open', resolve);
    socket.addEventListener('message', (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      const h = socketHandlers.get(msg.type);
      if (h) h(msg);
    });
  });
}

function wireBattleHandlers() {
  socketHandlers.set('battleStart', (m) => {
    currentBattle = new ServerBattle(
      { battleId: m.battleId, phase: 'choose', left: m.left, right: m.right });
    if (pendingHunt) { pendingHunt.resolve(currentBattle); pendingHunt = null; }
  });
  socketHandlers.set('battleResume', (m) => {
    // бой уже подхвачен (push и REST-страховка могут прийти оба) — не дублируем
    if (currentBattle && currentBattle.battleId === m.battleId
        && currentBattle.phase !== 'ended') return;
    console.log('battleResume:', m.battleId, 'фаза', m.phase);
    const b = new ServerBattle(
      { battleId: m.battleId, phase: m.phase, left: m.sides.left, right: m.sides.right });
    currentBattle = b;
    if (m.phase === 'choose') {
      b._on('turnStart', { turn: m.turn, timeLeft: m.timeLeft });
    }
    if (resumeCb) resumeCb(b);
  });
  socketHandlers.set('turnStart', (m) =>
    currentBattle && currentBattle._on('turnStart', { turn: m.turn, timeLeft: m.timeLeft }));
  socketHandlers.set('timer', (m) =>
    currentBattle && currentBattle._on('timer', { timeLeft: m.timeLeft }));
  socketHandlers.set('resolve', (m) =>
    currentBattle && currentBattle._on('resolve',
      { turn: m.turn, strikes: m.strikes, passed: m.passed || [], sides: m.sides }));
  socketHandlers.set('battleEnd', (m) =>
    currentBattle && currentBattle._on('battleEnd',
      { winner: m.winner, victory: m.victory, aborted: !!m.aborted,
        reason: m.reason, sides: m.sides, reward: m.reward }));
  socketHandlers.set('error', (m) => {
    if (pendingHunt) { pendingHunt.reject(new Error(m.error)); pendingHunt = null; return; }
    if (currentBattle) currentBattle._on('serverError', { error: m.error });
    else console.warn('Сервер:', m.error);
  });
}

export class ServerBattle extends EventTarget {
  constructor(init) {
    super();
    this.battleId = init.battleId;
    this.phase = init.phase || 'choose';
    this.sides = { left: { ...init.left }, right: { ...init.right } };
    this.active = false;
    this.queue = [];
  }

  static hunt() {
    return new Promise((resolve, reject) => {
      pendingHunt = { resolve, reject };
      socket.send(JSON.stringify({ type: 'hunt' }));
    });
  }

  _applySides(s) {
    if (!s) return;
    this.sides.left.hp = s.left.hp;
    this.sides.right.hp = s.right.hp;
  }

  /** Состояние применяется сразу; события — после activate(). */
  _on(type, detail) {
    if (type === 'turnStart') this.phase = 'choose';
    if (type === 'resolve') {
      this.phase = 'resolving';
      this._applySides(detail.sides);
      detail.sides = this.sides;
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

  /** move: { attack: 'high'|'mid'|'low', block: ..., pass: bool } — как в BattleSystem. */
  submitMove(side, move) {
    const block = move.block ? String(move.block).replace(/^b-/, '') : null;
    socket.send(JSON.stringify(
      { type: 'move', attack: move.attack ?? null, block, pass: !!move.pass }));
    return true;
  }
  finishTurn()    { socket.send(JSON.stringify({ type: 'turnDone' })); }
  /** Покинуть бой: сервер сам спишет Эликсир побега или откажет. */
  requestEscape() { socket.send(JSON.stringify({ type: 'escape' })); }
  destroy()       { if (currentBattle === this) currentBattle = null; }
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
