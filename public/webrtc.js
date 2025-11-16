import { setCallStatus } from './uiStatus.js';
import { getIceServers } from './turnConfig.js';

const peerConnections = {};
const speakingAnalyzers = {}; // id -> { analyser, source, dataArray }

let localStream = null;
let audioContext = null;

// Эти ссылки и функции инициализируются из client.js
let userSettingsRef = null;
let localAudioEl = null;
let remoteAudiosContainerEl = null;
let participantsRef = null;
let renderParticipantsFn = null;
let sendSignalFn = null;
let currentClientId = null;

function initWebRtc({
  userSettings,
  localAudio,
  remoteAudiosContainer,
  participants,
  renderParticipants,
  sendSignal,
}) {
  userSettingsRef = userSettings;
  localAudioEl = localAudio;
  remoteAudiosContainerEl = remoteAudiosContainer;
  participantsRef = participants;
  renderParticipantsFn = renderParticipants;
  sendSignalFn = sendSignal;
}

function updateUserSettings(settings) {
  userSettingsRef = settings;
}

function setCurrentClientId(id) {
  currentClientId = id;
}

async function ensureLocalStream() {
  if (localStream) return;
  await recreateLocalStreamWithSettings();
}

async function recreateLocalStreamWithSettings() {
  if (!userSettingsRef) {
    throw new Error('WebRTC: userSettings not initialized');
  }

  // Останавливаем старый поток, если есть
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  const constraints = {
    audio: {
      echoCancellation: userSettingsRef.echoCancellation,
      noiseSuppression: userSettingsRef.noiseSuppression,
      autoGainControl: userSettingsRef.autoGainControl,
      channelCount: 1,
      sampleRate: 48000,
    },
    video: false,
  };

  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  if (localAudioEl) {
    localAudioEl.srcObject = localStream;
  }

  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  // анализ своего голоса
  setupSpeakingDetection('me', localStream);

  // Обновляем треки во всех соединениях
  Object.values(peerConnections).forEach((pc) => {
    const sender = pc
      .getSenders()
      .find((s) => s.track && s.track.kind === 'audio');
    const newTrack = localStream.getAudioTracks()[0];
    if (sender && newTrack) {
      sender.replaceTrack(newTrack).catch((err) => {
        console.error('Error replacing track', err);
      });
    }
  });
}

function createPeerConnection(peerId) {
  if (peerConnections[peerId]) {
    return peerConnections[peerId];
  }

  const pc = new RTCPeerConnection({
    iceServers: getIceServers(),
  });

  // Локальные треки
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  // Попробуем выставить предпочтительный аудио-кодек (Opus)
  try {
    setAudioCodecPreferences(pc);
  } catch (e) {
    console.warn('Codec preference not applied:', e);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      if (typeof sendSignalFn === 'function') {
        sendSignalFn(peerId, {
          type: 'candidate',
          candidate: event.candidate,
        });
      }
    }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    attachRemoteStream(peerId, stream);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setCallStatus('Голосовая связь установлена с участниками комнаты.', 'online');
    }
  };

  peerConnections[peerId] = pc;
  return pc;
}

async function connectToPeer(peerId) {
  if (!localStream) {
    await ensureLocalStream();
  }
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  if (typeof sendSignalFn === 'function') {
    sendSignalFn(peerId, {
      type: 'offer',
      sdp: offer,
    });
  }
}

async function handleSignal(fromPeerId, payload) {
  if (!localStream) {
    await ensureLocalStream();
  }

  let pc = peerConnections[fromPeerId];
  if (!pc) {
    pc = createPeerConnection(fromPeerId);
  }

  if (payload.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (typeof sendSignalFn === 'function') {
      sendSignalFn(fromPeerId, {
        type: 'answer',
        sdp: answer,
      });
    }
  } else if (payload.type === 'answer') {
    if (!pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    }
  } else if (payload.type === 'candidate') {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    } catch (err) {
      console.error('Error adding ICE candidate', err);
    }
  }
}

function closePeerConnection(peerId) {
  const pc = peerConnections[peerId];
  if (pc) {
    pc.close();
    delete peerConnections[peerId];
  }
}

function hasPeerConnection(peerId) {
  return !!peerConnections[peerId];
}

function getPeerConnectionIds() {
  return Object.keys(peerConnections);
}

function attachRemoteStream(peerId, stream) {
  if (!remoteAudiosContainerEl) return;
  let audio = remoteAudiosContainerEl.querySelector(`audio[data-peer-id="${peerId}"]`);
  if (!audio) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.dataset.peerId = peerId;
    remoteAudiosContainerEl.appendChild(audio);
  }
  audio.srcObject = stream;

  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  setupSpeakingDetection(peerId, stream);
}

function removeRemoteAudio(peerId) {
  if (!remoteAudiosContainerEl) return;
  const audio = remoteAudiosContainerEl.querySelector(`audio[data-peer-id="${peerId}"]`);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
  }
}

function cleanupPeerConnectionsOnly() {
  Object.keys(peerConnections).forEach((peerId) => {
    closePeerConnection(peerId);
  });
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  Object.keys(speakingAnalyzers).forEach((id) => {
    const item = speakingAnalyzers[id];
    if (item && item.source) {
      try {
        item.source.disconnect();
      } catch (e) {
        // ignore
      }
    }
    delete speakingAnalyzers[id];
  });
}

function setAudioCodecPreferences(pc) {
  if (!window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
  const capabilities = RTCRtpSender.getCapabilities('audio');
  if (!capabilities || !capabilities.codecs) return;

  const preferredMimeType = 'audio/opus';
  const opusCodecs = capabilities.codecs.filter(
    (c) => c.mimeType && c.mimeType.toLowerCase() === preferredMimeType,
  );
  const otherCodecs = capabilities.codecs.filter(
    (c) => !c.mimeType || c.mimeType.toLowerCase() !== preferredMimeType,
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

function setupSpeakingDetection(id, stream) {
  if (!audioContext) return;
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  speakingAnalyzers[id] = { analyser, source, dataArray };

  const isMe = id === 'me';
  const targetIdResolver = () => (isMe ? currentClientId : id);

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
    if (targetId && participantsRef && participantsRef[targetId]) {
      const speakingNow = !participantsRef[targetId].muted && smoothed > threshold;
      if (participantsRef[targetId].speaking !== speakingNow) {
        participantsRef[targetId].speaking = speakingNow;
        if (typeof renderParticipantsFn === 'function') {
          renderParticipantsFn();
        }
      }
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

export {
  initWebRtc,
  updateUserSettings,
  ensureLocalStream,
  recreateLocalStreamWithSettings,
  createPeerConnection,
  connectToPeer,
  handleSignal,
  cleanupPeerConnectionsOnly,
  closePeerConnection,
  removeRemoteAudio,
  setCurrentClientId,
  hasPeerConnection,
  getPeerConnectionIds,
};


