// Точная имитация браузера: F5 = обрыв WS + НОВЫЙ dev-вход (новый токен)
// + новое WS-подключение. Затем прерывание боя из админки.
// Запуск: docker exec mmo-api node /app/test-f5.mjs
import WebSocket from 'ws';

const API = 'http://localhost:8080';
const ADMIN = { 'x-admin-key': process.env.ADMIN_PASSWORD || 'admin' };
let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) failed++;
};

async function rest(path, body, token, headers = {}) {
  const r = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(API.replace('http', 'ws') + '/ws?token=' + token);
    const queue = []; const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.types.includes(m.type));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
    });
    ws.on('open', () => resolve({
      ws, send: (o) => ws.send(JSON.stringify(o)),
      wait: (types, ms = 8000) => {
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

const name = 'ИгрокА';   // реальный персонаж пользователя

// --- вход и старт боя ---
const l1 = await rest('/api/auth/dev', { name });
ok(l1.status === 200, 'вход #1', 'char=' + l1.json?.character?.name);
const c1 = await connect(l1.json.token);
const first = await c1.wait(['hello', 'battleResume']);
if (first.type === 'battleResume') {
  // хвост от прошлых проверок — закрываем через админку и входим заново
  await rest(`/admin/api/battles/${first.battleId}/abort`, {}, null, ADMIN);
  await c1.wait(['battleEnd']);
}
c1.send({ type: 'hunt' });
const bs = await c1.wait(['battleStart']);
ok(!!bs.battleId, 'бой начался', 'battleId=' + bs.battleId);
await c1.wait(['turnStart']);

// --- F5: обрыв сокета, новый вход (новый токен!), новое подключение ---
c1.ws.terminate();   // жёсткий обрыв, как закрытие вкладки
const l2 = await rest('/api/auth/dev', { name });
ok(l2.status === 200 && l2.json.token !== l1.json.token, 'вход #2 с новым токеном');
const c2 = await connect(l2.json.token);
const h2 = await c2.wait(['hello']);
ok(h2.type === 'hello', 'hello после реконнекта');
const resume = await c2.wait(['battleResume'], 5000).catch((e) => ({ type: 'нет: ' + e.message }));
ok(resume.type === 'battleResume', 'battleResume после F5',
  'type=' + resume.type + ' phase=' + resume.phase + ' timeLeft=' + resume.timeLeft);

// --- повторный F5 подряд (двойное обновление) ---
c2.ws.terminate();
const l3 = await rest('/api/auth/dev', { name });
const c3 = await connect(l3.json.token);
await c3.wait(['hello']);
const resume2 = await c3.wait(['battleResume'], 5000).catch((e) => ({ type: 'нет: ' + e.message }));
ok(resume2.type === 'battleResume', 'battleResume после второго F5', 'type=' + resume2.type);

// --- REST-страховка: GET /api/battle/current отдаёт идущий бой ---
const cur = await rest('/api/battle/current', undefined, l3.json.token);
ok(cur.status === 200 && Number(cur.json?.battleId) === Number(bs.battleId),
  'GET /api/battle/current видит бой', cur.text.slice(0, 80));

// --- прерывание ТЕКУЩЕГО боя из админки ---
const battles = await rest('/admin/api/battles?status=2', undefined, null, ADMIN);
const active = (battles.json || []).find((b) => Number(b.id) === Number(bs.battleId));
ok(!!active, 'бой виден в админке как активный', 'найдено активных: ' + (battles.json || []).length);
const abort = await rest(`/admin/api/battles/${bs.battleId}/abort`, {}, null, ADMIN);
ok(abort.status === 200 && abort.json?.ok, 'abort прошёл',
  'status=' + abort.status + ' ' + abort.text.slice(0, 80));
const end = await c3.wait(['battleEnd'], 8000).catch((e) => ({ type: 'нет: ' + e.message }));
ok(end.aborted === true, 'игроку пришёл battleEnd(aborted)', JSON.stringify(end).slice(0, 100));
c3.ws.close();

console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
