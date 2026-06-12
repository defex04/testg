import express from 'express';
import http from 'http';
import { connectAll } from './db.js';
import { cfg } from './config.js';
import { authRoutes } from './auth.js';
import { ensureCharacter, characterRoutes } from './characters.js';
import { sessionByToken } from './auth.js';
import { locationRoutes } from './locations.js';
import { inventoryRoutes, grantStarterItems } from './inventory.js';
import { chatRoutes } from './chat.js';
import { createHub } from './ws.js';
import { adminRoutes } from './admin.js';
import { runMigrations } from './migrate.js';
import { battleBoot, battleRoutes } from './battle/manager.js';
import fs from 'fs';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());

// Express 4 не перехватывает reject из async-обработчиков — оборачиваем
// все роуты автоматически, чтобы ошибки доходили до error-middleware.
for (const m of ['get', 'post', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) => {
    if (typeof path !== 'string' || handlers.length === 0) return orig(path, ...handlers);
    return orig(path, ...handlers.map((h) =>
      (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)));
  };
}

// локальная разработка: фронт ходит с другого порта (serve.py / start.bat)
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const authed = async (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  req.session = await sessionByToken(token);
  if (!req.session) return res.status(401).json({ error: 'unauthorized' });
  next();
};

const ensureCharacterWithItems = async (accountId, name) => {
  const ch = await ensureCharacter(accountId, name);
  await grantStarterItems(ch.id);
  return ch;
};

const server = http.createServer(app);
const hub = createHub(server);

authRoutes(app, ensureCharacterWithItems);
characterRoutes(app, authed);
locationRoutes(app, authed, hub);
inventoryRoutes(app, authed);
battleRoutes(app, authed);
chatRoutes(app, authed);
adminRoutes(app);
const pub = fileURLToPath(new URL('../public', import.meta.url));
app.get('/admin', (req, res) => res.sendFile(pub + '/admin.html'));
const uploadsDir = process.env.UPLOADS_DIR || '/app/uploads';
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// обработчик ошибок маршрутов
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal' });
});

await connectAll();
await runMigrations();
await battleBoot();
server.listen(cfg.port, () =>
  console.log(`API на http://localhost:${cfg.port} (dev-вход: POST /api/auth/dev)`));
