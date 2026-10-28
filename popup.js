const promptsInput = document.querySelector('#promptsJson');
const globalPrefixInput = document.querySelector('#globalPrefix');
const downloadPathInput = document.querySelector('#downloadPath');
const minDelayInput = document.querySelector('#minDelay');
const maxDelayInput = document.querySelector('#maxDelay');
const reliableModeInput = document.querySelector('#reliableMode');
const useGlobalPrefixInput = document.querySelector('#useGlobalPrefix');
const startButton = document.querySelector('#startButton');
const stopButton = document.querySelector('#stopButton');
const statusText = document.querySelector('#statusText');
const stateBadge = document.querySelector('#stateBadge');
const progress = document.querySelector('#progress');
const logsOutput = document.querySelector('#logsOutput');
const copyLogsButton = document.querySelector('#copyLogsButton');
const clearLogsButton = document.querySelector('#clearLogsButton');

const DEFAULT_DOWNLOAD_PATH = 'C:\\Users\\Thomas\\Downloads\\ChatGPT_images';
const DEFAULT_MIN_DELAY_SECONDS = 5;
const DEFAULT_MAX_DELAY_SECONDS = 15;
const DEFAULT_RELIABLE_MODE = false;
const DEFAULT_USE_GLOBAL_PREFIX = true;
const DEFAULT_GLOBAL_PREFIX = '';

init();

function init() {
  restoreDraft();
  startButton.addEventListener('click', handleStart);
  stopButton.addEventListener('click', handleStop);
  promptsInput.addEventListener('input', saveDraft);
  globalPrefixInput.addEventListener('input', saveDraft);
  downloadPathInput.addEventListener('input', saveDraft);
  minDelayInput.addEventListener('input', saveDraft);
  maxDelayInput.addEventListener('input', saveDraft);
  reliableModeInput.addEventListener('change', saveDraft);
  useGlobalPrefixInput.addEventListener('change', saveDraft);
  copyLogsButton.addEventListener('click', copyLogs);
  clearLogsButton.addEventListener('click', clearLogs);
  refreshStatus();
  refreshLogs();
  setInterval(() => {
    refreshStatus();
    refreshLogs();
  }, 1000);
}

async function handleStart() {
  try {
    const entries = parsePrompts(promptsInput.value);
    const settings = parseSettings();
    await saveDraft();
    setStatus({ state: 'starting', message: 'Demarrage...', completed: 0, total: entries.length });

    const response = await chrome.runtime.sendMessage({
      type: 'START_AUTOMATION',
      entries,
      settings
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Demarrage impossible.');
    }
  } catch (error) {
    setStatus({ state: 'error', message: error.message, completed: 0, total: 1 });
  }
}

function parseSettings() {
  const minDelaySeconds = parseDelay(minDelayInput.value, 'min');
  const maxDelaySeconds = parseDelay(maxDelayInput.value, 'max');

  if (minDelaySeconds > maxDelaySeconds) {
    throw new Error('Intervalle invalide : min doit etre inferieur ou egal a max.');
  }

  return {
    downloadPath: downloadPathInput.value.trim(),
    downloadDir: parseDownloadDir(downloadPathInput.value),
    minDelaySeconds,
    maxDelaySeconds,
    reliableMode: reliableModeInput.checked,
    useGlobalPrefix: useGlobalPrefixInput.checked,
    globalPrefix: globalPrefixInput.value.trim()
  };
}

function parseDelay(value, label) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3600) {
    throw new Error(`Intervalle invalide : ${label} doit etre un nombre entier entre 0 et 3600.`);
  }

  return parsed;
}

