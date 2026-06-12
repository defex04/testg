export const cfg = {
  port: process.env.PORT || 8080,
  gameDb:  process.env.GAME_DB  || 'postgres://game_rw:game_rw_dev@postgres:5432/mmo_game',
  authDb:  process.env.AUTH_DB  || 'postgres://auth_svc:auth_svc_dev@postgres:5432/mmo_auth',
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',
  botToken: process.env.BOT_TOKEN || '',     // пусто = вход только /api/auth/dev
  devAuth:  process.env.DEV_AUTH !== '0',    // локальный вход без Telegram
  adminPassword: process.env.ADMIN_PASSWORD || '',   // пусто = админка выключена
  adminDb: process.env.ADMIN_DB              // правка шаблонов: отдельная роль,
    || 'postgres://postgres:postgres@postgres:5432/mmo_game', // локально — суперюзер
};
