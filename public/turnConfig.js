// Конфиг ICE/TURN для клиента.
// Вынесен в отдельный модуль, чтобы логику получения временных TURN-кредов
// можно было переиспользовать и тестировать отдельно.

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

let iceServers = [...DEFAULT_ICE_SERVERS];
let lastTurnUpdatedAt = 0;
let turnTtlSec = 0;
let turnRefreshTimerId = null;

async function refreshTurnConfig() {
  try {
    const res = await fetch('/api/turn', { cache: 'no-store' });
    if (!res.ok || res.status === 204) return;
    const data = await res.json();
    if (!Array.isArray(data.urls) || !data.username || !data.credential) return;

    iceServers = [
      {
        urls: data.urls,
        username: data.username,
        credential: data.credential,
      },
      ...DEFAULT_ICE_SERVERS,
    ];

    turnTtlSec = typeof data.ttl === 'number' ? data.ttl : 3600;
    lastTurnUpdatedAt = Date.now();

    // Настраиваем автообновление по TTL (с запасом 60 секунд)
    if (turnRefreshTimerId) {
      clearInterval(turnRefreshTimerId);
      turnRefreshTimerId = null;
    }
    const safetyMs = 60 * 1000;
    const intervalMs = Math.max(turnTtlSec * 1000 - safetyMs, 5 * 60 * 1000);
    turnRefreshTimerId = setInterval(() => {
      refreshTurnConfig().catch(() => {});
    }, intervalMs);
  } catch (e) {
    // ignore network errors
  }
}

function getIceServers() {
  return iceServers;
}

export { DEFAULT_ICE_SERVERS, refreshTurnConfig, getIceServers };


