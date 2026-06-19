// Проверка командного боя (NvN): отсутствие «двойного хода» в дуэли,
// открытие вмешательства из админки, вход третьего игрока (2 на 1),
// переключение соперника и плашка «ожидание соперника».
// Запуск: docker exec mmo-api node /app/test-nvn.mjs
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
    const queue = [], waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.types.includes(m.type));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else queue.push(m);
    });
    ws.on('open', () => resolve({
      ws, send: (o) => ws.send(JSON.stringify(o)),
      drain: (type) => queue.filter((m) => m.type === type),
      // неблокирующе забрать первое накопленное событие нужного типа (или null)
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
const mk = async (n) => {
  const r = await rest('/api/auth/dev', { name: n + sfx });
  return { token: r.json.token, id: r.json.character.id, name: n + sfx };
};
const A = await mk('NvA'), B = await mk('NvB'), C = await mk('NvC');
const a = await connect(A.token), b = await connect(B.token), c = await connect(C.token);
await a.wait(['hello']); await b.wait(['hello']); await c.wait(['hello']);

// --- дуэль A vs B ---
a.send({ type: 'attack', targetId: B.id });
const bs = await a.wait(['battleStart']);
await b.wait(['battleStart']);
ok(bs.kind === 'pvp', 'дуэль создана', 'battleId=' + bs.battleId);
const battleId = bs.battleId;

// --- НЕТ «двойного хода»: active строго чередуется l/r/l/r ---
const seq = [];
let steps = 0, ended = false;
while (seq.length < 6 && steps < 40 && !ended) {
  steps++;
  const ts = await a.wait(['turnStart', 'battleEnd'], 25000);
  if (ts.type === 'battleEnd') { ended = true; break; }
  seq.push(ts.canAct ? 'A' : 'B');
  // активный ходит, оба доигрывают
  const actor = ts.canAct ? a : b;
  await b.wait(['turnStart'], 25000).catch(() => {});
  actor.send({ type: 'move', attack: 'high', block: 'mid' });
  await a.wait(['resolve'], 25000); await b.wait(['resolve'], 25000);
  a.send({ type: 'turnDone' }); b.send({ type: 'turnDone' });
}
let alternates = true;
for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) alternates = false;
ok(alternates && seq.length >= 4, 'ход чередуется, никто не бьёт дважды подряд',
  'seq=' + seq.join(''));

if (!ended) {
  // --- админка: открыть вмешательство в этот бой ---
  const opn = await rest(`/admin/api/battles/${battleId}/intervention`, { open: true },
    null, ADMIN);
  ok(opn.status === 200 && opn.json.intervention === 'open',
    'админка открыла вмешательство', JSON.stringify(opn.json));

  // --- окно боя показывает, что можно вмешаться ---
  const info = (await rest('/api/battles/' + battleId, undefined, C.token)).json;
  ok(info.allowJoin === true, 'окно боя: вмешательство разрешено',
    'intervention=' + info.intervention);

  // --- C вмешивается за сторону B (right) → 2 на 1 ---
  c.send({ type: 'join', battleId, side: 'right' });
  const cs = await c.wait(['battleStart', 'error'], 9000);
  ok(cs.type === 'battleStart', 'C вошёл в бой', cs.type === 'error' ? cs.error : 'ok');
  // зеркалирование: своя команда — слева. У C своя сторона (B+C) = 2 слева,
  // один враг (A) — справа.
  ok(cs.roster && cs.roster.left.length === 2 && cs.roster.right.length === 1,
    'у стороны C теперь 2 бойца (своя слева), 1 враг справа',
    'left=' + (cs.roster ? cs.roster.left.length : '?')
    + ' right=' + (cs.roster ? cs.roster.right.length : '?'));

  // A видит, что врагов стало двое — ждём именно rosterUpdate (его шлёт join
  // всем, кроме вошедшего); turnStart/resolve в очереди могут быть «дожоиновые»
  const aRoster = await a.wait(['rosterUpdate'], 9000);
  ok(aRoster.roster && aRoster.roster.right.length === 2,
    'A видит двух соперников', 'right=' + (aRoster.roster ? aRoster.roster.right.length : '?'));

  // --- 2-на-1: ровный «насос» событий гоняет бой, пока A не увидит обоих
  //     соперников в фокусе либо бой не закончится. Фокус A на СВОЁМ ходу теперь
  //     стабилен (один соперник), но смена видна, когда активен/бьёт другой враг:
  //     turnStart активного врага и resolve по A несут его как focus. ---
  let sawWaiting = false;
  const fociA = new Set();
  const pump = (conn) => {
    let ev, ended = false;
    while ((ev = conn.poll(['turnStart', 'resolve', 'battleEnd']))) {
      if (ev.type === 'battleEnd') { ended = true; continue; }
      if (conn === a && ev.focus) fociA.add(ev.focus.name);
      if (ev.type === 'turnStart') {
        if (ev.waiting) sawWaiting = true;
        if (ev.canAct) conn.send({ type: 'move', attack: 'high', block: 'mid' });
      } else if (ev.type === 'resolve') {
        conn.send({ type: 'turnDone' });
      }
    }
    return ended;
  };
  let ended = false;
  for (let i = 0; i < 80 && !ended && fociA.size < 2; i++) {
    const ea = pump(a), eb = pump(b), ec = pump(c);
    ended = ea || eb || ec;
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(sawWaiting, 'появлялась плашка «ожидание соперника» (waiting=true)');
  ok(fociA.size >= 2, 'A видит переключение между двумя соперниками',
    'фокусы=' + [...fociA].join(','));
}

a.ws.close(); b.ws.close(); c.ws.close();
console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
