// Сквозная проверка фиксов: экипировка, статы в бою, пропуск хода,
// возврат в бой после реконнекта, прерывание боя из админки.
// Запуск: docker exec mmo-api node /app/test-flows.mjs
import WebSocket from 'ws';

const API = 'http://localhost:8080';
const ADMIN = { 'x-admin-key': process.env.ADMIN_PASSWORD || 'admin' };
let token = null;
let failed = 0;

const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) failed++;
};

async function rest(path, body, headers = {}) {
  const r = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* пусто или не-JSON */ }
  return { status: r.status, json, text };
}

function connect() {
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

// --- вход новым персонажем (заодно проверяет путь создания) ---
const name = 'Тест' + Date.now().toString().slice(-6);
const login = await rest('/api/auth/dev', { name });
ok(login.status === 200 && login.json?.character?.id, 'вход новым персонажем', 'name=' + name);
token = login.json.token;
const baseHp = login.json.character.combat.hp;

// --- инвентарь: доспех со статами ---
let inv = (await rest('/api/inventory')).json;
const armor = inv.find((i) => i.templateId === 101);
ok(!!armor, 'стартовый доспех в инвентаре');
const armorHp = Number(armor?.stats?.hp) || 0;
ok(armorHp > 0, 'у доспеха есть статы', JSON.stringify(armor?.stats));

// --- надеть: ответ должен быть JSON-массивом (раньше было пустое тело) ---
const eq = await rest('/api/inventory/equip', { itemId: armor.id });
ok(eq.status === 200 && Array.isArray(eq.json), 'equip возвращает инвентарь',
  'status=' + eq.status + ' body=' + eq.text.slice(0, 60));
ok(eq.json?.find((i) => i.id === armor.id)?.equipped === true, 'доспех надет');

// --- статы вещи прибавились к персонажу ---
const me = (await rest('/api/me')).json;
ok(me.combat.hp === baseHp + armorHp, `hp персонажа вырос на ${armorHp}`,
  baseHp + ' -> ' + me.combat.hp);
ok(me.combat.crit <= 0.95 && me.combat.dodge <= 0.75,
  'крит/уворот в долях и с потолком',
  `crit=${me.combat.crit} dodge=${me.combat.dodge}`);

// --- бой: hp в бою учитывает экипировку ---
let c1 = await connect();
await c1.wait(['hello']);
c1.send({ type: 'hunt' });
const bs = await c1.wait(['battleStart']);
ok(bs.left.maxHp === baseHp + armorHp, 'maxHp в бою с учётом доспеха',
  'maxHp=' + bs.left.maxHp);
await c1.wait(['turnStart']);

// --- пропуск хода: ход уходит противнику и наступает resolve ---
c1.send({ type: 'move', attack: null, block: 'mid', pass: true });
const rv = await c1.wait(['resolve'], 25000);
ok((rv.passed || []).includes('left'), 'пропуск хода засчитан',
  'passed=' + JSON.stringify(rv.passed));

// --- реконнект (F5): бой возвращается battleResume ---
c1.ws.close();
await new Promise((r) => setTimeout(r, 300));
const c2 = await connect();
await c2.wait(['hello']);
const resume = await c2.wait(['battleResume', 'turnStart'], 10000);
ok(resume.type === 'battleResume', 'после реконнекта бой возвращается',
  'type=' + resume.type + ' battleId=' + resume.battleId);
const battleId = resume.battleId ?? bs.battleId;

// --- прерывание из админки: игроку приходит battleEnd(aborted) ---
const abort = await rest(`/admin/api/battles/${battleId}/abort`, {}, ADMIN);
ok(abort.status === 200 && abort.json?.ok, 'админка прервала бой',
  'status=' + abort.status + ' ' + abort.text.slice(0, 60));
const end = await c2.wait(['battleEnd'], 8000);
ok(end.aborted === true && end.reason === 'admin', 'игрок получил battleEnd(aborted)',
  JSON.stringify({ aborted: end.aborted, reason: end.reason }));
c2.ws.close();

// --- снять: ответ-массив, статы вернулись к базе ---
const uneq = await rest('/api/inventory/unequip', { slot: 1 });
ok(uneq.status === 200 && Array.isArray(uneq.json), 'unequip возвращает инвентарь');
ok(uneq.json?.find((i) => i.id === armor.id)?.equipped === false, 'доспех снят');
const me2 = (await rest('/api/me')).json;
ok(me2.combat.hp === baseHp, 'hp вернулся к базовому', 'hp=' + me2.combat.hp);

console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
