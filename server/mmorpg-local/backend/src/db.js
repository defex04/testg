import pg from 'pg';
import { createClient } from 'redis';
import { cfg } from './config.js';

export const game = new pg.Pool({ connectionString: cfg.gameDb, max: 10 });
export const auth = new pg.Pool({ connectionString: cfg.authDb, max: 5 });

export const redis = createClient({ url: cfg.redisUrl });
export const redisSub = createClient({ url: cfg.redisUrl }); // отдельное соединение для pub/sub

export async function connectAll() {
  await redis.connect();
  await redisSub.connect();
  await game.query('SELECT 1');
  await auth.query('SELECT 1');
}

/** Транзакция на игровой БД. */
export async function tx(fn) {
  const c = await game.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

let _adminPg = null;
/** Отдельный пул для правки статики (шаблоны): локально — суперпользователь. */
export function adminPg() {
  if (!_adminPg) _adminPg = new pg.Pool({ connectionString: cfg.adminDb, max: 3 });
  return _adminPg;
}

const cfgCache = new Map();
export async function gameConfig(key) {
  if (!cfgCache.has(key)) {
    const { rows } = await game.query('SELECT value FROM game_config WHERE key = $1', [key]);
    cfgCache.set(key, rows[0] ? rows[0].value : null);
  }
  return cfgCache.get(key);
}

export function clearConfigCache() { cfgCache.clear(); }
