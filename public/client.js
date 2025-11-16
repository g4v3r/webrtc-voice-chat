import { refreshTurnConfig } from './turnConfig.js';
import { loadSettings, saveSettings, getUserId } from './settingsStore.js';
import { setConnectionStatus, setCallStatus, setRoomInfo, setGlobalPing } from './uiStatus.js';
import { renderRooms } from './uiRooms.js';
import { renderParticipants as renderParticipantsUI } from './uiParticipants.js';
import {
  initWebRtc,
  updateUserSettings,
  ensureLocalStream,
  recreateLocalStreamWithSettings,
  connectToPeer,
  handleSignal,
  cleanupPeerConnectionsOnly,
  removeRemoteAudio,
  setCurrentClientId,
  hasPeerConnection,
  getPeerConnectionIds,
  setMuted,
} from './webrtc.js';

const roomInput = document.getElementById('roomId');
const roomPasswordInput = document.getElementById('roomPassword');
const btnRandom = document.getElementById('btnRandom');
const btnJoin = document.getElementById('btnJoin');
const btnLeave = document.getElementById('btnLeave');
const btnMute = document.getElementById('btnMute');
const btnSettings = document.getElementById('btnSettings');
const settingsOverlay = document.getElementById('settingsOverlay');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const nicknameInput = document.getElementById('nicknameInput');
const btnSetNickname = document.getElementById('btnSetNickname');
const chkEchoCancellation = document.getElementById('chkEchoCancellation');
const chkNoiseSuppression = document.getElementById('chkNoiseSuppression');
const chkAutoGain = document.getElementById('chkAutoGain');
const localAudio = document.getElementById('localAudio');
const remoteAudiosContainer = document.getElementById('remoteAudios');

let ws = null;
let localStream = null;
let isMuted = false;
let currentRoomId = null;
let myClientId = null;
let myNickname = '';

// clientId -> { nickname, muted, speaking }
const participants = {};

let shouldReconnect = false;
let reconnectAttempts = 0;
let lastJoinParams = { roomId: null, password: '', nickname: '' };

let userSettings = loadSettings();
let rooms = [];
let userId = getUserId();
let pingIntervalId = null;
let lastPingMs = null;
let wasKicked = false;
// Инициализируем UI настройками
nicknameInput.value = userSettings.nickname || '';
chkEchoCancellation.checked = userSettings.echoCancellation;
chkNoiseSuppression.checked = userSettings.noiseSuppression;
chkAutoGain.checked = userSettings.autoGainControl;

// Инициализируем WebRTC модуль ссылками на текущие объекты
initWebRtc({
  userSettings,
  localAudio,
  remoteAudiosContainer,
  participants,
  renderParticipants: renderParticipantsWrapper,
  sendSignal,
});

async function refreshRoomsFromHttp() {
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.rooms)) {
      rooms = data.rooms;
      renderRooms(rooms, currentRoomId);
    }
  } catch (e) {
    // тихо игнорируем ошибки сети
  }
}

// Первичная загрузка списка комнат до подключения по WebSocket
refreshRoomsFromHttp();
// Периодическое обновление списка, чтобы новые клиенты видели свежие комнаты
setInterval(refreshRoomsFromHttp, 5000);
// Первичная подгрузка TURN-конфига (если сервер его выдаёт)
refreshTurnConfig();

const SIGNAL_SERVER_URL =
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

function openSettings() {
  settingsOverlay.classList.add('open');
}

function closeSettings() {
  settingsOverlay.classList.remove('open');
}

function renderParticipantsWrapper() {
  renderParticipantsUI({
    participants,
    myClientId,
    lastPingMs,
    onKick: (targetId) => {
      if (ws && ws.readyState === WebSocket.OPEN && currentRoomId) {
        ws.send(
          JSON.stringify({
            type: 'kick',
            targetId,
          }),
        );
      }
    },
  });
}

function randomRoomId() {
  return 'room-' + Math.random().toString(36).slice(2, 8);
}

btnRandom.addEventListener('click', () => {
  roomInput.value = randomRoomId();
});

btnSettings.addEventListener('click', () => {
  openSettings();
});

btnCloseSettings.addEventListener('click', () => {
  closeSettings();
});

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) {
    closeSettings();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSettings();
  }
});

chkEchoCancellation.addEventListener('change', async () => {
  userSettings.echoCancellation = chkEchoCancellation.checked;
  saveSettings(userSettings);
  updateUserSettings(userSettings);
  if (myClientId && currentRoomId) {
    try {
      await recreateLocalStreamWithSettings();
    } catch (err) {
      console.error('Error applying echo cancellation setting', err);
    }
  }
});

chkNoiseSuppression.addEventListener('change', async () => {
  userSettings.noiseSuppression = chkNoiseSuppression.checked;
  saveSettings(userSettings);
  updateUserSettings(userSettings);
  if (myClientId && currentRoomId) {
    try {
      await recreateLocalStreamWithSettings();
    } catch (err) {
      console.error('Error applying noise suppression setting', err);
    }
  }
});

