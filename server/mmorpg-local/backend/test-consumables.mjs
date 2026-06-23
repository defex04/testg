// Интеграция новой системы расходников: уровневый гейт магазина + боевой свиток
// отравления (DoT по времени тикает на сервере) + тайм-аут свитка.
// Запуск: docker cp test-consumables.mjs mmo-api:/app/ && docker exec mmo-api node /app/test-consumables.mjs
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

const name = 'Cons' + Date.now().toString().slice(-6);
const A = (await rest('/api/auth/dev', { name })).json;
const token = A.token;
const lvl = A.character.level;
ok(lvl === 1, 'свежий персонаж 1 уровня', 'lvl=' + lvl);

// --- Магазин: список всех категорий + уровневый доступ ---
const shop = (await rest('/api/shop', undefined, token)).json;
ok(shop && shop.charLevel === 1, 'магазин отдаёт уровень игрока', 'charLevel=' + (shop && shop.charLevel));
ok(shop && shop.items.length >= 30, 'в магазине все категории расходников', 'items=' + (shop && shop.items.length));
const purple = shop.items.find((i) => i.templateId === 213);   // Большой эликсир жизни, ур.10
ok(purple && purple.levelReq === 10 && purple.quality === 4, 'фиолетовый товар с ур.10/q4', JSON.stringify(purple && { l: purple.levelReq, q: purple.quality }));

// купить фиолетовый на 1 уровне НЕЛЬЗЯ (гейт срабатывает до списания денег)
const buyHigh = await rest('/api/shop/buy', { templateId: 213, quantity: 1 }, token);
ok(buyHigh.status === 403 && buyHigh.json.error === 'level_too_low',
  'покупка не по уровню отклонена (level_too_low)', buyHigh.status + ' ' + (buyHigh.json && buyHigh.json.error));

// серый (ур.1) гейт проходит (дальше может не хватить денег — это не про уровень)
const buyGray = await rest('/api/shop/buy', { templateId: 250, quantity: 1 }, token);
ok(buyGray.json && buyGray.json.error !== 'level_too_low',
  'серый товар уровнем не блокируется', 'res=' + (buyGray.json && (buyGray.json.error || 'ok')));

// --- Боевой свиток отравления: DoT тикает по времени, есть тайм-аут ---
// в стартовом наборе есть Слабый свиток отравления (250) ×2 — кладём 2 заряда в пояс
await rest('/api/belt/equip', { templateId: 250 }, token);
await rest('/api/belt/equip', { templateId: 250 }, token);
const belt = (await rest('/api/belt', undefined, token)).json;
const poisonSlots = belt.map((c, i) => (c && c.templateId === 250 ? i : -1)).filter((i) => i >= 0);
ok(poisonSlots.length >= 2, 'два заряда свитка яда в поясе', 'слоты=' + poisonSlots.join(','));
// эликсир жизни в пояс (2 заряда: первый выпьем, второй упрётся в elixir_active)
await rest('/api/belt/equip', { templateId: 202 }, token);
await rest('/api/belt/equip', { templateId: 202 }, token);
const belt2 = (await rest('/api/belt', undefined, token)).json;
const healthSlot = belt2.findIndex((c) => c && c.templateId === 202);

const a = await connect(token); await a.wait(['hello']).catch(() => null);
a.send({ type: 'hunt' });
await a.wait(['battleStart']);

let cast = null, cooldownErr = null, healCast = null, elixActive = null;
let npcStartHp = null, npcMinHp = Infinity;
for (let i = 0; i < 16 && !cast; i++) {
  const ev = await a.wait(['turnStart', 'resolve', 'battleEnd'], 22000).catch(() => null);
  if (!ev || ev.type === 'battleEnd') break;
  if (ev.type === 'resolve') { a.send({ type: 'turnDone' }); continue; }
  if (!ev.canAct) continue;
  const foe = (ev.targets && ev.targets[0]) || ev.focus;
  npcStartHp = foe && foe.hp;
  // эликсир жизни на себя — применяется; повторно сразу — нельзя (эффект уже активен)
  a.send({ type: 'elixir', slot: healthSlot });
  healCast = await a.wait(['elixir', 'error'], 9000).catch(() => null);
  a.send({ type: 'elixir', slot: healthSlot });
  elixActive = await a.wait(['error', 'elixir'], 9000).catch(() => null);
  // 1-й свиток — на врага: должен примениться (яд)
  a.send({ type: 'elixir', slot: poisonSlots[0], target: foe && foe.id });
  cast = await a.wait(['elixir', 'error'], 9000).catch(() => null);
  // 2-й свиток того же вида сразу — тайм-аут (on_cooldown)
  a.send({ type: 'elixir', slot: poisonSlots[1], target: foe && foe.id });
  cooldownErr = await a.wait(['error', 'elixir'], 9000).catch(() => null);
  // собираем тики эффектов ~6 c, следим за HP отравленного врага
  const until = Date.now() + 6500;
  while (Date.now() < until) {
    const t = await a.wait(['effectTick', 'turnStart', 'resolve', 'battleEnd'], 4000).catch(() => null);
    if (!t) break;
    if (t.type === 'effectTick') {
      for (const c of t.changed || []) if (c.side === 'right') npcMinHp = Math.min(npcMinHp, c.hp);
    } else if (t.type === 'resolve') { a.send({ type: 'turnDone' }); }
    else if (t.type === 'battleEnd') break;
  }
}

ok(healCast && healCast.type === 'elixir' && healCast.kind === 'health',
  'эликсир жизни применён', healCast && (healCast.kind || healCast.error));
ok(elixActive && elixActive.type === 'error' && elixActive.error === 'elixir_active',
  'повторный эликсир того же вида отклонён (elixir_active)', elixActive && (elixActive.error || elixActive.type));
ok(cast && cast.type === 'elixir' && cast.kind === 'poison',
  'свиток отравления применён на врага', cast && (cast.kind || cast.error));
ok(cast && cast.targetSide === 'right',
  'яд лёг на сторону врага (right)', cast && cast.targetSide);
ok(cooldownErr && cooldownErr.type === 'error' && cooldownErr.error === 'on_cooldown',
  'повторный свиток отклонён по тайм-ауту (on_cooldown)', cooldownErr && (cooldownErr.error || cooldownErr.type));
ok(npcStartHp != null && npcMinHp < npcStartHp,
  'яд тикает по времени — HP врага падает', 'было ' + npcStartHp + ' стало ' + (npcMinHp === Infinity ? '—' : npcMinHp));

a.ws.close();
console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки расходников пройдены');
process.exit(failed ? 1 : 0);
