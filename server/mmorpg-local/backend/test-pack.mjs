// Живой smoke-тест «Шайки разбойников» (групповая охота): старт против 3 бандитов,
// за ротацию срабатывают все три роли (отравитель/лекарь/громила) как события elixir.
// Полный путь: ws hunt(npc=2) → startHunt пачка → applyAiElixirs роли.
// Запуск: docker exec mmo-api node /app/test-pack.mjs
import WebSocket from 'ws';

const API = 'http://localhost:8080';
let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) failed++;
};

async function rest(path, body, token) {
  const r = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = JSON.parse(await r.text()); } catch { /* */ }
  return { status: r.status, json };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(API.replace('http', 'ws') + '/ws?token=' + token);
    const queue = [], waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.types.includes(m.type));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else queue.push(m);
    });
    ws.on('open', () => resolve({
      ws, send: (o) => ws.send(JSON.stringify(o)),
      poll: (types) => {
        const i = queue.findIndex((m) => types.includes(m.type));
        return i >= 0 ? queue.splice(i, 1)[0] : null;
      },
      wait: (types, ms = 9000) => {
        const i = queue.findIndex((m) => types.includes(m.type));
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout: ' + types)), ms);
          waiters.push({ types, resolve: (m) => { clearTimeout(t); res(m); } });
        });
      },
    }));
    ws.on('error', reject);
  });
}

const sfx = Date.now().toString().slice(-6);
const R = await rest('/api/auth/dev', { name: 'Pack' + sfx });
const token = R.json.token;
const conn = await connect(token);
await conn.wait(['hello']);

// --- старт охоты на шайку (npc=2) ---
conn.send({ type: 'hunt', npc: 2 });
const bs = await conn.wait(['battleStart', 'error'], 9000);
ok(bs.type === 'battleStart' && bs.kind === 'hunt', 'охота на шайку началась',
  bs.type === 'error' ? bs.error : 'battleId=' + bs.battleId);
const right = (bs.roster && bs.roster.right) || [];
ok(right.length === 3, 'против ИГРОКА — 3 бандита', 'состав=' + right.map((f) => f.name).join(', '));
ok(right.every((f) => f.maxHp === 900), 'у каждого бандита 900 HP',
  'hp=' + right.map((f) => f.maxHp).join('/'));

// --- гоняем бой; собираем роли бандитов из событий elixir (яд/лечение/мощь) ---
const roles = { poison: false, health: false, power: false };
let poisonedSelf = false, ended = false;
const t0 = Date.now();
for (let i = 0; i < 60 && !ended && Date.now() - t0 < 70000; i++) {
  let ev;
  while ((ev = conn.poll(['turnStart', 'resolve', 'elixir', 'effectTick', 'battleEnd']))) {
    if (ev.type === 'battleEnd') { ended = true; break; }
    if (ev.type === 'elixir') {
      if (ev.kind && roles[ev.kind] !== undefined) roles[ev.kind] = true;
      if (ev.kind === 'poison' && ev.onSelf) poisonedSelf = true;   // яд лёг на игрока
    } else if (ev.type === 'turnStart') {
      if (ev.canAct) conn.send({ type: 'move', attack: 'high', block: 'mid' });
    } else if (ev.type === 'resolve') {
      conn.send({ type: 'turnDone' });
    }
  }
  if (roles.poison && roles.health && roles.power) break;
  await new Promise((r) => setTimeout(r, 120));
}

ok(roles.poison, 'отравитель травит игрока (elixir kind=poison)');
ok(poisonedSelf, 'яд лёг ИМЕННО на игрока (onSelf)');
ok(roles.power, 'громила бьёт мощью (elixir kind=power)');
ok(roles.health, 'лекарь лечит союзников (elixir kind=health)');

conn.send({ type: 'escape' });   // не доводим до конца — выходим (если есть эликсир побега, иначе бросит)
conn.ws.close();
console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки шайки пройдены');
process.exit(failed ? 1 : 0);
