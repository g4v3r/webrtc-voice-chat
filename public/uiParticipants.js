const participantsList = document.getElementById('participantsList');

function renderParticipants({ participants, myClientId, lastPingMs, onKick }) {
  if (!participantsList) return;
  participantsList.innerHTML = '';
  Object.keys(participants).forEach((id) => {
    const p = participants[id];
    const item = document.createElement('div');
    item.className = 'participant-item';
    if (id === myClientId) {
      item.classList.add('participant-me');
    }
    if (p.muted) {
      item.classList.add('participant-muted');
    } else if (p.speaking) {
      item.classList.add('participant-speaking');
    }

    const dot = document.createElement('div');
    dot.className = 'participant-dot';

    const nameEl = document.createElement('div');
    nameEl.className = 'participant-name';
    const baseName = p.nickname || `Гость-${id}`;
    const ownerMark = p.isOwner ? ' (создатель)' : '';
    nameEl.textContent = `${baseName}${ownerMark}`;

    const metaEl = document.createElement('div');
    metaEl.className = 'participant-meta';
    let pingText = '';
    const isMe = id === myClientId;
    const effectivePing = isMe && lastPingMs != null ? lastPingMs : p.ping;

    if (p.connection === 'timeout') {
      pingText = 'нет связи';
      metaEl.classList.add('participant-ping-bad');
    } else if (typeof effectivePing === 'number') {
      pingText = `${Math.round(effectivePing)} ms`;
    } else {
      pingText = '—';
    }
    metaEl.textContent = pingText;

    item.appendChild(dot);
    item.appendChild(nameEl);
    item.appendChild(metaEl);

    // Кнопка кика, если мы создатель комнаты
    if (p.clientId && myClientId && p.clientId !== myClientId && participants[myClientId]?.isOwner) {
      const kickBtn = document.createElement('button');
      kickBtn.type = 'button';
      kickBtn.textContent = 'Кик';
      kickBtn.className = 'btn-secondary';
      kickBtn.style.padding = '4px 8px';
      kickBtn.style.marginLeft = 'auto';
      kickBtn.style.fontSize = '0.7rem';
      kickBtn.addEventListener('click', () => {
        if (typeof onKick === 'function') {
          onKick(p.clientId);
        }
      });
      item.appendChild(kickBtn);
    }

    participantsList.appendChild(item);
  });
}

export { renderParticipants };


