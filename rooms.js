const WebSocket = require('ws');

// Максимальное количество людей в комнате (можно изменить при желании)
const MAX_PEERS_PER_ROOM = 6;

// Ограничение частоты сообщений на одно WebSocket-соединение
const MAX_MESSAGES_PER_MINUTE = 240;

// Таймаут для определения статуса соединения по ping
const PING_TIMEOUT_MS = 15_000;

// Хранение подключений по комнатам:
// roomId -> { password: string | null, ownerUserId: string, peers: Map<clientId, ws> }
const rooms = new Map();

// Все активные WebSocket-клиенты (для рассылки списка комнат)
const clients = new Set();

let nextClientId = 1;

function allocClientId() {
  return String(nextClientId++);
}

function buildRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const participants = [];
  const now = Date.now();
  for (const [id, peer] of room.peers.entries()) {
    let connection = 'unknown';
    if (peer.lastPingAt) {
      connection = now - peer.lastPingAt > PING_TIMEOUT_MS ? 'timeout' : 'ok';
    }
    participants.push({
      clientId: id,
      nickname: peer.nickname || `Гость-${id}`,
      muted: !!peer.muted,
      ping: typeof peer.pingMs === 'number' ? peer.pingMs : null,
      connection,
      isOwner: room.ownerUserId && peer.userId === room.ownerUserId,
    });
  }
  return {
    roomId,
    count: participants.length,
    participants,
  };
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const state = buildRoomState(roomId);
  if (!state) return;
  for (const [, peer] of room.peers.entries()) {
    if (peer.readyState === WebSocket.OPEN) {
      peer.send(
        JSON.stringify({
          type: 'room-state',
          ...state,
        }),
      );
    }
  }
}

function buildRoomsList() {
  const list = [];
  for (const [roomId, room] of rooms.entries()) {
    list.push({
      roomId,
      count: room.peers.size,
      hasPassword: !!room.password,
    });
  }
  return list;
}

function broadcastRoomsList() {
  const payload = JSON.stringify({
    type: 'rooms',
    rooms: buildRoomsList(),
  });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

module.exports = {
  MAX_PEERS_PER_ROOM,
  MAX_MESSAGES_PER_MINUTE,
  PING_TIMEOUT_MS,
  rooms,
  clients,
  allocClientId,
  buildRoomState,
  broadcastRoomState,
  buildRoomsList,
  broadcastRoomsList,
};