chkAutoGain.addEventListener('change', async () => {
  userSettings.autoGainControl = chkAutoGain.checked;
  saveSettings(userSettings);
  updateUserSettings(userSettings);
  if (myClientId && currentRoomId) {
    try {
      await recreateLocalStreamWithSettings();
    } catch (err) {
      console.error('Error applying auto gain setting', err);
    }
  }
});

btnSetNickname.addEventListener('click', () => {
  myNickname = nicknameInput.value.trim();
  userSettings.nickname = myNickname;
  saveSettings(userSettings);
  if (ws && ws.readyState === WebSocket.OPEN && currentRoomId && myClientId) {
    sendState();
  }
});

btnJoin.addEventListener('click', async () => {
  const roomId = roomInput.value.trim();
  if (!roomId) {
    alert('Введите ID комнаты.');
    return;
  }
  if (roomId.length > 64) {
    alert('ID комнаты слишком длинный (максимум 64 символа).');
    return;
  }
  if (roomPasswordInput.value.length > 64) {
    alert('Пароль слишком длинный (максимум 64 символа).');
    return;
  }
  if (nicknameInput.value.length > 32) {
    alert('Ник слишком длинный (максимум 32 символа).');
    return;
  }
  myNickname = nicknameInput.value.trim() || userSettings.nickname || '';
  userSettings.nickname = myNickname;
  saveSettings(userSettings);
  currentRoomId = roomId;
  lastJoinParams = {
    roomId,
    password: roomPasswordInput.value.trim(),
    nickname: myNickname,
  };
  shouldReconnect = true;
  reconnectAttempts = 0;
  await startConnection(roomId, lastJoinParams.password);
});

btnLeave.addEventListener('click', () => {
  cleanup();
  setCallStatus('Вы вышли из комнаты.');
});

btnMute.addEventListener('click', () => {
  isMuted = !isMuted;
  setMuted(isMuted);
  btnMute.textContent = isMuted ? 'Микрофон вкл.' : 'Микрофон выкл.';
   if (ws && ws.readyState === WebSocket.OPEN && currentRoomId && myClientId) {
    sendState();
  }
});

async function startConnection(roomId, password) {
  try {
    // Подключение к WebSocket
    ws = new WebSocket(SIGNAL_SERVER_URL);

    ws.onopen = async () => {
      setConnectionStatus('Подключено к серверу.', 'online');
      ws.send(JSON.stringify({ type: 'join', roomId, password, nickname: myNickname, userId }));
      reconnectAttempts = 0;
    };

    ws.onerror = () => {
      setConnectionStatus('Ошибка WebSocket соединения.', 'error');
    };

    ws.onclose = () => {
      setConnectionStatus('Соединение закрыто.');
      if (!wasKicked && shouldReconnect && currentRoomId) {
        scheduleReconnect();
      } else {
        cleanupPeerConnectionsOnly();
        setRoomInfo(null);
      }
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'error') {
        setCallStatus(msg.message, 'error');
        return;
      }

      if (msg.type === 'rooms') {
        rooms = Array.isArray(msg.rooms) ? msg.rooms : [];
        renderRooms(rooms, currentRoomId);
      } else if (msg.type === 'joined') {
        myClientId = msg.clientId;
        setCurrentClientId(myClientId);
        setRoomInfo(msg.count, currentRoomId);
        setCallStatus('Ожидание других участников или подключение к существующим...', 'online');
        await ensureLocalStream();
        // после получения joined сразу запросим состояние (если сервер его вышлет отдельно)
      } else if (msg.type === 'room-state') {
        setRoomInfo(msg.count, currentRoomId);
        // актуальный список id
        const activeIds = new Set(msg.participants.map((p) => p.clientId));
        // удаляем участников, которых больше нет
        Object.keys(participants).forEach((id) => {
          if (!activeIds.has(id)) {
            delete participants[id];
          }
        });
        // обновляем/добавляем участников
        msg.participants.forEach((p) => {
          participants[p.clientId] = {
            nickname: p.nickname,
            muted: !!p.muted,
            speaking: participants[p.clientId]?.speaking || false,
            ping: typeof p.ping === 'number' ? p.ping : null,
            connection: p.connection || 'unknown',
            isOwner: !!p.isOwner,
            clientId: p.clientId,
          };
        });
        renderParticipantsWrapper();
        // создаём соединения с новыми участниками и закрываем лишние
        if (myClientId) {
          for (const p of msg.participants) {
            // Чтобы избежать конфликта offer/answer, договоримся:
            // оффер всегда инициирует участник с МЕНЬШИМ clientId.
            if (
              p.clientId !== myClientId &&
              !hasPeerConnection(p.clientId) &&
              String(myClientId) < String(p.clientId)
            ) {
              connectToPeer(p.clientId);
            }
          }
          // закрываем соединения, которых больше нет в комнате
          getPeerConnectionIds().forEach((peerId) => {
            if (!activeIds.has(peerId)) {
              removeRemoteAudio(peerId);
            }
          });
        }
      } else if (msg.type === 'signal') {
        await handleSignal(msg.from, msg.payload);
      } else if (msg.type === 'kicked') {
        wasKicked = true;
        shouldReconnect = false;
        setCallStatus('Вы были исключены создателем комнаты.', 'error');
        cleanup();
      } else if (msg.type === 'pong') {
        if (typeof msg.ts === 'number') {
          const rtt = Date.now() - msg.ts;
          lastPingMs = rtt;
          setGlobalPing(lastPingMs);
        }
      }
    };

    btnJoin.disabled = true;
    btnLeave.disabled = false;
    btnMute.disabled = false;

    // Запускаем периодический ping к серверу для оценки задержки
    if (pingIntervalId) {
      clearInterval(pingIntervalId);
    }
    pingIntervalId = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'ping',
            ts: Date.now(),
          })
        );
      }
    }, 5000);
  } catch (err) {
    console.error(err);
    setCallStatus('Ошибка инициализации: ' + err.message, 'error');
  }
}

