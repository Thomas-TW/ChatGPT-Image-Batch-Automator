const CHATGPT_URL = 'https://chatgpt.com/';
const DEFAULT_DOWNLOAD_DIR = 'ChatGPT_images';
const LOG_STORAGE_KEY = 'automationLogs';
const MAX_LOG_ENTRIES = 500;
const IMAGE_TRANSFER_PORT = 'CHATGPT_IMAGE_TRANSFER';

let lastStatus = {
  state: 'idle',
  message: 'Pret.',
  currentKey: null,
  completed: 0,
  total: 0
};

const focusSnapshots = new Map();
const pendingDownloadFilenames = new Map();
const pendingDownloadFilenamesByUrl = new Map();
const pendingDownloadFilenameQueue = [];
let logWriteQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);
chrome.runtime.onConnect.addListener(handleImageTransferPort);

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const filename = pendingDownloadFilenames.get(downloadItem.id)
    || takePendingFilenameForUrl(downloadItem.url)
    || takePendingFilenameForUrl(downloadItem.finalUrl)
    || takePendingFilenameFromQueue(downloadItem);

  if (!filename) {
    return;
  }

  writeLog('debug', 'download', 'Nom de fichier force par Chrome.', {
    downloadId: downloadItem.id,
    filename
  });

  pendingDownloadFilenames.delete(downloadItem.id);
  removePendingFilenameFromQueue(filename);
  suggest({
    filename,
    conflictAction: 'overwrite'
  });
  return true;
});

function configureSidePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === 'START_AUTOMATION') {
    startAutomation(message.entries, message.settings)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'STOP_AUTOMATION') {
    stopAutomation()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'GET_STATUS') {
    sendResponse({ ok: true, status: lastStatus });
    return false;
  }

  if (message.type === 'GET_LOGS') {
    getLogs()
      .then((logs) => sendResponse({ ok: true, logs }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'CLEAR_LOGS') {
    clearLogs()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'LOG_EVENT') {
    writeLog(message.level, message.scope, message.event, message.details);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'AUTOMATION_STATUS') {
    lastStatus = {
      ...lastStatus,
      ...message.status
    };
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'DOWNLOAD_IMAGE') {
    downloadImage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'FOCUS_CHATGPT_FOR_SEND') {
    focusChatGptForSend(sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'RESTORE_FOCUS_AFTER_SEND') {
    restoreFocusAfterSend(message.token)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'KEEP_CHATGPT_TAB_ACTIVE') {
    keepChatGptTabActive(sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function startAutomation(entries, settings = {}) {
  const validEntries = Array.isArray(entries)
    ? entries.filter((entry) => String(entry?.prompt || '').trim().toLowerCase() !== 'text')
    : [];

  if (validEntries.length === 0) {
    throw new Error('Aucun prompt valide a traiter.');
  }

  const normalizedSettings = {
    ...settings,
    downloadDir: sanitizeDownloadDir(settings?.downloadDir || DEFAULT_DOWNLOAD_DIR)
  };

  writeLog('info', 'automation', 'Demarrage demande.', {
    prompts: validEntries.length,
    downloadDir: normalizedSettings.downloadDir,
    reliableMode: Boolean(normalizedSettings.reliableMode),
    globalPrefix: Boolean(normalizedSettings.useGlobalPrefix && normalizedSettings.globalPrefix)
  });

  lastStatus = {
    state: 'starting',
    message: 'Verification du dossier et du renommage...',
    currentKey: null,
    completed: 0,
    total: validEntries.length
  };

  try {
    await verifyDownloadRouting(normalizedSettings.downloadDir);
    writeLog('info', 'download', 'Verification du dossier et du nommage reussie.', {
      downloadDir: normalizedSettings.downloadDir
    });
  } catch (error) {
    writeLog('error', 'download', 'Verification du dossier et du nommage echouee.', {
      error: error.message
    });
    lastStatus = {
      ...lastStatus,
      state: 'error',
      message: error.message
    };
    throw error;
  }

  const tab = await getOrCreateChatGptTab();
  await ensureContentScript(tab.id);

  if (normalizedSettings.reliableMode) {
    await chrome.tabs.update(tab.id, { active: true });
  }

  lastStatus = {
    state: 'starting',
    message: 'Demarrage dans ChatGPT...',
    currentKey: null,
    completed: 0,
    total: validEntries.length
  };

  await chrome.tabs.sendMessage(tab.id, {
    type: 'RUN_CHATGPT_IMAGE_QUEUE',
    entries: validEntries,
    settings: normalizedSettings
  });

  writeLog('info', 'automation', 'File envoyee au script ChatGPT.', {
    tabId: tab.id,
    prompts: validEntries.length
  });

  return { ok: true, tabId: tab.id };
}

async function stopAutomation() {
  const tabs = await queryChatGptTabs();
  await Promise.allSettled(
    tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'STOP_CHATGPT_IMAGE_QUEUE' }))
  );

  lastStatus = {
    ...lastStatus,
    state: 'stopped',
    message: 'Arret demande.'
  };

  return { ok: true };
}

async function getOrCreateChatGptTab() {
  const tabs = await queryChatGptTabs();
  const existing = tabs.find((tab) => tab.id != null);

  if (existing) {
    if (!isChatGptUrl(existing.url)) {
      await chrome.tabs.update(existing.id, { url: CHATGPT_URL, active: false });
      await waitForTabComplete(existing.id);
    }
    return chrome.tabs.get(existing.id);
  }

  const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: false });
  await waitForTabComplete(tab.id);
  return chrome.tabs.get(tab.id);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING_CHATGPT_IMAGE_AUTOMATOR' });
    return;
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js']
    });
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('ChatGPT met trop longtemps a charger.'));
    }, 60000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') {
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        } else {
          chrome.tabs.onUpdated.addListener(listener);
        }
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(error);
      });
  });
}

