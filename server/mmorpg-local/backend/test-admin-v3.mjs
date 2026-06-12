// Проверка новых админ-ручек: rename, item delete, account delete, привязка
// аккаунтов к персонажам. Запуск: node test-admin-v3.mjs (локальный стек).
const API = 'http://localhost:8080';
const KEY = process.env.ADMIN_PASSWORD || 'admin';
let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label + (extra ? ' | ' + extra : ''));
  if (!cond) failed++;
};
const admin = async (path, body) => {
  const r = await fetch(API + '/admin/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const dev = async (name) => (await (await fetch(API + '/api/auth/dev', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name }),
})).json());

// два свежих игрока
const u1 = await dev('ТестРенейм' + Date.now() % 100000);
const u2 = await dev('ТестУдал' + Date.now() % 100000);
const id1 = Number(u1.character.id), id2 = Number(u2.character.id);

// список персонажей: есть привязка к аккаунту
const list = await admin('/characters?q=' + encodeURIComponent(u1.character.name));
ok(list.status === 200 && list.json[0] && 'provider' in list.json[0]
  && 'tg_username' in list.json[0], 'characters: поля аккаунта', JSON.stringify(list.json[0]?.provider));

// карточка: блок account
const card = await admin('/characters/' + id1);
ok(card.json.account && Number(card.json.account.id) === Number(card.json.character.account_id),
  'карточка: аккаунт привязан', 'acc #' + card.json.account?.id);

// rename: успех
const newName = 'Переимен' + Date.now() % 100000;
const rn = await admin(`/characters/${id1}/rename`, { name: newName });
ok(rn.status === 200, 'rename ok');
const after = await admin('/characters/' + id1);
ok(after.json.character.name === newName, 'имя сменилось', after.json.character.name);

// rename: занято и коротко
const taken = await admin(`/characters/${id1}/rename`, { name: u2.character.name });
ok(taken.status === 409 && taken.json.error === 'name_taken', 'rename: имя занято');
const short = await admin(`/characters/${id1}/rename`, { name: 'й' });
ok(short.status === 400, 'rename: короткое имя');

// удаление предмета: у игрока есть стартовый доспех
const inv = card.json.inventory;
ok(inv.length > 0, 'есть предмет для удаления', inv[0]?.name);
const del = await admin(`/item-instances/${inv[0].id}/delete`, { note: 'test' });
ok(del.status === 200, 'item delete ok');
const inv2 = (await admin('/characters/' + id1)).json.inventory;
ok(!inv2.find((i) => i.id === inv[0].id), 'предмет пропал из рюкзака');
const del2 = await admin(`/item-instances/${inv[0].id}/delete`, {});
ok(del2.status === 404, 'повторное удаление: 404');

// удаление аккаунта u2
const accId = Number(u2.character.account_id ?? (await admin('/characters/' + id2)).json.character.account_id);
const ad = await admin(`/accounts/${accId}/delete`, {});
ok(ad.status === 200, 'account delete ok', 'персонажей: ' + ad.json?.characters);
const again = await admin(`/accounts/${accId}/delete`, {});
ok(again.status === 400 && again.json.error === 'already_deleted', 'повторно: already_deleted');

// токен удалённого отозван, персонаж скрыт из списка
const me = await fetch(API + '/api/me', { headers: { Authorization: 'Bearer ' + u2.token } });
ok(me.status === 401, 'сессия удалённого отозвана', String(me.status));
const gone = await admin('/characters?q=' + encodeURIComponent(u2.character.name));
ok(!gone.json.find((c) => Number(c.id) === id2), 'персонаж скрыт из списка');

// вход на удалённый аккаунт запрещён
const relogin = await fetch(API + '/api/auth/dev', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: u2.character.name }),
});
ok(relogin.status === 403, 'повторный вход удалённого: 403', String(relogin.status));

// аккаунты: персонажи отдаются массивом с id
const accs = await admin('/accounts');
const a1 = accs.json.find((a) => Number(a.id) === Number(card.json.account.id));
ok(Array.isArray(a1?.characters) && a1.characters[0].id, 'accounts: персонажи с id');

console.log(failed ? 'FAILED: ' + failed : 'ALL OK');
process.exit(failed ? 1 : 0);
