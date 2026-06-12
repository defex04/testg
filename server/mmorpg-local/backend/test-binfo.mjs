// Проверка объявления боя в чате и окна информации о бое.
// Запуск: docker exec mmo-api node /app/test-binfo.mjs
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
      const i = waiters.findIndex((w) => w.types.includes(m.type) && (!w.test || w.test(m)));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
    });
    ws.on('open', () => resolve({
      ws, send: (o) => ws.send(JSON.stringify(o)),
      wait: (types, ms = 8000, test = null) => {
        const i = queue.findIndex((m) => types.includes(m.type) && (!test || test(m)));
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout: ' + types)), ms);
          waiters.push({ types, test, resolve: (m) => { clearTimeout(t); res(m); } });
        });
      },
    }));
    ws.on('error', reject);
  });
}

const name = 'Тест' + Date.now().toString().slice(-6);
const l = await rest('/api/auth/dev', { name });
const token = l.json.token;
const c = await connect(token);
await c.wait(['hello']);

// --- старт боя → системное сообщение с «Бой #N» в чате ---
c.send({ type: 'hunt' });
const bs = await c.wait(['battleStart']);
const announce = await c.wait(['chat'], 5000,
  (m) => /Бой #\d+/.test(m.text || '')).catch(() => null);
ok(!!announce, 'объявление боя пришло в чат', announce && announce.from + ': ' + announce.text);
ok(announce && announce.text.includes(`Бой #${bs.battleId}`), 'в тексте номер боя');

// --- объявление сохранилось в истории чата ---
const hist = await rest('/api/chat/history', undefined, token);
ok((hist.json || []).some((h) => (h.body || '').includes(`Бой #${bs.battleId}`)),
  'объявление есть в истории чата');

// --- окно идущего боя: команды с hp/mp ---
const liveInfo = await rest('/api/battles/' + bs.battleId, undefined, token);
ok(liveInfo.status === 200 && liveInfo.json.status === 'active', 'идущий бой: status=active');
const L = liveInfo.json.teams?.left?.[0], R = liveInfo.json.teams?.right?.[0];
ok(L && L.hp > 0 && L.maxHp > 0 && 'mp' in L, 'у игрока есть hp и mp',
  JSON.stringify(L));
ok(R && R.hp > 0 && 'mp' in R, 'у противника есть hp и mp', JSON.stringify(R));

// --- бой завершается (поддаёмся: пропускаем ходы до конца) ---
await c.wait(['turnStart']);
for (let i = 0; i < 30; i++) {
  c.send({ type: 'move', attack: null, block: null, pass: true });
  const m = await c.wait(['battleEnd', 'resolve'], 30000);
  if (m.type === 'battleEnd') break;
  c.send({ type: 'turnDone' });
  const n = await c.wait(['battleEnd', 'turnStart'], 30000);
  if (n.type === 'battleEnd') break;
}

// --- окно завершённого боя: урон, убийства, смерти, опыт ---
const fin = await rest('/api/battles/' + bs.battleId, undefined, token);
ok(fin.json.status === 'finished', 'завершённый бой: status=finished', fin.text.slice(0, 60));
const me = (fin.json.results || []).find((r) => r.name === name);
const npc = (fin.json.results || []).find((r) => r.name !== name);
ok(me && me.deaths === 1 && me.kills === 0, 'итоги игрока: смерть и 0 убийств',
  JSON.stringify(me));
ok(npc && npc.damage > 0 && npc.kills === 1, 'итоги NPC: урон и убийство',
  JSON.stringify(npc));
ok(me && typeof me.exp === 'number', 'опыт в итогах', 'exp=' + (me && me.exp));
c.ws.close();

console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
