import { setCallStatus } from './uiStatus.js';

const roomsListEl = document.getElementById('roomsList');
const roomInput = document.getElementById('roomId');
const roomPasswordInput = document.getElementById('roomPassword');

function renderRooms(rooms, currentRoomId) {
  if (!roomsListEl) return;
  roomsListEl.innerHTML = '';
  const sorted = [...rooms].sort((a, b) => a.roomId.localeCompare(b.roomId));
  sorted.forEach((room) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'room-item';
    if (room.roomId === currentRoomId) {
      item.classList.add('room-item-active');
    }
    item.dataset.roomId = room.roomId;
    item.dataset.hasPassword = room.hasPassword ? '1' : '0';

    const nameLine = document.createElement('div');
    nameLine.className = 'room-name-line';

    const nameEl = document.createElement('div');
    nameEl.className = 'room-name';
    nameEl.textContent = room.roomId;

    const lockEl = document.createElement('div');
    lockEl.className = 'room-lock';
    lockEl.textContent = room.hasPassword ? '🔒' : '';

    nameLine.appendChild(nameEl);
    nameLine.appendChild(lockEl);

    const meta = document.createElement('div');
    meta.className = 'room-meta';
    meta.textContent = `${room.count} чел.`;

    item.appendChild(nameLine);
    item.appendChild(meta);

    item.addEventListener('click', () => {
      const targetRoomId = room.roomId;
      const locked = room.hasPassword;

      if (!roomInput) return;

      // Текущее значение комнаты определяет сам client.js;
      // здесь только подставляем ID и даём подсказку.
      roomInput.value = targetRoomId;

      if (locked) {
        setCallStatus('Комната с паролем. Введите пароль и нажмите «Подключиться».', 'error');
        if (roomPasswordInput) {
          roomPasswordInput.focus();
        }
      } else {
        setCallStatus('Готово. Нажмите «Подключиться», чтобы войти в комнату.', 'online');
      }
    });

    roomsListEl.appendChild(item);
  });
}

export { renderRooms };


