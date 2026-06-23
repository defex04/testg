// Свитки в бою «несколько на несколько» (2 на 2): свиток отравления летит во ВРАЖЕСКОГО
// ИГРОКА (а не в NPC), свиток исцеления — в СОЮЗНОГО игрока, яд тикает по времени.
// (Атрибуцию урона/скальпа источнику проверяет test-effects.mjs на уровне движка.)
// Запуск: docker cp test-nvn-consumables.mjs mmo-api:/app/ && docker exec mmo-api node /app/test-nvn-consumables.mjs
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
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else queue.push(m);
    });
    ws.on('open', () => resolve({
      ws, send: (o) => ws.send(JSON.stringify(o)),
      drainLast: (type) => { let last = null; for (const m of queue) if (m.type === type) last = m; return last; },
      collect: (type) => queue.filter((m) => m.type === type),
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
  return { token: r.json.token, id: String(r.json.character.id), name: n + sfx };
};
const A = await mk('PA'), B = await mk('PB'), C = await mk('PC'), D = await mk('PD');

// A надевает свиток яда (250) и исцеления (260) в пояс (стартовый набор их выдаёт)
await rest('/api/belt/equip', { templateId: 250 }, A.token);
await rest('/api/belt/equip', { templateId: 260 }, A.token);
const beltA = (await rest('/api/belt', undefined, A.token)).json;
const poisonSlot = beltA.findIndex((c) => c && c.templateId === 250);
const healSlot = beltA.findIndex((c) => c && c.templateId === 260);
ok(poisonSlot >= 0 && healSlot >= 0, 'A надел свитки яда и исцеления', `яд=${poisonSlot} лечение=${healSlot}`);

const a = await connect(A.token), b = await connect(B.token), c = await connect(C.token), d = await connect(D.token);
await a.wait(['hello']); await b.wait(['hello']); await c.wait(['hello']); await d.wait(['hello']);

// дуэль A↔B, открываем вмешательство, C за A (left), D за B (right) → 2 на 2
a.send({ type: 'attack', targetId: B.id });
const bs = await a.wait(['battleStart']); await b.wait(['battleStart']);
const battleId = bs.battleId;
await rest(`/admin/api/battles/${battleId}/intervention`, { open: true }, null, ADMIN);
c.send({ type: 'join', battleId, side: 'left' });
const cj = await c.wait(['battleStart', 'error']);
d.send({ type: 'join', battleId, side: 'right' });
const dj = await d.wait(['battleStart', 'error']);
ok(cj.type === 'battleStart' && dj.type === 'battleStart', 'собрали бой 2 на 2 (C за A, D за B)',
  cj.type + '/' + dj.type);

// дать ростеру обновиться у A до 2 врагов справа
let roster = null;
for (let i = 0; i < 30 && !(roster && roster.right && roster.right.length >= 2); i++) {
  const ev = await a.wait(['rosterUpdate', 'turnStart', 'resolve'], 9000).catch(() => null);
  if (ev && ev.roster) roster = ev.roster;
}
const enemies = (roster && roster.right) || [];
ok(enemies.length >= 2, 'у A справа двое вражеских игроков', 'right=' + enemies.length);
const foeId = enemies[0] && enemies[0].id;
const foeHp0 = enemies[0] && enemies[0].hp;

// A травит вражеского игрока (любой ход — расходники доступны всегда)
a.send({ type: 'elixir', slot: poisonSlot, target: foeId });
const pEv = await a.wait(['elixir', 'error'], 9000).catch(() => null);
ok(pEv && pEv.type === 'elixir' && pEv.kind === 'poison' && pEv.targetSide === 'right',
  'свиток яда попал во ВРАЖЕСКОГО игрока (right)', pEv && (pEv.kind + '/' + pEv.targetSide));
ok(pEv && String(pEv.targetId) === String(foeId), 'яд лёг именно на выбранного врага',
  pEv && ('target=' + pEv.targetId + ' foe=' + foeId));

// A лечит СОЮЗНОГО игрока C (он слева)
a.send({ type: 'elixir', slot: healSlot, target: C.id });
const hEv = await a.wait(['elixir', 'error'], 9000).catch(() => null);
ok(hEv && hEv.type === 'elixir' && hEv.kind === 'heal_scroll' && hEv.targetSide === 'left',
  'свиток исцеления — на СОЮЗНОГО игрока (left)', hEv && (hEv.kind + '/' + hEv.targetSide));
ok(hEv && String(hEv.targetName) === String(C.name), 'исцеление адресовано союзнику C',
  hEv && hEv.targetName);

// собираем тики ~7 c, следим за HP отравленного врага (по его id в changed)
let foeMin = Infinity, ticks = 0;
const until = Date.now() + 7000;
while (Date.now() < until) {
  const t = await a.wait(['effectTick', 'turnStart', 'resolve', 'battleEnd'], 4000).catch(() => null);
  if (!t) break;
  if (t.type === 'effectTick') {
    ticks++;
    for (const ch of t.changed || []) if (String(ch.id) === String(foeId) && ch.hp != null) foeMin = Math.min(foeMin, ch.hp);
  } else if (t.type === 'resolve') { a.send({ type: 'turnDone' }); }
  else if (t.type === 'battleEnd') break;
}
ok(ticks > 0, 'тики эффектов идут в бою 2 на 2', 'тиков=' + ticks);
ok(foeMin !== Infinity && foeHp0 != null && foeMin < foeHp0,
  'яд тикает по врагу-игроку в NvN (HP падает)', 'было ' + foeHp0 + ' стало ' + (foeMin === Infinity ? '—' : foeMin));

a.ws.close(); b.ws.close(); c.ws.close(); d.ws.close();
console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки NvN-расходников пройдены');
process.exit(failed ? 1 : 0);