async function downloadImage(message) {
  const downloadUrl = message.dataUrl || message.url;

  if (!downloadUrl) {
    throw new Error('URL image manquante.');
  }

  const extension = sanitizeExtension(message.extension || 'png');
  const key = sanitizeFilenamePart(message.key || 'image');
  const suffix = sanitizeOptionalFilenamePart(message.suffix || '');
  const downloadDir = sanitizeDownloadDir(message.downloadDir || DEFAULT_DOWNLOAD_DIR);
  const filename = `${downloadDir}/${key}${suffix}.${extension}`;

  writeLog('info', 'download', 'Telechargement direct demande.', {
    filename,
    source: describeUrl(downloadUrl)
  });

  let downloadItem;
  try {
    downloadItem = await downloadWithForcedFilename(downloadUrl, filename, message.timeoutMs);
  } catch (error) {
    writeLog('warn', 'download', 'Telechargement direct echoue.', {
      filename,
      error: error.message
    });
    throw error;
  }

  writeLog('info', 'download', 'Telechargement termine et verifie.', {
    downloadId: downloadItem.id,
    filename: downloadItem.filename
  });

  return {
    ok: true,
    downloadId: downloadItem.id,
    filename,
    finalFilename: downloadItem.filename
  };
}

async function downloadWithForcedFilename(downloadUrl, filename, timeoutMs = 120000) {
  addPendingFilenameForUrl(downloadUrl, filename);
  pendingDownloadFilenameQueue.push(filename);
  let downloadId = null;

  try {
    downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      conflictAction: 'overwrite',
      saveAs: false
    });
    writeLog('debug', 'download', 'Chrome a cree le telechargement.', {
      downloadId,
      filename
    });
    pendingDownloadFilenames.set(downloadId, filename);

    const downloadItem = await waitForDownloadComplete(downloadId, normalizeDownloadTimeout(timeoutMs));

    try {
      assertDownloadFilename(downloadItem, filename);
    } catch (error) {
      await removeDownloadedFile(downloadItem.id);
      throw error;
    }

    return downloadItem;
  } catch (error) {
    if (downloadId != null) {
      await chrome.downloads.cancel(downloadId).catch(() => {});
      await removeDownloadedFile(downloadId);
    }
    throw error;
  } finally {
    removePendingFilenameForUrl(downloadUrl, filename);
    removePendingFilenameFromQueue(filename);
    if (downloadId != null) {
      pendingDownloadFilenames.delete(downloadId);
    }
  }
}

