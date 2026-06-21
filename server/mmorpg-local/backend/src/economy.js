import { randomUUID } from 'crypto';

export const CUR = { copper: 1, silver: 2, gold: 3, diamond: 4, valor: 5 };
const MONEY = [CUR.copper, CUR.silver, CUR.gold];
const BASE = 1000n;

const asBig = (v) => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  return BigInt(String(v ?? 0));
};

function deltaInCopper(currencyId, amount) {
  const n = asBig(amount);
  if (currencyId === CUR.copper) return n;
  if (currencyId === CUR.silver) return n * BASE;
  if (currencyId === CUR.gold) return n * BASE * BASE;
  return null;
}

function splitMoney(total) {
  return {
    [CUR.copper]: total % BASE,
    [CUR.silver]: (total / BASE) % BASE,
    [CUR.gold]: total / (BASE * BASE),
  };
}

async function moneyRowsForUpdate(client, charId) {
  for (const id of MONEY) {
    await client.query(
      `INSERT INTO character_currencies (character_id, currency_id, balance)
       VALUES ($1, $2, 0)
       ON CONFLICT (character_id, currency_id) DO NOTHING`, [charId, id]);
  }
  const { rows } = await client.query(
    `SELECT currency_id, balance
       FROM character_currencies
      WHERE character_id = $1 AND currency_id = ANY($2::int[])
      FOR UPDATE`, [charId, MONEY]);
  return rows;
}

async function setMoneyBalances(client, charId, parts) {
  for (const [currencyId, balance] of Object.entries(parts)) {
    await client.query(
      `UPDATE character_currencies
          SET balance = $3, updated_at = now()
        WHERE character_id = $1 AND currency_id = $2`,
      [charId, Number(currencyId), balance.toString()]);
  }
}

export async function moneyBalanceCopper(client, charId, lock = false) {
  const rows = lock ? await moneyRowsForUpdate(client, charId) : (await client.query(
    `SELECT currency_id, balance
       FROM character_currencies
      WHERE character_id = $1 AND currency_id = ANY($2::int[])`, [charId, MONEY])).rows;
  return rows.reduce((sum, r) => sum + deltaInCopper(Number(r.currency_id), r.balance), 0n);
}

/**
 * Единственный способ изменить деньги: баланс + строка ledger в ОДНОЙ транзакции.
 * client — клиент pg внутри tx(); вызов вне транзакции запрещён по конвенции.
 */
export async function addCurrency(client, charId, currencyId, amount, reason, ref = {}) {
  const key = ref.idempotencyKey || randomUUID();
  const ins = await client.query(
    `INSERT INTO idempotency_keys (key, scope) VALUES ($1, 'currency')
     ON CONFLICT DO NOTHING`, [key]);
  if (ins.rowCount === 0) return null; // повтор — уже выполнено

  const moneyDelta = deltaInCopper(currencyId, amount);
  if (moneyDelta != null) {
    const total = await moneyBalanceCopper(client, charId, true);
    const next = total + moneyDelta;
    if (next < 0n) throw Object.assign(new Error('insufficient_funds'), { status: 400 });
    const parts = splitMoney(next);
    await setMoneyBalances(client, charId, parts);
    const balance = parts[currencyId].toString();
    await client.query(
      `INSERT INTO currency_ledger (idempotency_key, subject_type, subject_id,
         currency_id, amount, balance_after, reason, ref_type, ref_id)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
      [key, charId, currencyId, amount, balance, reason, ref.type ?? null, ref.id ?? null]);
    return balance;
  }

  let rows;
  try {
    ({ rows } = await client.query(
      `INSERT INTO character_currencies (character_id, currency_id, balance)
       VALUES ($1, $2, $3)
       ON CONFLICT (character_id, currency_id)
       DO UPDATE SET balance = character_currencies.balance + $3, updated_at = now()
       RETURNING balance`, [charId, currencyId, amount]));
  } catch (e) {
    // CHECK (balance >= 0): списание уводит баланс в минус — чистая ошибка вместо
    // сырого текста БД (важно для UI: «не хватает денег», а не constraint name)
    if (e.code === '23514') throw Object.assign(new Error('insufficient_funds'), { status: 400 });
    throw e;
  }
  const balance = rows[0].balance;
  if (BigInt(balance) < 0n) throw Object.assign(new Error('insufficient_funds'), { status: 400 });

  await client.query(
    `INSERT INTO currency_ledger (idempotency_key, subject_type, subject_id,
       currency_id, amount, balance_after, reason, ref_type, ref_id)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
    [key, charId, currencyId, amount, balance, reason, ref.type ?? null, ref.id ?? null]);
  return balance;
}

export async function wallet(client, charId) {
  const { rows } = await client.query(
    `SELECT c.id AS currency_id, c.code, COALESCE(cc.balance, 0)::bigint AS balance
       FROM currencies c
       LEFT JOIN character_currencies cc
         ON cc.currency_id = c.id AND cc.character_id = $1
      ORDER BY c.id`, [charId]);
  const out = Object.fromEntries(rows.map(r => [r.code, Number(r.balance)]));
  const total = rows.reduce((sum, r) => sum + (deltaInCopper(Number(r.currency_id), r.balance) ?? 0n), 0n);
  const parts = splitMoney(total);
  out.copper = Number(parts[CUR.copper]);
  out.silver = Number(parts[CUR.silver]);
  out.gold = Number(parts[CUR.gold]);
  return out;
}
