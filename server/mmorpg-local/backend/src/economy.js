import { randomUUID } from 'crypto';

export const CUR = { copper: 1, silver: 2, gold: 3, diamond: 4, valor: 5 };

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

  const { rows } = await client.query(
    `INSERT INTO character_currencies (character_id, currency_id, balance)
     VALUES ($1, $2, $3)
     ON CONFLICT (character_id, currency_id)
     DO UPDATE SET balance = character_currencies.balance + $3, updated_at = now()
     RETURNING balance`, [charId, currencyId, amount]);
  const balance = rows[0].balance;
  if (BigInt(balance) < 0n) throw new Error('insufficient_funds');

  await client.query(
    `INSERT INTO currency_ledger (idempotency_key, subject_type, subject_id,
       currency_id, amount, balance_after, reason, ref_type, ref_id)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
    [key, charId, currencyId, amount, balance, reason, ref.type ?? null, ref.id ?? null]);
  return balance;
}

export async function wallet(client, charId) {
  const { rows } = await client.query(
    `SELECT c.code, COALESCE(cc.balance, 0)::bigint AS balance
       FROM currencies c
       LEFT JOIN character_currencies cc
         ON cc.currency_id = c.id AND cc.character_id = $1
      ORDER BY c.id`, [charId]);
  return Object.fromEntries(rows.map(r => [r.code, Number(r.balance)]));
}
