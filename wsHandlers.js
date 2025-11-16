const {
  MAX_PEERS_PER_ROOM,
  MAX_MESSAGES_PER_MINUTE,
  rooms,
  clients,
  allocClientId,
  broadcastRoomState,
  buildRoomsList,
  broadcastRoomsList,
} = require('./rooms');

function sanitizeString(value, maxLen, allowEmpty = false) {
  if (typeof value !== 'string') return null;
  let v = value.trim();
  if (!allowEmpty && v.length === 0) return null;
  if (v.length > maxLen) {
    v = v.slice(0, maxLen);
  }
  return v;
}

function attachWsHandlers(wss, options = {}) {
  const { allowedOrigin } = options;

  wss.on('connection', (ws, req) => {
    // Проверка Origin: если ALLOWED_ORIGIN задан, то пускаем только его
    const origin = req.headers.origin;
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      console.warn(`Rejected WS connection from origin ${origin}`);
      ws.close(1008, 'Origin not allowed');
      return;
    }

    ws.id = allocClientId();
    ws._msgCount = 0;
    ws._msgWindowStart = Date.now();
    clients.add(ws);

    // Отправим первичный список комнат
    try {
      ws.send(
        JSON.stringify({
          type: 'rooms',
          rooms: buildRoomsList(),
        }),
      );
    } catch (e) {
      // ignore
    }

    ws.on('message', (message) => {
      // ограничиваем размер одного сообщения дополнительно на уровне приложения
      if (message.length > 64 * 1024) {
        console.warn(`WS message too large from client ${ws.id}, closing connection`);
        try {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Слишком большой пакет данных. Соединение закрыто сервером.',
            }),
          );
        } catch (e) {
          // ignore
        }
        ws.close(1009, 'Message too big');
        return;
      }

      // Простейший rate limiting
      const now = Date.now();
      if (now - ws._msgWindowStart > 60_000) {
        ws._msgWindowStart = now;
        ws._msgCount = 0;
      }
      ws._msgCount += 1;
      if (ws._msgCount > MAX_MESSAGES_PER_MINUTE) {
        console.warn(`Rate limit exceeded by client ${ws.id}, closing connection`);
        try {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Слишком много сообщений. Соединение закрыто сервером.',
            }),
          );
        } catch (e) {
          // ignore
        }
        ws.close();
        return;
      }

      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (e) {
        console.error('Invalid JSON message', e);
        return;
      }

      if (!data || typeof data.type !== 'string') {
        return;
      }

      if (data.type === 'join') {
        handleJoin(ws, data);
      } else if (data.type === 'signal') {
        handleSignal(ws, data);
      } else if (data.type === 'state') {
        handleState(ws, data);
      } else if (data.type === 'ping') {
        handlePing(ws, data);
      } else if (data.type === 'kick') {
        handleKick(ws, data);
      } else {
        // неизвестный тип сообщения — игнорируем
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      const roomId = ws.roomId;
      if (!roomId || !rooms.has(roomId)) return;

      const room = rooms.get(roomId);
      room.peers.delete(ws.clientId);
      const count = room.peers.size;

      if (count === 0) {
        rooms.delete(roomId);
      } else {
        // Оповестим оставшихся участников новым состоянием
        broadcastRoomState(roomId);
      }
      // Список комнат мог измениться
      broadcastRoomsList();
      console.log(`Client ${ws.clientId} left room ${roomId}. Remaining: ${count}`);
    });
  });
}

