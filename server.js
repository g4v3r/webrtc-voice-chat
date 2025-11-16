const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { buildRoomsList } = require('./rooms');
const { attachWsHandlers } = require('./wsHandlers');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  // Ограничиваем максимальный размер одного WS-сообщения (в байтах)
  maxPayload: 64 * 1024,
});

const PORT = process.env.PORT || 3000;

// TURN REST API конфигурация (для выдачи временных кредов клиентам)
const TURN_SECRET = process.env.TURN_SECRET || null; // тот же, что в static-auth-secret coturn
const TURN_REALM = process.env.TURN_REALM || 'example.com';
const TURN_TTL = parseInt(process.env.TURN_TTL || '3600', 10); // секунды
const TURN_URLS = (process.env.TURN_URLS || '')
  .split(',')
  .map((u) => u.trim())
  .filter((u) => u.length > 0);

// Базовая защита HTTP-слоя
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: false, // есть инлайн-скрипты; для продакшена лучше вынести их и включить CSP
  }),
);

// Лимитер для HTTP API (список комнат)
const httpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', httpLimiter);

app.use(express.static(path.join(__dirname, 'public')));

// HTTP-эндпоинт для получения списка комнат (на случай, если клиент ещё не подключил WebSocket)
app.get('/api/rooms', (req, res) => {
  res.json({
    rooms: buildRoomsList(),
  });
});

// HTTP-эндпоинт для получения временных TURN-кредов (TURN REST API)
// Требует соответствующей настройки coturn: use-auth-secret и static-auth-secret=TURN_SECRET
app.get('/api/turn', (req, res) => {
  if (!TURN_SECRET || TURN_URLS.length === 0) {
    // TURN не настроен — просто возвращаем 204 No Content
    return res.status(204).end();
  }

  const now = Math.floor(Date.now() / 1000);
  const username = `${now + TURN_TTL}:anon`; // для REST-схемы реальный user-id неважен

  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');

  res.json({
    urls: TURN_URLS,
    username,
    credential,
    ttl: TURN_TTL,
    realm: TURN_REALM,
  });
});

attachWsHandlers(wss, { allowedOrigin: process.env.ALLOWED_ORIGIN });

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});


