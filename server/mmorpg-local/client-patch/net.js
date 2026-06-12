/**
 * Сетевой адаптер для arena-game: положить в js/net/net.js.
 *
 * ServerBattle повторяет интерфейс BattleSystem (события turnStart / timer /
 * resolve / battleEnd + submitMove / finishTurn), поэтому в main.js меняется
 * минимум: вход, источник PLAYER и замена `new BattleSystem(...)` на сервер.
 * Подробный план стыковки — в README пакета, раздел «Подключение фронта».
 */
// Адрес сервера выбирает игрок на стартовом экране (index.html) —
// выбор кладётся в window.API_URL до загрузки этого модуля.
const API = window.API_URL || 'http://localhost:8080';

let token = sessionStorage.getItem('token');
let socket = null;
const socketHandlers = new Map();

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
  /** Вход: Telegram initData, если открыто в Mini App, иначе dev-вход по имени. */
  async login(devName = 'ИгрокА') {
    const tg = window.Telegram && window.Telegram.WebApp;
    const res = (tg && tg.initData)
      ? await rest('/api/auth/telegram', { initData: tg.initData })
      : await rest('/api/auth/dev', { name: devName });
    token = res.token;
    sessionStorage.setItem('token', token);
    await connectSocket();
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
  sendChat:  (text) => socket && socket.send(JSON.stringify({ type: 'chat', text })),
  onChat:    (fn) => socketHandlers.set('chat', fn),
};

function connectSocket() {
  return new Promise((resolve) => {
    socket = new WebSocket(API.replace('http', 'ws') + '/ws?token=' + token);
    socket.addEventListener('open', resolve);
    socket.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const h = socketHandlers.get(msg.type);
      if (h) h(msg);
    });
  });
}

/** Серверный бой с интерфейсом BattleSystem из js/arena/BattleSystem.js. */
export class ServerBattle extends EventTarget {
  static async hunt() {
    const b = new ServerBattle();
    const started = new Promise((resolve) => {
      socketHandlers.set('battleStart', (m) => { b._init(m); resolve(b); });
    });
    socketHandlers.set('turnStart', (m) =>
      b._emit('turnStart', { turn: m.turn, timeLeft: m.timeLeft }));
    socketHandlers.set('timer', (m) => b._emit('timer', { timeLeft: m.timeLeft }));
    socketHandlers.set('resolve', (m) => {
      b._applySides(m.sides);
      b._emit('resolve', { turn: m.turn, strikes: m.strikes,
        passed: (m.passed || []), sides: b.sides });
    });
    socketHandlers.set('battleEnd', (m) => {
      b.phase = 'ended';
      b._applySides(m.sides);
      b._emit('battleEnd', { winner: m.winner, sides: b.sides, reward: m.reward });
    });
    socket.send(JSON.stringify({ type: 'hunt' }));
    return started;
  }

  _init(m) {
    this.battleId = m.battleId;
    this.sides = {
      left:  { ...m.left,  maxHp: m.left.maxHp,  hp: m.left.hp },
      right: { ...m.right, maxHp: m.right.maxHp, hp: m.right.hp },
    };
    this.phase = 'choose';
  }
  _applySides(s) {
    this.sides.left.hp = s.left.hp;
    this.sides.right.hp = s.right.hp;
  }
  /** move: { attack: 'high'|'mid'|'low', block: ... } — как в BattleSystem. */
  submitMove(side, move) {
    // блок в прототипе приходит с префиксом 'b-' — нормализуем
    const block = move.block ? String(move.block).replace(/^b-/, '') : null;
    socket.send(JSON.stringify({ type: 'move', attack: move.attack, block }));
    return true;
  }
  /** Вызывается оркестратором после анимаций хода — как finishTurn() прототипа. */
  finishTurn() { socket.send(JSON.stringify({ type: 'turnDone' })); }
  destroy()    { socket.send(JSON.stringify({ type: 'leaveBattle' })); }
  start()      {} // бой уже запущен сервером
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
