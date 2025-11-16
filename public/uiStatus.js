// UI-хелперы для статусов подключения, комнаты и пинга.

const connectionStatusEl = document.getElementById('connectionStatus');
const callStatusEl = document.getElementById('callStatus');
const roomInfoEl = document.getElementById('roomInfo');
const globalPingEl = document.getElementById('globalPing');

function setConnectionStatus(text, type = '') {
  if (!connectionStatusEl) return;
  connectionStatusEl.textContent = text;
  connectionStatusEl.classList.remove('status-online', 'status-error');
  if (type === 'online') connectionStatusEl.classList.add('status-online');
  if (type === 'error') connectionStatusEl.classList.add('status-error');
}

function setCallStatus(text, type = '') {
  if (!callStatusEl) return;
  callStatusEl.textContent = text;
  callStatusEl.classList.remove('status-online', 'status-error');
  if (type === 'online') callStatusEl.classList.add('status-online');
  if (type === 'error') callStatusEl.classList.add('status-error');
}

function setRoomInfo(count, currentRoomId) {
  if (!roomInfoEl) return;
  if (!count || !currentRoomId) {
    roomInfoEl.textContent = '';
    return;
  }
  roomInfoEl.textContent = `Комната ${currentRoomId}. В комнате: ${count} чел.`;
}

function setGlobalPing(ms) {
  if (!globalPingEl) return;
  if (ms == null) {
    globalPingEl.textContent = 'Пинг: —';
    return;
  }
  const val = Math.max(0, Math.round(ms));
  globalPingEl.textContent = `Пинг: ${val} мс`;
}

export { setConnectionStatus, setCallStatus, setRoomInfo, setGlobalPing };