function parseDownloadDir(rawPath) {
  const value = rawPath.trim();

  if (!value) {
    throw new Error('Le dossier d\'enregistrement est obligatoire.');
  }

  const normalized = value.replace(/\//g, '\\');
  const downloadsMatch = normalized.match(/^[a-z]:\\.*?\\(?:downloads|telechargements|téléchargements)(?:\\(.+))?$/i);

  if (/^[a-z]:\\/i.test(normalized)) {
    if (!downloadsMatch || !downloadsMatch[1]) {
      throw new Error('Chrome peut enregistrer automatiquement uniquement dans un sous-dossier de Downloads.');
    }

    return sanitizeRelativeDownloadDir(downloadsMatch[1]);
  }

  return sanitizeRelativeDownloadDir(normalized);
}

function sanitizeRelativeDownloadDir(value) {
  const cleaned = value
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

  const parts = cleaned.split('/').filter(Boolean);

  if (parts.length === 0) {
    throw new Error('Le dossier doit contenir au moins un sous-dossier.');
  }

  if (parts.some((part) => part === '.' || part === '..' || /[<>:"|?*]/.test(part))) {
    throw new Error('Le chemin contient un segment invalide.');
  }

  return parts.join('/');
}

async function handleStop() {
  const response = await chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION' });
  if (!response?.ok) {
    setStatus({ state: 'error', message: response?.error || 'Arret impossible.' });
  }
}

function parsePrompts(rawValue) {
  let parsed;

  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`JSON invalide : ${error.message}`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Le JSON doit etre un objet cle/valeur.');
  }

  const entries = Object.entries(parsed)
    .map(([key, prompt]) => ({
      key: String(key),
      prompt: typeof prompt === 'string' ? prompt.trim() : ''
    }))
    .filter((entry) => entry.key && entry.prompt && entry.prompt.toLowerCase() !== 'text')
    .sort((a, b) => sortKeys(a.key, b.key));

  if (entries.length === 0) {
    throw new Error('Aucun prompt texte trouve dans le JSON.');
  }

  return entries;
}

function sortKeys(a, b) {
  const aNumber = Number(a);
  const bNumber = Number(b);

  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber;
  }

  return a.localeCompare(b, 'fr', { numeric: true });
}

async function restoreDraft() {
  const data = await chrome.storage.local.get({
    promptsJson: '',
    downloadPath: DEFAULT_DOWNLOAD_PATH,
    minDelaySeconds: DEFAULT_MIN_DELAY_SECONDS,
    maxDelaySeconds: DEFAULT_MAX_DELAY_SECONDS,
    reliableMode: DEFAULT_RELIABLE_MODE,
    useGlobalPrefix: DEFAULT_USE_GLOBAL_PREFIX,
    globalPrefix: DEFAULT_GLOBAL_PREFIX
  });
  promptsInput.value = data.promptsJson;
  globalPrefixInput.value = data.globalPrefix;
  downloadPathInput.value = data.downloadPath;
  minDelayInput.value = data.minDelaySeconds;
  maxDelayInput.value = data.maxDelaySeconds;
  reliableModeInput.checked = Boolean(data.reliableMode);
  useGlobalPrefixInput.checked = data.useGlobalPrefix !== false;
}

function saveDraft() {
  return chrome.storage.local.set({
    promptsJson: promptsInput.value,
    globalPrefix: globalPrefixInput.value,
    downloadPath: downloadPathInput.value,
    minDelaySeconds: minDelayInput.value,
    maxDelaySeconds: maxDelayInput.value,
    reliableMode: reliableModeInput.checked,
    useGlobalPrefix: useGlobalPrefixInput.checked
  });
}

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (response?.ok) {
    setStatus(response.status);
  }
}

async function refreshLogs() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' }).catch(() => null);
  if (!response?.ok || !Array.isArray(response.logs)) {
    return;
  }

  const wasNearBottom = logsOutput.scrollHeight - logsOutput.scrollTop - logsOutput.clientHeight < 32;
  logsOutput.textContent = response.logs.length > 0
    ? response.logs.map(formatLogEntry).join('\n')
    : 'Aucun evenement.';

  if (wasNearBottom) {
    logsOutput.scrollTop = logsOutput.scrollHeight;
  }
}

function formatLogEntry(entry) {
  const time = formatLogTime(entry.timestamp);
  const level = String(entry.level || 'info').toUpperCase().padEnd(5, ' ');
  const scope = entry.scope ? `[${entry.scope}]` : '';
  const details = entry.details ? ` ${safeStringify(entry.details)}` : '';
  return `${time} ${level} ${scope} ${entry.event || ''}${details}`.trimEnd();
}

function formatLogTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString('fr-FR', { hour12: false });
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

async function copyLogs() {
  const text = logsOutput.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    copyLogsButton.textContent = 'Copie';
  } catch (_error) {
    copyLogsButton.textContent = 'Erreur';
  }
  setTimeout(() => {
    copyLogsButton.textContent = 'Copier';
  }, 1500);
}

async function clearLogs() {
  const response = await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }).catch(() => null);
  if (response?.ok) {
    await refreshLogs();
  }
}

function setStatus(status) {
  const state = status?.state || 'idle';
  const completed = status?.completed || 0;
  const total = status?.total || 1;

  stateBadge.textContent = labelForState(state);
  statusText.textContent = status?.message || 'Pret.';
  progress.max = Math.max(total, 1);
  progress.value = Math.min(completed, total);

  startButton.disabled = state === 'running' || state === 'waiting' || state === 'starting';
  stopButton.disabled = !(state === 'running' || state === 'waiting' || state === 'starting');
}

function labelForState(state) {
  const labels = {
    idle: 'Pret',
    starting: 'Depart',
    running: 'En cours',
    waiting: 'Pause',
    done: 'Termine',
    stopped: 'Stop',
    error: 'Erreur'
  };

  return labels[state] || state;
}

