// Хранилище настроек пользователя и userId.

const SETTINGS_KEY = 'voiceChatSettings';
const USER_ID_KEY = 'voiceChatUserId';

const defaultSettings = {
  nickname: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function loadSettings() {
  let settings = { ...defaultSettings };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return settings;
    const parsed = JSON.parse(raw);
    settings = { ...defaultSettings, ...parsed };
  } catch (e) {
    // ignore, вернём дефолтные
  }
  return settings;
}

function saveSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    // ignore
  }
}

function getUserId() {
  let userId;
  try {
    userId = window.localStorage.getItem(USER_ID_KEY);
    if (!userId) {
      userId = `u_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
      window.localStorage.setItem(USER_ID_KEY, userId);
    }
  } catch (e) {
    userId = `u_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  }
  return userId;
}

export { SETTINGS_KEY, USER_ID_KEY, defaultSettings, loadSettings, saveSettings, getUserId };


