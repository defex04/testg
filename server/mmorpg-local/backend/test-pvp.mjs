// Проверка дуэлей PvP: нападение из списка игроков, зеркальные стороны,
// обмен ударами до конца боя, корректные итоги у обоих игроков.
// Запуск: docker exec mmo-api node /app/test-pvp.mjs
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
  let json = null;
  try { json = JSON.parse(text); } catch { /* пусто или не-JSON */ }
  return { status: r.status, json, text };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(API.replace('http', 'ws') + '/ws?token=' + token);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.types.includes(m.type));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else queue.push(m);
    });
    ws.on('open', () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
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

// --- два игрока в одной локации ---
const suffix = Date.now().toString().slice(-6);
const nameA = 'ДуэльА' + suffix;
const nameB = 'ДуэльБ' + suffix;
const loginA = await rest('/api/auth/dev', { name: nameA });
const loginB = await rest('/api/auth/dev', { name: nameB });
ok(loginA.status === 200 && loginB.status === 200, 'вход двумя персонажами');
const tokA = loginA.json.token, tokB = loginB.json.token;
const idA = loginA.json.character.id, idB = loginB.json.character.id;

const a = await connect(tokA);
const b = await connect(tokB);
await a.wait(['hello']);
await b.wait(['hello']);

// --- список игроков локации видит обоих ---
const players = (await rest('/api/locations/players', undefined, tokA)).json;
ok(players.some((p) => String(p.id) === String(idB)),
  'цель видна в списке игроков локации', 'игроков: ' + players.length);

// --- нельзя напасть на себя / на оффлайн ---
a.send({ type: 'attack', targetId: idA });
let err = await a.wait(['error']);
ok(err.error === 'cannot_attack_self', 'нельзя напасть на себя', err.error);
a.send({ type: 'attack', targetId: 999999999 });
err = await a.wait(['error']);
ok(err.error === 'target_offline', 'оффлайн-цель отклоняется', err.error);

// --- нападение: оба получают battleStart, каждый видит себя слева ---
a.send({ type: 'attack', targetId: idB });
const bsA = await a.wait(['battleStart']);
const bsB = await b.wait(['battleStart']);
ok(bsA.battleId === bsB.battleId && bsA.kind === 'pvp', 'дуэль создана у обоих',
  'battleId=' + bsA.battleId);
ok(bsA.left.name === nameA && bsA.right.name === nameB,
  'нападающий видит себя слева', bsA.left.name + ' vs ' + bsA.right.name);
ok(bsB.left.name === nameB && bsB.right.name === nameA,
  'защитник видит себя слева', bsB.left.name + ' vs ' + bsB.right.name);

// --- повторное нападение отклоняется ---
a.send({ type: 'attack', targetId: idB });
err = await a.wait(['error']);
ok(err.error === 'already_in_battle', 'нельзя начать второй бой', err.error);

// --- бой до конца: оба бьют каждый ход ---
await a.wait(['turnStart']);
await b.wait(['turnStart']);
let endA = null, endB = null, turns = 0;
while (!endA && turns < 60) {
  turns++;
  a.send({ type: 'move', attack: 'high', block: 'mid' });
  b.send({ type: 'move', attack: 'mid', block: 'low' });
  const rvA = await a.wait(['resolve'], 25000);
  const rvB = await b.wait(['resolve'], 25000);
  if (turns === 1) {
    const namesOk = rvA.sides.left.name === nameA && rvB.sides.left.name === nameB;
    ok(namesOk, 'resolve зеркален для каждого игрока');
  }
  a.send({ type: 'turnDone' });
  b.send({ type: 'turnDone' });
  const nextA = await a.wait(['turnStart', 'battleEnd'], 25000);
  const nextB = await b.wait(['turnStart', 'battleEnd'], 25000);
  if (nextA.type === 'battleEnd') { endA = nextA; endB = nextB; }
}
ok(!!endA && !!endB, 'бой завершился', 'ходов: ' + turns);
ok(endA.victory !== endB.victory, 'победа ровно у одного',
  JSON.stringify({ a: endA?.victory, b: endB?.victory }));
ok((endA.victory && endA.winner === 'left') || (endB.victory && endB.winner === 'left'),
  'победитель видит winner=left');

// --- итоги боя в окне «Бой #N» ---
const info = (await rest('/api/battles/' + bsA.battleId, undefined, tokA)).json;
ok(info.status === 'finished' && info.results.length === 2,
  'итоги: оба участника в таблице',
  JSON.stringify(info.results?.map((r) => [r.name, r.result])));

// --- после боя можно начать новый (байты live-состояния очищены) ---
a.send({ type: 'hunt' });
const hunt = await a.wait(['battleStart']);
ok(hunt.kind === 'hunt' && hunt.battleId !== bsA.battleId, 'после дуэли охота доступна');

a.ws.close();
b.ws.close();
console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
