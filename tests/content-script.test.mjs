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
}

function visibleRect(width = 400, height = 100) {
  return { left: 100, top: 700, right: 100 + width, bottom: 700 + height, width, height };
}

test('le parcours prompt image telechargement s execute sans erreur runtime', async () => {
  const runtimeMessages = new MockEvent();
  const statuses = [];
  let existingImageLayoutReads = 0;
  let existingImageLayoutReadsBeforeSend = null;
  const existingImages = Array.from({ length: 100 }, (_, index) => ({
    complete: true,
    naturalWidth: 1024,
    naturalHeight: 1024,
    src: `https://example.test/existing-${index}.png`,
    currentSrc: `https://example.test/existing-${index}.png`,
    getBoundingClientRect() {
      existingImageLayoutReads += 1;
      return visibleRect(600, 600);
    }
  }));
  let generatedImages = existingImages;
  let busy = false;
  let broadButtonScans = 0;
  let focusRequests = 0;

  const editor = {
    tagName: 'TEXTAREA',
    value: '',
    matches: (selector) => selector === 'textarea, input',
    closest: () => null,
    getBoundingClientRect: () => visibleRect(700, 90),
    scrollIntoView() {},
    focus() {},
    dispatchEvent() {}
  };

  const stopButton = {
    tagName: 'BUTTON',
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => visibleRect(40, 40)
  };

  const sendButton = {
    tagName: 'BUTTON',
    disabled: false,
    textContent: '',
    getAttribute(name) {
      return name === 'aria-label' ? 'Envoyer' : null;
    },
    getBoundingClientRect: () => ({
      left: 720,
      top: 720,
      right: 760,
      bottom: 760,
      width: 40,
      height: 40
    }),
    closest: () => sendButton,
    scrollIntoView() {},
    click() {
      existingImageLayoutReadsBeforeSend = existingImageLayoutReads;
      editor.value = '';
      busy = true;
      generatedImages = [{
        complete: true,
        naturalWidth: 1024,
        naturalHeight: 1024,
        src: 'https://example.test/generated.png',
        currentSrc: 'https://example.test/generated.png',
        getBoundingClientRect: () => visibleRect(600, 600)
      }];
      setTimeout(() => {
        busy = false;
      }, 20);
    }
  };

  const document = {
    get images() {
      return generatedImages;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      if (selector === '#prompt-textarea') {
        return [editor];
      }
      if (selector === 'button') {
        broadButtonScans += 1;
        return [sendButton];
      }
      if (selector === 'button[data-testid="send-button"]') {
        return [sendButton];
      }
      if (selector.includes('stop-button') || selector.includes('Stop') || selector.includes('Arrêter')) {
        return busy ? [stopButton] : [];
      }
      return [];
    }
  };

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: runtimeMessages,
      async sendMessage(message) {
        if (message.type === 'AUTOMATION_STATUS') {
          statuses.push(message.status);
          return { ok: true };
        }
        if (message.type === 'FOCUS_CHATGPT_FOR_SEND') {
          focusRequests += 1;
          return { ok: true, token: 'focus-token' };
        }
        if (message.type === 'RESTORE_FOCUS_AFTER_SEND' || message.type === 'LOG_EVENT') {
          return { ok: true };
        }
        if (message.type === 'DOWNLOAD_IMAGE') {
          return { ok: true, finalFilename: 'ChatGPT_images/01.png' };
        }
        return { ok: true };
      },
      connect() {
        throw new Error('Le transfert de secours ne doit pas etre utilise dans ce scenario.');
      }
    }
  };

  const window = {
    __chatGptImageAutomatorLoaded: false,
    innerHeight: 1080,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    getSelection: () => null
  };

  const context = vm.createContext({
    chrome,
    console,
    document,
    window,
    Event,
    InputEvent: Event,
    DOMException,
    URL,
    FileReader: class {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    Promise
  });

  const source = fs.readFileSync(new URL('../content-script.js', import.meta.url), 'utf8');
  vm.runInContext(source, context, { filename: 'content-script.js' });

  const listener = runtimeMessages.listeners[0];
  assert.ok(listener, 'Le listener du script de contenu doit etre installe.');

  const response = await new Promise((resolve) => {
    listener({
      type: 'RUN_CHATGPT_IMAGE_QUEUE',
      entries: [{ key: '01', prompt: 'Generate one image.' }],
      settings: {
        downloadDir: 'ChatGPT_images',
        minDelaySeconds: 0,
        maxDelaySeconds: 0,
        reliableMode: true,
        useGlobalPrefix: false,
        globalPrefix: ''
      }
    }, {}, resolve);
  });

  assert.equal(response.ok, true);

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !statuses.some((status) => status.state === 'done')) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const terminal = statuses.at(-1);
  assert.equal(terminal?.state, 'done', terminal?.message || 'La file ne s’est pas terminee.');
  assert.equal(terminal.completed, 1);
  assert.equal(broadButtonScans, 0, 'Le bouton d’envoi ne doit pas etre cherche parmi tous les boutons de la conversation.');
  assert.equal(focusRequests, 0, 'Le mode fiable maintient deja l’onglet actif et ne doit pas refaire une activation avant l’envoi.');
  assert.equal(existingImageLayoutReadsBeforeSend, 0, 'L’historique des images ne doit pas provoquer de recalcul de mise en page avant chaque prompt.');
});