function sendSignal(targetId, payload) {
  if (ws && ws.readyState === WebSocket.OPEN && currentRoomId && targetId) {
    ws.send(
      JSON.stringify({
        type: 'signal',
        roomId: currentRoomId,
        targetId,
        payload,
      })
    );
  }
}

function cleanup() {
  cleanupPeerConnectionsOnly();

  if (ws) {
    try {
      ws.close();
    } catch (e) {
      // ignore
    }
    ws = null;
  }

  lastPingMs = null;
  setGlobalPing(null);

  if (pingIntervalId) {
    clearInterval(pingIntervalId);
    pingIntervalId = null;
  }

  wasKicked = false;

  getPeerConnectionIds().forEach((peerId) => removeRemoteAudio(peerId));

  // очищаем список участников и UI
  Object.keys(participants).forEach((id) => {
    delete participants[id];
  });
  renderParticipantsWrapper();

  btnJoin.disabled = false;
  btnLeave.disabled = true;
  btnMute.disabled = true;
  setConnectionStatus('Не подключено');
  setRoomInfo(null, null);
  currentRoomId = null;
  myClientId = null;
  shouldReconnect = false;
  reconnectAttempts = 0;
}

function scheduleReconnect() {
  if (!shouldReconnect || !currentRoomId) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 10_000);
  reconnectAttempts += 1;
  setConnectionStatus(
    `Потеряно соединение с сервером, попытка переподключения через ${Math.round(delay / 1000)} с...`,
    'error'
  );
  setTimeout(() => {
    if (!shouldReconnect || !currentRoomId) return;
    startConnection(currentRoomId, lastJoinParams.password).catch((err) => {
      console.error('Reconnect failed', err);
    });
  }, delay);
}

function setAudioCodecPreferences(pc) {
  if (!window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
  const capabilities = RTCRtpSender.getCapabilities('audio');
  if (!capabilities || !capabilities.codecs) return;

  // Предпочитаем Opus
  const preferredMimeType = 'audio/opus';
  const opusCodecs = capabilities.codecs.filter(
    (c) => c.mimeType && c.mimeType.toLowerCase() === preferredMimeType
  );
  const otherCodecs = capabilities.codecs.filter(
    (c) => !c.mimeType || c.mimeType.toLowerCase() !== preferredMimeType
  );
  const orderedCodecs = [...opusCodecs, ...otherCodecs];

  pc.getTransceivers().forEach((transceiver) => {
    if (
      transceiver.sender &&
      transceiver.sender.track &&
      transceiver.sender.track.kind === 'audio' &&
      typeof transceiver.setCodecPreferences === 'function'
    ) {
      transceiver.setCodecPreferences(orderedCodecs);
    }
  });
}

function sendState() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentRoomId || !myClientId) return;
  ws.send(
    JSON.stringify({
      type: 'state',
      nickname: myNickname,
      muted: isMuted,
    })
  );
}

function setupSpeakingDetection(id, stream) {
  if (!audioContext) return;
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  speakingAnalyzers[id] = { analyser, source, dataArray };

  const isMe = id === 'me';
  const targetIdResolver = () => (isMe ? myClientId : id);

  const threshold = 0.02;
  const smoothing = 0.7;
  let smoothed = 0;

  function tick() {
    if (!speakingAnalyzers[id]) return;
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    smoothed = smoothing * smoothed + (1 - smoothing) * rms;

    const targetId = targetIdResolver();
    if (targetId && participants[targetId]) {
      const speakingNow = !participants[targetId].muted && smoothed > threshold;
      if (participants[targetId].speaking !== speakingNow) {
        participants[targetId].speaking = speakingNow;
        renderParticipants();
      }
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}