function handleImageTransferPort(port) {
  if (port.name !== IMAGE_TRANSFER_PORT) {
    return;
  }

  const transfer = {
    metadata: null,
    chunks: [],
    nextIndex: 0,
    finished: false
  };

  writeLog('debug', 'transfer', 'Canal de transfert image ouvert.');

  port.onMessage.addListener((message) => {
    handleImageTransferMessage(port, transfer, message).catch((error) => {
      writeLog('error', 'transfer', 'Transfert image echoue.', {
        error: error.message,
        key: transfer.metadata?.key || null
      });
      safelyPostPortMessage(port, { type: 'ERROR', error: error.message });
    });
  });

  port.onDisconnect.addListener(() => {
    if (!transfer.finished && transfer.metadata) {
      writeLog('warn', 'transfer', 'Canal ferme avant la fin du transfert.', {
        key: transfer.metadata.key,
        chunksReceived: transfer.nextIndex,
        chunksExpected: transfer.metadata.totalChunks
      });
    }
  });
}

async function handleImageTransferMessage(port, transfer, message) {
  if (!message?.type || transfer.finished) {
    return;
  }

  if (message.type === 'START') {
    if (transfer.metadata) {
      throw new Error('Le transfert image a deja demarre.');
    }

    const metadata = message.metadata || {};
    const totalChunks = Number(metadata.totalChunks);
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 10000) {
      throw new Error('Nombre de blocs image invalide.');
    }

    transfer.metadata = {
      key: sanitizeFilenamePart(metadata.key || 'image'),
      suffix: sanitizeOptionalFilenamePart(metadata.suffix || ''),
      extension: sanitizeExtension(metadata.extension || 'png'),
      downloadDir: sanitizeDownloadDir(metadata.downloadDir || DEFAULT_DOWNLOAD_DIR),
      mimeType: sanitizeImageMimeType(metadata.mimeType),
      totalChunks,
      totalCharacters: Number(metadata.totalCharacters) || 0
    };
    transfer.chunks = new Array(totalChunks);

    writeLog('info', 'transfer', 'Transfert image de secours demarre.', {
      key: transfer.metadata.key,
      totalChunks,
      totalCharacters: transfer.metadata.totalCharacters
    });
    safelyPostPortMessage(port, { type: 'READY' });
    return;
  }

  if (!transfer.metadata) {
    throw new Error('Metadonnees de transfert absentes.');
  }

  if (message.type === 'CHUNK') {
    if (message.index !== transfer.nextIndex || typeof message.data !== 'string') {
      throw new Error(`Bloc image inattendu : ${message.index}.`);
    }

    transfer.chunks[message.index] = message.data;
    transfer.nextIndex += 1;
    safelyPostPortMessage(port, { type: 'ACK', index: message.index });
    return;
  }

  if (message.type === 'FINISH') {
    if (transfer.nextIndex !== transfer.metadata.totalChunks) {
      throw new Error(`Transfert incomplet : ${transfer.nextIndex}/${transfer.metadata.totalChunks} blocs.`);
    }

    transfer.finished = true;
    const dataUrl = `data:${transfer.metadata.mimeType};base64,${transfer.chunks.join('')}`;
    transfer.chunks = [];

    const result = await downloadImage({
      dataUrl,
      key: transfer.metadata.key,
      suffix: transfer.metadata.suffix,
      extension: transfer.metadata.extension,
      downloadDir: transfer.metadata.downloadDir
    });

    safelyPostPortMessage(port, { type: 'DONE', result });
    writeLog('info', 'transfer', 'Transfert image de secours termine.', {
      key: transfer.metadata.key,
      filename: result.finalFilename
    });
    port.disconnect();
  }
}

function safelyPostPortMessage(port, message) {
  try {
    port.postMessage(message);
  } catch (_error) {
    // Le script de contenu peut avoir ete recharge entre-temps.
  }
}

function sanitizeImageMimeType(value) {
  const mimeType = String(value || '').toLowerCase();
  return /^image\/(png|jpeg|jpg|webp|gif)$/.test(mimeType) ? mimeType : 'image/png';
}

async function verifyDownloadRouting(downloadDir) {
  const filename = `${downloadDir}/_chatgpt_automator_download_test.png`;
  const transparentPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  let downloadItem = null;

  try {
    downloadItem = await downloadWithForcedFilename(transparentPixel, filename);
  } catch (error) {
    throw new Error(`Verification du dossier/nommage impossible : ${error.message}`);
  } finally {
    if (downloadItem?.id != null) {
      await removeDownloadedFile(downloadItem.id);
    }
  }
}