function handleJoin(ws, data) {
  const roomId = sanitizeString(data.roomId, 64);
  const password = sanitizeString(data.password, 64, true);
  const nickname = sanitizeString(data.nickname, 32, true);
  const userId = sanitizeString(data.userId, 64, true) || ws.id;
  if (!roomId) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Некорректный ID комнаты.',
      }),
    );
    return;
  }

  if (!rooms.has(roomId)) {
    // Первая инициализация комнаты — пароль задаётся первым участником
    rooms.set(roomId, {
      password,
      ownerUserId: userId,
      peers: new Map(),
    });
  }

  const room = rooms.get(roomId);

  // Проверка пароля, если он установлен
  if (room.password && room.password !== (password || room.password)) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Неверный пароль для этой комнаты.',
      }),
    );
    return;
  }

  // Удаляем старое подключение этого же пользователя, если он уже был в комнате
  for (const [id, peer] of room.peers.entries()) {
    if (peer.userId && peer.userId === userId) {
      room.peers.delete(id);
      try {
        peer.close();
      } catch (e) {
        // ignore
      }
    }
  }

  // Проверка лимита людей в комнате
  if (room.peers.size >= MAX_PEERS_PER_ROOM) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Комната уже заполнена (максимум ${MAX_PEERS_PER_ROOM} участников).`,
      }),
    );
    return;
  }

  ws.roomId = roomId;
  ws.clientId = ws.id;
  ws.userId = userId;
  ws.nickname = nickname || `Гость-${ws.clientId}`;
  ws.muted = false;
  ws.lastPingAt = null;
  ws.pingMs = null;
  room.peers.set(ws.clientId, ws);

  const count = room.peers.size;
  console.log(`Client ${ws.clientId} joined room ${roomId}. Peers: ${count}`);

  // Сообщаем подключившемуся его ID и текущее количество участников
  ws.send(
    JSON.stringify({
      type: 'joined',
      roomId,
      clientId: ws.clientId,
      count,
    }),
  );

  // Оповещаем всех в комнате о новом состоянии
  broadcastRoomState(roomId);
  // И обновим общий список комнат
  broadcastRoomsList();
}

function handleSignal(ws, data) {
  const roomId = sanitizeString(data.roomId, 64);
  const targetId = sanitizeString(data.targetId, 32);
  const payload = data.payload;
  if (!payload || typeof payload.type !== 'string') return;
  if (!roomId || !rooms.has(roomId)) return;

  const room = rooms.get(roomId);
  const target = room.peers.get(targetId);
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(
      JSON.stringify({
        type: 'signal',
        from: ws.clientId,
        payload,
      }),
    );
  }
}

function handleState(ws, data) {
  const roomId = ws.roomId;
  if (!roomId || !rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  if (!room.peers.has(ws.clientId)) return;

  const nickname = sanitizeString(data.nickname, 32, true);
  if (nickname) {
    ws.nickname = nickname;
  }
  if (typeof data.muted === 'boolean') {
    ws.muted = data.muted;
  }

  broadcastRoomState(roomId);
}

function handlePing(ws, data) {
  const nowTs = Date.now();
  ws.lastPingAt = nowTs;
  if (typeof data.ts === 'number') {
    ws.pingMs = nowTs - data.ts;
  }
  const roomId = ws.roomId;
  if (roomId && rooms.has(roomId)) {
    // Раз в ping обновляем состояние комнаты, чтобы участники видели актуальный пинг/статус
    broadcastRoomState(roomId);
  }
  try {
    ws.send(
      JSON.stringify({
        type: 'pong',
        ts: data.ts || nowTs,
      }),
    );
  } catch (e) {
    // ignore
  }
}

function handleKick(ws, data) {
  const roomId = ws.roomId;
  if (!roomId || !rooms.has(roomId)) return;
  const room = rooms.get(roomId);
  if (!room || room.ownerUserId !== ws.userId) {
    // Не владелец комнаты — игнорируем
    return;
  }
  const targetId = sanitizeString(data.targetId, 32);
  if (!targetId) return;
  const target = room.peers.get(targetId);
  if (!target) return;
  try {
    target.send(
      JSON.stringify({
        type: 'kicked',
        roomId,
      }),
    );
  } catch (e) {
    // ignore
  }
  try {
    target.close();
  } catch (e) {
    // ignore
  }
}

module.exports = {
  attachWsHandlers,
};


