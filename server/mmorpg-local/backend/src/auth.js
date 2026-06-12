import crypto from 'crypto';
import { auth, game } from './db.js';
import { cfg } from './config.js';

/** Проверка подписи Telegram initData (HMAC по схеме WebApp). */
export function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(cfg.botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc !== hash) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (Date.now() / 1000 - authDate > 86400) return null;       // протух
  return JSON.parse(params.get('user') || 'null');
}

async function ensureAccount(provider, externalId, profile) {
  const found = await auth.query(
    `SELECT account_id FROM account_identities WHERE provider = $1 AND external_id = $2`,
    [provider, externalId]);
  if (found.rows[0]) return found.rows[0].account_id;

  const c = await auth.connect();
  try {
    await c.query('BEGIN');
    const acc = await c.query(`INSERT INTO accounts (status) VALUES (1) RETURNING id`);
    const accountId = acc.rows[0].id;
    await c.query(
      `INSERT INTO account_identities (account_id, provider, external_id, raw_profile)
       VALUES ($1, $2, $3, $4)`, [accountId, provider, externalId, profile]);
    if (provider === 1) {
      await c.query(
        `INSERT INTO telegram_profiles (account_id, tg_user_id, username, first_name, language_code, last_auth_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (account_id) DO UPDATE SET last_auth_at = now()`,
        [accountId, Number(externalId), profile.username ?? null,
         profile.first_name ?? null, profile.language_code ?? null]);
    }
    await c.query('COMMIT');
    return accountId;
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}

export async function createSession(accountId, characterId, platform) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await auth.query(
    `INSERT INTO sessions (token_hash, account_id, character_id, platform, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
    [tokenHash, accountId, characterId, platform]);
  return token;
}

export async function sessionByToken(token) {
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await auth.query(
    `SELECT account_id, character_id FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`, [tokenHash]);
  return rows[0] || null;
}

/** Replay-защита initData. */
async function nonceOnce(initData) {
  const h = crypto.createHash('sha256').update(initData).digest('hex');
  const r = await auth.query(
    `INSERT INTO auth_nonces (init_data_hash, auth_date)
     VALUES ($1, now()) ON CONFLICT DO NOTHING`, [h]);
  return r.rowCount === 1;
}

/** Активный бан или заморозка аккаунта не пускают в игру. */
async function assertNotBanned(accountId) {
  const { rows } = await auth.query(
    `SELECT a.status,
            EXISTS (SELECT 1 FROM account_sanctions s
                     WHERE s.account_id = a.id AND s.type = 1
                       AND s.revoked_at IS NULL AND s.starts_at <= now()
                       AND (s.ends_at IS NULL OR s.ends_at > now())) AS banned
       FROM accounts a WHERE a.id = $1`, [accountId]);
  if (!rows[0] || rows[0].status !== 1 || rows[0].banned) {
    throw Object.assign(new Error('banned'), { status: 403 });
  }
}

export function authRoutes(app, ensureCharacter) {
  // Вход через Telegram Mini App
  app.post('/api/auth/telegram', async (req, res) => {
    if (!cfg.botToken) return res.status(503).json({ error: 'bot_token_not_configured' });
    const { initData } = req.body || {};
    const user = initData && verifyInitData(initData);
    if (!user) return res.status(401).json({ error: 'bad_signature' });
    if (!await nonceOnce(initData)) return res.status(401).json({ error: 'replay' });
    const accountId = await ensureAccount(1, String(user.id), user);
    await assertNotBanned(accountId);
    const ch = await ensureCharacter(accountId, user.first_name || user.username || 'Безымянный');
    const token = await createSession(accountId, ch.id, 1);
    res.json({ token, character: ch });
  });

  // Локальный вход для разработки (без Telegram)
  app.post('/api/auth/dev', async (req, res) => {
    if (!cfg.devAuth) return res.status(403).json({ error: 'dev_auth_disabled' });
    const name = (req.body && req.body.name || 'ИгрокА').trim().slice(0, 24);
    const accountId = await ensureAccount(99, 'dev:' + name.toLowerCase(), { name });
    await assertNotBanned(accountId);
    const ch = await ensureCharacter(accountId, name);
    const token = await createSession(accountId, ch.id, 2);
    res.json({ token, character: ch });
  });
}