async function removeDownloadedFile(downloadId) {
  await chrome.downloads.removeFile(downloadId).catch(() => {});
  await chrome.downloads.erase({ id: downloadId }).catch(() => {});
}

function addPendingFilenameForUrl(url, filename) {
  const queue = pendingDownloadFilenamesByUrl.get(url) || [];
  queue.push(filename);
  pendingDownloadFilenamesByUrl.set(url, queue);
}

function takePendingFilenameForUrl(url) {
  if (!url) {
    return null;
  }

  const queue = pendingDownloadFilenamesByUrl.get(url);
  if (!queue || queue.length === 0) {
    return null;
  }

  const filename = queue.shift();
  if (queue.length === 0) {
    pendingDownloadFilenamesByUrl.delete(url);
  }

  return filename;
}

function takePendingFilenameFromQueue(downloadItem) {
  const isOwnDownload = downloadItem.byExtensionId === chrome.runtime.id
    || String(downloadItem.url || '').startsWith('data:image/');

  if (!isOwnDownload || pendingDownloadFilenameQueue.length === 0) {
    return null;
  }

  return pendingDownloadFilenameQueue.shift();
}

function removePendingFilenameFromQueue(filename) {
  const index = pendingDownloadFilenameQueue.indexOf(filename);
  if (index !== -1) {
    pendingDownloadFilenameQueue.splice(index, 1);
  }
}

function removePendingFilenameForUrl(url, filename) {
  const queue = pendingDownloadFilenamesByUrl.get(url);

  if (!queue) {
    return;
  }

  const index = queue.indexOf(filename);
  if (index !== -1) {
    queue.splice(index, 1);
  }

  if (queue.length === 0) {
    pendingDownloadFilenamesByUrl.delete(url);
  }
}

function waitForDownloadComplete(downloadId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      reject(new Error('Delai depasse en attendant la fin du telechargement.'));
    }, timeoutMs);

    function finishWithSearch() {
      chrome.downloads.search({ id: downloadId })
        .then((items) => {
          const item = items[0];
          if (!item) {
            throw new Error('Telechargement introuvable apres creation.');
          }
          resolve(item);
        })
        .catch(reject)
        .finally(() => {
          clearTimeout(timeoutId);
          chrome.downloads.onChanged.removeListener(listener);
          pendingDownloadFilenames.delete(downloadId);
        });
    }

    function listener(delta) {
      if (delta.id !== downloadId || !delta.state?.current) {
        return;
      }

      if (delta.state.current === 'complete') {
        finishWithSearch();
      }

      if (delta.state.current === 'interrupted') {
        clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(listener);
        pendingDownloadFilenames.delete(downloadId);
        reject(new Error('Telechargement interrompu par Chrome.'));
      }
    }

    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id: downloadId }).then((items) => {
      if (items[0]?.state === 'complete') {
        finishWithSearch();
      }
    });
  });
}

function normalizeDownloadTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 120000;
  }
  return Math.min(Math.max(Math.round(parsed), 10000), 180000);
}

function assertDownloadFilename(downloadItem, expectedRelativeFilename) {
  const actual = normalizePathForCompare(downloadItem.filename || '');
  const expected = normalizePathForCompare(expectedRelativeFilename);

  if (!actual.endsWith(expected)) {
    throw new Error(`Chrome a enregistre le fichier au mauvais endroit ou sous le mauvais nom : ${downloadItem.filename}`);
  }
}

