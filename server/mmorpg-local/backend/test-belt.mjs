// Авторитетный пояс эликсиров: сервер помнит состав пояса (переживает новый
// вход), кладёт только эликсиры, и при использовании в бою РЕАЛЬНО списывает
// заряд из инвентаря. Запуск: docker exec mmo-api node /app/test-belt.mjs
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
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(API.replace('http', 'ws') + '/ws?token=' + token);
    const queue = [], waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.types.includes(m.type));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
    });
    ws.on('open', () => resolve({
      ws, send: (o) => ws.send(JSON.stringify(o)),
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

const name = 'Belt' + Date.now().toString().slice(-6);
const A = (await rest('/api/auth/dev', { name })).json;
const token = A.token;

// 1) стартовые эликсиры выданы
const inv0 = (await rest('/api/inventory', undefined, token)).json;
const health0 = inv0.find((i) => i.templateId === 202);
ok(health0 && health0.quantity >= 1, 'выданы стартовые эликсиры здоровья', 'qty=' + (health0 && health0.quantity));

// 2) пояс изначально пуст
let belt = (await rest('/api/belt', undefined, token)).json;
ok(Array.isArray(belt) && belt.every((s) => s === null), 'пояс изначально пуст');

// 3) кладём эликсир здоровья в слот 0
belt = (await rest('/api/belt/equip', { slot: 0, templateId: 202 }, token)).json;
ok(belt[0] && belt[0].templateId === 202 && belt[0].kind === 'health' && belt[0].qty >= 1,
  'эликсир здоровья в слоте 0', JSON.stringify(belt[0]));

// 4) состав пояса ПОМНИТСЯ после нового входа тем же именем (тот же аккаунт)
const A2 = (await rest('/api/auth/dev', { name })).json;
const belt2 = (await rest('/api/belt', undefined, A2.token)).json;
ok(belt2[0] && belt2[0].templateId === 202, 'сервер помнит пояс после нового входа');

// 5) не-эликсир (бронзовый доспех 101) в пояс не кладётся
const bad = await rest('/api/belt/equip', { slot: 1, templateId: 101 }, token);
ok(bad.status >= 400, 'не-эликсир в пояс нельзя', bad.json && bad.json.error);

// 6) использование в бою РЕАЛЬНО списывает заряд
const a = await connect(token); await a.wait(['hello']);
a.send({ type: 'hunt' });
await a.wait(['battleStart']);
let used = false, slotQtyAfter = null;
for (let i = 0; i < 14 && !used; i++) {
  const ev = await a.wait(['turnStart', 'resolve', 'battleEnd'], 20000).catch(() => null);
  if (!ev || ev.type === 'battleEnd') break;
  if (ev.type === 'resolve') { a.send({ type: 'turnDone' }); continue; }
  if (ev.canAct) {
    a.send({ type: 'elixir', slot: 0 });
    const el = await a.wait(['elixir'], 9000).catch(() => null);
    if (el) { used = true; slotQtyAfter = el.slotQty; }
  }
}
ok(used, 'эликсир применён в свой ход (бой)');
const invA = (await rest('/api/inventory', undefined, token)).json;
const healthA = invA.find((i) => i.templateId === 202);
const left = healthA ? healthA.quantity : 0;
ok(left === health0.quantity - 1,
  'заряд списан из инвентаря (−1)', 'было ' + health0.quantity + ' стало ' + left);
// в ячейку положили 1 заряд (slot 0) → после использования она пустеет (остаток 0).
// slotQty — остаток в ЯЧЕЙКЕ пояса, не в рюкзаке (per-charge модель).
ok(slotQtyAfter === 0,
  'клиенту пришёл новый остаток ячейки (1 заряд → пусто)', 'slotQty=' + slotQtyAfter);

// 7) пустую ячейку выпить нельзя
a.send({ type: 'elixir', slot: 5 });
const e7 = await a.wait(['error', 'elixir'], 5000).catch(() => null);
ok(e7 && e7.type === 'error' && e7.error === 'belt_empty', 'пустую ячейку выпить нельзя',
  e7 ? (e7.type + ':' + (e7.error || '')) : 'нет ответа');

a.ws.close();
console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пояса пройдены');
process.exit(failed ? 1 : 0);
