import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class MockEvent {
  constructor() {
    this.listeners = [];
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  removeListener(listener) {
    this.listeners = this.listeners.filter((candidate) => candidate !== listener);
  }

  dispatch(...args) {
    return this.listeners.map((listener) => listener(...args));
  }
}

function createChromeMock() {
  const storage = {};
  const downloadItems = new Map();
  const sentTabMessages = [];
  let nextDownloadId = 1;

  const events = {
    onMessage: new MockEvent(),
    onConnect: new MockEvent(),
    onDeterminingFilename: new MockEvent(),
    onChanged: new MockEvent()
  };

  const chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null,
      onInstalled: new MockEvent(),
      onStartup: new MockEvent(),
      onMessage: events.onMessage,
      onConnect: events.onConnect
    },
    sidePanel: {
      setPanelBehavior: async () => {}
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        }
      }
    },
    downloads: {
      onDeterminingFilename: events.onDeterminingFilename,
      onChanged: events.onChanged,
      async download(options) {
        const id = nextDownloadId++;
        let filename = options.filename;
        const item = {
          id,
          url: options.url,
          finalUrl: options.url,
          filename,
          state: 'in_progress',
          byExtensionId: chrome.runtime.id
        };

        events.onDeterminingFilename.dispatch(item, (suggestion) => {
          filename = suggestion.filename;
          item.filename = `C:/Users/Test/Downloads/${filename}`;
        });

        if (!item.filename.includes(':/')) {
          item.filename = `C:/Users/Test/Downloads/${filename}`;
        }

        downloadItems.set(id, item);
        setTimeout(() => {
          item.state = 'complete';
          events.onChanged.dispatch({ id, state: { current: 'complete' } });
        }, 5);
        return id;
      },
      async search({ id }) {
        return downloadItems.has(id) ? [downloadItems.get(id)] : [];
      },
      async removeFile() {},
      async erase() {},
      async cancel() {}
    },
    tabs: {
      query: async () => [],
      create: async () => ({ id: 1 }),
      get: async () => ({ id: 1, status: 'complete' }),
      update: async () => ({}),
      sendMessage: async (tabId, message) => {
        sentTabMessages.push({ tabId, message });
        return { ok: true };
      },
      onUpdated: new MockEvent()
    },
    scripting: { executeScript: async () => {} },
    windows: {
      getLastFocused: async () => ({ id: 1 }),
      update: async () => ({})
    }
  };

  return { chrome, events, storage, sentTabMessages };
}

function loadBackground() {
  const mocks = createChromeMock();
  const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    chrome: mocks.chrome,
    console,
    URL,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Promise
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  return mocks;
}

function sendRuntimeMessage(event, message) {
  return new Promise((resolve, reject) => {
    const listener = event.listeners[0];
    if (!listener) {
      reject(new Error('Aucun listener runtime installe.'));
      return;
    }
    listener(message, {}, resolve);
  });
}

function createPort() {
  const onMessage = new MockEvent();
  const onDisconnect = new MockEvent();
  const outgoing = [];
  let disconnected = false;

  return {
    name: 'CHATGPT_IMAGE_TRANSFER',
    onMessage,
    onDisconnect,
    postMessage(message) {
      outgoing.push(message);
    },
    disconnect() {
      if (!disconnected) {
        disconnected = true;
        onDisconnect.dispatch();
      }
    },
    outgoing
  };
}

async function waitForPortMessage(port, type, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = port.outgoing.find((candidate) => candidate.type === type);
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Message port ${type} non recu.`);
}

test('telechargement direct renomme et journalise le fichier', async () => {
  const { events } = loadBackground();
  const response = await sendRuntimeMessage(events.onMessage, {
    type: 'DOWNLOAD_IMAGE',
    url: 'https://example.test/generated.png?token=secret',
    key: '01',
    suffix: '',
    extension: 'png',
    downloadDir: 'ChatGPT_images'
  });

  assert.equal(response.ok, true);
  assert.match(response.finalFilename, /ChatGPT_images\/01\.png$/);
  const logsResponse = await sendRuntimeMessage(events.onMessage, { type: 'GET_LOGS' });
  assert.ok(logsResponse.logs.some((entry) => entry.event === 'Telechargement termine et verifie.'));
  assert.ok(!JSON.stringify(logsResponse.logs).includes('token=secret'));
});

test('transfert par blocs reconstruit puis telecharge l image', async () => {
  const { events } = loadBackground();
  const port = createPort();
  events.onConnect.dispatch(port);

  port.onMessage.dispatch({
    type: 'START',
    metadata: {
      key: '02',
      suffix: '',
      extension: 'png',
      downloadDir: 'ChatGPT_images',
      mimeType: 'image/png',
      totalChunks: 2,
      totalCharacters: 8
    }
  });
  await waitForPortMessage(port, 'READY');

  port.onMessage.dispatch({ type: 'CHUNK', index: 0, data: 'QUJD' });
  await waitForPortMessage(port, 'ACK');
  port.onMessage.dispatch({ type: 'CHUNK', index: 1, data: 'RA==' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  port.onMessage.dispatch({ type: 'FINISH' });

  const done = await waitForPortMessage(port, 'DONE');
  assert.equal(done.result.ok, true);
  assert.match(done.result.finalFilename, /ChatGPT_images\/02\.png$/);
});

test('une entree JSON marquee text est ignoree avant l envoi a ChatGPT', async () => {
  const { events, sentTabMessages } = loadBackground();
  const response = await sendRuntimeMessage(events.onMessage, {
    type: 'START_AUTOMATION',
    entries: [
      { key: '08', prompt: 'Generate scene eight.' },
      { key: '09', prompt: ' text ' },
      { key: '10', prompt: 'Generate scene ten.' }
    ],
    settings: { downloadDir: 'ChatGPT_images' }
  });

  assert.equal(response.ok, true);
  const queueMessage = sentTabMessages.find(({ message }) => message.type === 'RUN_CHATGPT_IMAGE_QUEUE');
  assert.deepEqual(queueMessage.message.entries, [
    { key: '08', prompt: 'Generate scene eight.' },
    { key: '10', prompt: 'Generate scene ten.' }
  ]);
});