function normalizePathForCompare(value) {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

async function focusChatGptForSend(sender) {
  const chatGptTab = sender.tab;

  if (!chatGptTab?.id || !chatGptTab.windowId) {
    throw new Error('Onglet ChatGPT introuvable pour le focus.');
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lastFocusedWindow = await chrome.windows.getLastFocused();
  const activeTabs = await chrome.tabs.query({
    active: true,
    windowId: lastFocusedWindow.id
  });
  const previousTab = activeTabs[0] || null;

  focusSnapshots.set(token, {
    windowId: lastFocusedWindow.id,
    tabId: previousTab?.id || null,
    shouldRestore: previousTab?.id !== chatGptTab.id
  });

  await chrome.windows.update(chatGptTab.windowId, { focused: true });
  await chrome.tabs.update(chatGptTab.id, { active: true });

  return { ok: true, token };
}

async function restoreFocusAfterSend(token) {
  const snapshot = focusSnapshots.get(token);

  if (!snapshot) {
    return { ok: true };
  }

  focusSnapshots.delete(token);

  if (!snapshot.shouldRestore || !snapshot.tabId) {
    return { ok: true };
  }

  try {
    await chrome.windows.update(snapshot.windowId, { focused: true });
    await chrome.tabs.update(snapshot.tabId, { active: true });
  } catch (_error) {
    return { ok: true };
  }

  return { ok: true };
}

async function keepChatGptTabActive(sender) {
  const chatGptTab = sender.tab;

  if (!chatGptTab?.id) {
    throw new Error('Onglet ChatGPT introuvable.');
  }

  await chrome.tabs.update(chatGptTab.id, { active: true });
  return { ok: true };
}

function sanitizeFilenamePart(value) {
  return String(value)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'image';
}

async function queryChatGptTabs() {
  const [chatgptTabs, legacyTabs] = await Promise.all([
    chrome.tabs.query({ url: 'https://chatgpt.com/*' }),
    chrome.tabs.query({ url: 'https://chat.openai.com/*' })
  ]);

  return [...chatgptTabs, ...legacyTabs];
}

function isChatGptUrl(url) {
  return typeof url === 'string'
    && (url.startsWith('https://chatgpt.com/') || url.startsWith('https://chat.openai.com/'));
}

function sanitizeOptionalFilenamePart(value) {
  return String(value)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 40);
}

function sanitizeDownloadDir(value) {
  const parts = String(value)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);

  if (parts.length === 0) {
    return DEFAULT_DOWNLOAD_DIR;
  }

  const safeParts = parts
    .filter((part) => part !== '.' && part !== '..')
    .map((part) => sanitizeFilenamePart(part));

  return safeParts.join('/') || DEFAULT_DOWNLOAD_DIR;
}

function sanitizeExtension(value) {
  const extension = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  return extension || 'png';
}

function writeLog(level = 'info', scope = 'extension', event = '', details = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: normalizeLogLevel(level),
    scope: String(scope || 'extension').slice(0, 40),
    event: String(event || '').slice(0, 500),
    details: sanitizeLogDetails(details)
  };

  const consoleMethod = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'log';
  console[consoleMethod]('[ChatGPT Images]', entry.scope, entry.event, entry.details || '');

  logWriteQueue = logWriteQueue
    .then(async () => {
      const data = await chrome.storage.local.get({ [LOG_STORAGE_KEY]: [] });
      const logs = Array.isArray(data[LOG_STORAGE_KEY]) ? data[LOG_STORAGE_KEY] : [];
      logs.push(entry);
      await chrome.storage.local.set({
        [LOG_STORAGE_KEY]: logs.slice(-MAX_LOG_ENTRIES)
      });
    })
    .catch((error) => {
      console.error('[ChatGPT Images] Impossible d\'ecrire le journal.', error);
    });

  return logWriteQueue;
}

async function getLogs() {
  await logWriteQueue;
  const data = await chrome.storage.local.get({ [LOG_STORAGE_KEY]: [] });
  return Array.isArray(data[LOG_STORAGE_KEY]) ? data[LOG_STORAGE_KEY] : [];
}

async function clearLogs() {
  await logWriteQueue;
  await chrome.storage.local.set({ [LOG_STORAGE_KEY]: [] });
  writeLog('info', 'logs', 'Journal efface par l’utilisateur.');
}

function normalizeLogLevel(value) {
  const level = String(value || '').toLowerCase();
  return ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
}

function sanitizeLogDetails(details) {
  if (details == null) {
    return null;
  }

  try {
    const serialized = JSON.stringify(details, (_key, value) => {
      if (typeof value === 'string' && value.length > 1000) {
        return `${value.slice(0, 1000)}...[tronque]`;
      }
      return value;
    });
    return JSON.parse(serialized);
  } catch (_error) {
    return { value: String(details).slice(0, 1000) };
  }
}

function describeUrl(value) {
  const source = String(value || '');
  if (source.startsWith('data:')) {
    return `data:${source.slice(5, source.indexOf(';') > 5 ? source.indexOf(';') : 40)}`;
  }

  if (source.startsWith('blob:')) {
    return 'blob:local';
  }

  try {
    const url = new URL(source);
    return `${url.protocol}//${url.hostname}${url.pathname}`.slice(0, 500);
  } catch (_error) {
    return source.slice(0, 500);
  }
}

