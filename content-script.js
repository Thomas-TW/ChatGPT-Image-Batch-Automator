(() => {
  if (window.__chatGptImageAutomatorLoaded) {
    return;
  }
  window.__chatGptImageAutomatorLoaded = true;

  const DEFAULT_MIN_DELAY_SECONDS = 5;
  const DEFAULT_MAX_DELAY_SECONDS = 15;
  const DEFAULT_DOWNLOAD_DIR = 'ChatGPT_images';
  const RESPONSE_TIMEOUT_MS = 12 * 60 * 1000;
  const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
  const IMAGE_TRANSFER_PORT = 'CHATGPT_IMAGE_TRANSFER';
  const TRANSFER_CHUNK_SIZE = 256 * 1024;

  let activeRun = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === 'PING_CHATGPT_IMAGE_AUTOMATOR') {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'RUN_CHATGPT_IMAGE_QUEUE') {
      if (activeRun?.running) {
        sendResponse({ ok: false, error: 'Une automatisation est deja en cours.' });
        return false;
      }

      activeRun = {
        running: true,
        aborted: false,
        settings: normalizeSettings(message.settings)
      };
      runQueue(message.entries, activeRun).finally(() => {
        if (activeRun) {
          activeRun.running = false;
        }
      });
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'STOP_CHATGPT_IMAGE_QUEUE') {
      if (activeRun) {
        activeRun.aborted = true;
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  async function runQueue(entries, run) {
    try {
      logEvent('info', 'queue', 'File demarree.', { prompts: entries.length });
      await publishStatus({
        state: 'running',
        message: 'Automatisation en cours...',
        completed: 0,
        total: entries.length
      });

      for (let index = 0; index < entries.length; index += 1) {
        ensureNotAborted(run);
        await keepChatGptActiveIfReliable(run);

        const item = entries[index];
        logEvent('info', 'queue', 'Traitement du prompt.', {
          key: item.key,
          index: index + 1,
          total: entries.length
        });
        await publishStatus({
          state: 'running',
          currentKey: item.key,
          completed: index,
          total: entries.length,
          message: `Generation ${index + 1}/${entries.length} : ${item.key}`
        });

        const beforeImages = collectImageSignatures();
        await submitPrompt(buildPrompt(item.prompt, run.settings));
        logEvent('info', 'prompt', 'Prompt envoye a ChatGPT.', { key: item.key });
        const images = await waitForNewImages(beforeImages, run);

        if (images.length === 0) {
          throw new Error(`Aucune image detectee pour le prompt ${item.key}.`);
        }

        logEvent('info', 'image', 'Nouvelles images detectees.', {
          key: item.key,
          count: images.length,
          sources: images.map((image) => describeImageSource(image.src))
        });

        for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
          ensureNotAborted(run);
          const image = images[imageIndex];
          const suffix = images.length > 1 ? String.fromCharCode(97 + imageIndex) : '';
          const imageLabel = `${item.key}${suffix}`;

          await publishStatus({
            state: 'running',
            currentKey: item.key,
            completed: index,
            total: entries.length,
            message: `Preparation du telechargement ${imageLabel}...`
          });

          await publishStatus({
            state: 'running',
            currentKey: item.key,
            completed: index,
            total: entries.length,
            message: `Telechargement de l'image ${imageLabel}...`
          });

          const downloadResponse = await downloadImageResilient(image.src, {
            key: item.key,
            suffix,
            downloadDir: run.settings.downloadDir
          });

          if (!downloadResponse?.ok) {
            throw new Error(downloadResponse?.error || `Telechargement impossible pour ${imageLabel}.`);
          }
        }

        await publishStatus({
          state: 'running',
          currentKey: item.key,
          completed: index + 1,
          total: entries.length,
          message: `Image ${item.key} telechargee.`
        });

        if (index < entries.length - 1) {
          const delayMs = randomDelay(run.settings);
          if (delayMs > 0) {
            await waitBeforeNextPrompt(delayMs, run, index + 1, entries.length);
          }
        }
      }

      await publishStatus({
        state: 'done',
        currentKey: null,
        completed: entries.length,
        total: entries.length,
        message: 'Termine.'
      });
      logEvent('info', 'queue', 'File terminee.', { prompts: entries.length });
    } catch (error) {
      const state = error.name === 'AbortError' ? 'stopped' : 'error';
      logEvent(state === 'error' ? 'error' : 'warn', 'queue', 'File interrompue.', {
        state,
        error: error.message || 'Erreur inconnue.'
      });
      await publishStatus({
        state,
        message: error.message || 'Erreur inconnue.'
      });
    }
  }

  async function submitPrompt(prompt) {
    const editor = await waitForElement(findPromptEditor, 60000, 'Champ de prompt ChatGPT introuvable.');
    editor.scrollIntoView({ block: 'center', inline: 'nearest' });
    editor.focus();

    if (editor.matches('textarea, input')) {
      editor.value = prompt;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, prompt);
      editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: prompt
      }));
    }

    await sleep(250);

    const sendButton = await waitForElement(
      () => findSendButton(editor),
      30000,
      'Bouton Envoyer introuvable ou desactive.'
    );

    await clickSendButton(sendButton, editor);
  }

  async function waitForNewImages(beforeSignatures, run) {
    const startedAt = Date.now();
    let stableSince = null;
    let lastSignature = '';
    let lastImages = [];

    logEvent('info', 'image', 'Attente d’une nouvelle image.', {
      imagesAlreadyPresent: beforeSignatures.size
    });

    while (Date.now() - startedAt < RESPONSE_TIMEOUT_MS) {
      ensureNotAborted(run);
      await keepChatGptActiveIfReliable(run);

      const candidates = collectDownloadableImages()
        .filter((image) => !beforeSignatures.has(image.signature));

      const signature = candidates.map((image) => image.signature).join('|');

      if (candidates.length > 0 && signature === lastSignature) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince > 3500) {
          return candidates;
        }
      } else {
        stableSince = null;
        lastSignature = signature;
        lastImages = candidates;
        if (candidates.length > 0) {
          logEvent('debug', 'image', 'Candidats image mis a jour.', {
            count: candidates.length,
            sources: candidates.map((image) => describeImageSource(image.src))
          });
        }
      }

      if (lastImages.length > 0 && Date.now() - startedAt > 15000) {
        return lastImages;
      }

      await sleep(1000, run);
    }

    throw new Error('Delai depasse en attendant la generation de ChatGPT.');
  }

  function findPromptEditor() {
    const selectors = [
      '#prompt-textarea',
      '#prompt-textarea[contenteditable="true"]',
      '[data-testid="composer"] div[contenteditable="true"]',
      'form div[contenteditable="true"]',
      '.ProseMirror[contenteditable="true"]',
      'textarea:not([disabled])',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]'
    ];

    for (const selector of selectors) {
      const firstMatch = document.querySelector(selector);
      if (firstMatch && isVisible(firstMatch) && !firstMatch.closest('[aria-hidden="true"]')) {
        return firstMatch;
      }

      const elements = [...document.querySelectorAll(selector)];
      const visible = elements.find((element) => isVisible(element) && !element.closest('[aria-hidden="true"]'));
      if (visible) {
        return visible;
      }
    }

    return null;
  }

  async function clickSendButton(sendButton, editor) {
    const focusToken = activeRun?.settings?.reliableMode
      ? null
      : await focusChatGptForSend();

    try {
      await sleep(100);

      sendButton.scrollIntoView({ block: 'center', inline: 'center' });
      dispatchMouseClick(sendButton);

      const startedAt = Date.now();
      while (Date.now() - startedAt < 12000) {
        await sleep(500);

        if (isChatGptBusy() || !getEditableText(editor).trim() || !isUsableButton(sendButton)) {
          return;
        }
      }

      throw new Error('Le bouton Envoyer a ete clique, mais ChatGPT n\'a pas confirme la generation. Relance manuelle conseillee pour eviter un doublon.');
    } finally {
      if (!activeRun?.settings?.reliableMode) {
        await restoreFocusAfterSend(focusToken);
      }
    }
  }

  async function focusChatGptForSend() {
    const response = await chrome.runtime.sendMessage({ type: 'FOCUS_CHATGPT_FOR_SEND' });
    if (!response?.ok) {
      return null;
    }

    return response.token || null;
  }

  async function restoreFocusAfterSend(token) {
    if (!token) {
      return;
    }

    await chrome.runtime.sendMessage({
      type: 'RESTORE_FOCUS_AFTER_SEND',
      token
    }).catch(() => {});
  }

  async function keepChatGptActiveIfReliable(run) {
    if (!run?.settings?.reliableMode) {
      return;
    }

    await chrome.runtime.sendMessage({ type: 'KEEP_CHATGPT_TAB_ACTIVE' }).catch(() => {});
  }

  function dispatchMouseClick(element) {
    element.click();
  }

  function findSendButton(editor) {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid*="send" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Envoyer" i]',
      'button[aria-label*="message" i]',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Soumettre" i]'
    ];

    const composer = findComposerContainer(editor);

    for (const selector of selectors) {
      const candidate = composer.querySelector(selector);
      if (isUsableButton(candidate)) {
        return candidate;
      }
    }

    const localButtons = [...composer.querySelectorAll('button')].filter(isUsableButton);
    const labelledLocalButton = localButtons.find((button) => isSendButtonLabel(buttonLabel(button)));
    if (labelledLocalButton) {
      return labelledLocalButton;
    }

    const directCandidates = [];
    for (const selector of selectors) {
      const candidate = document.querySelector(selector);
      if (isUsableButton(candidate)) {
        directCandidates.push(candidate);
      }
    }

    return pickBestSendButton(directCandidates, editor);
  }

  function findComposerContainer(editor) {
    return editor.closest('form')
      || editor.closest('[data-testid="composer"]')
      || editor.parentElement?.parentElement
      || editor.parentElement
      || document;
  }

  function isSendButtonLabel(label) {
    return label.includes('send')
      || label.includes('envoyer')
      || label.includes('submit')
      || label.includes('soumettre')
      || label.includes('arrow_upward');
  }

  function pickBestSendButton(buttons, editor) {
    const uniqueButtons = [...new Set(buttons)].filter(isUsableButton);
    const editorRect = editor.getBoundingClientRect();
    const scored = uniqueButtons
      .map((button) => ({ button, score: scoreSendButton(button, editorRect) }))
      .filter((item) => item.score > -Infinity)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.button || null;
  }

  function scoreSendButton(button, editorRect) {
    const rect = button.getBoundingClientRect();
    const label = buttonLabel(button);
    let score = 0;

    if (label.includes('send') || label.includes('envoyer') || label.includes('submit') || label.includes('soumettre')) {
      score += 80;
    }

    if (label.includes('arrow_upward') || label.includes('send')) {
      score += 30;
    }

    const isNearEditorVertically = rect.top >= editorRect.top - 80 && rect.bottom <= editorRect.bottom + 120;
    const isToTheRight = rect.left >= editorRect.left + editorRect.width * 0.45;
    const isInComposerBand = rect.top >= window.innerHeight * 0.55;

    if (isNearEditorVertically) {
      score += 45;
    }

    if (isToTheRight) {
      score += 25;
    }

    if (isInComposerBand) {
      score += 15;
    }

    if (rect.width <= 64 && rect.height <= 64) {
      score += 10;
    }

    if (rect.bottom < editorRect.top - 100 || rect.top > editorRect.bottom + 180) {
      score -= 80;
    }

    return score;
  }

  function isUsableButton(button) {
    return button
      && button.tagName === 'BUTTON'
      && isVisible(button)
      && !button.disabled
      && button.getAttribute('aria-disabled') !== 'true';
  }

  function buttonLabel(button) {
    return [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.textContent
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function getEditableText(editor) {
    if (editor.matches('textarea, input')) {
      return editor.value || '';
    }

    return editor.textContent || '';
  }

  function isChatGptBusy() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop responding" i]',
      'button[aria-label*="Arrêter la génération" i]',
      'button[aria-label*="Arrêter la réponse" i]',
      'button[aria-label="Stop" i]',
      'button[aria-label="Arrêter" i]'
    ];

    return selectors.some((selector) =>
      [...document.querySelectorAll(selector)].some(isVisible)
    );
  }

  function collectImageSignatures() {
    const signatures = new Set();

    for (const image of document.images) {
      if (!image.complete || image.naturalWidth < 256 || image.naturalHeight < 256) {
        continue;
      }

      const src = image.currentSrc || image.src;
      if (!src || src.startsWith('chrome-extension://')) {
        continue;
      }

      signatures.add(`${src}:${image.naturalWidth}x${image.naturalHeight}`);
    }

    return signatures;
  }

  function collectDownloadableImages() {
    const candidates = [...document.images]
      .filter((image) => isVisible(image))
      .filter((image) => image.complete && image.naturalWidth >= 256 && image.naturalHeight >= 256)
      .filter((image) => image.src && !image.src.startsWith('chrome-extension://'))
      .map((image) => {
        const src = image.currentSrc || image.src;
        const rect = image.getBoundingClientRect();

        return {
          src,
          signature: `${src}:${image.naturalWidth}x${image.naturalHeight}`,
          rectKey: imageRectKey(rect),
          area: rect.width * rect.height
        };
      })
      .sort((a, b) => b.area - a.area);

    return dedupeImages(candidates);
  }

  function dedupeImages(images) {
    const seenSrc = new Set();
    const seenRects = new Set();
    const uniqueImages = [];

    for (const image of images) {
      if (seenSrc.has(image.signature) || seenRects.has(image.rectKey)) {
        continue;
      }

      seenSrc.add(image.signature);
      seenRects.add(image.rectKey);
      uniqueImages.push({
        src: image.src,
        signature: image.signature
      });
    }

    return uniqueImages;
  }

  function imageRectKey(rect) {
    const roundTo = 12;
    const values = [rect.left, rect.top, rect.width, rect.height]
      .map((value) => Math.round(value / roundTo) * roundTo);
    return values.join(':');
  }

  async function downloadImageResilient(src, metadata) {
    const extension = extensionFromPath(src) || 'png';

    if (/^https?:/i.test(src)) {
      logEvent('info', 'download', 'Tentative de telechargement direct.', {
        key: metadata.key,
        source: describeImageSource(src)
      });

      try {
        const directResponse = await chrome.runtime.sendMessage({
          type: 'DOWNLOAD_IMAGE',
          ...metadata,
          url: src,
          extension,
          timeoutMs: 45000
        });

        if (directResponse?.ok) {
          return directResponse;
        }

        throw new Error(directResponse?.error || 'Chrome a refuse le telechargement direct.');
      } catch (error) {
        logEvent('warn', 'download', 'Passage au transfert image de secours.', {
          key: metadata.key,
          error: error.message
        });
      }
    }

    const imageData = await fetchImageAsDataUrl(src);
    return transferImageInChunks(imageData, {
      ...metadata,
      extension: extensionFromMime(imageData.mimeType) || extension,
      mimeType: imageData.mimeType
    });
  }

  async function fetchImageAsDataUrl(src) {
    if (src.startsWith('data:')) {
      const mimeType = src.match(/^data:([^;,]+)/)?.[1] || 'image/png';
      return { dataUrl: src, mimeType };
    }

    logEvent('info', 'transfer', 'Recuperation locale de l’image.', {
      source: describeImageSource(src)
    });

    let response;
    try {
      response = await fetch(src, {
        credentials: 'include',
        cache: 'no-store'
      });
    } catch (error) {
      throw new Error(`Recuperation de l'image impossible : ${error.message}`);
    }

    if (!response.ok) {
      throw new Error(`Recuperation de l'image impossible : HTTP ${response.status}.`);
    }

    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) {
      throw new Error(`Le fichier recu n'est pas une image (${blob.type || 'type inconnu'}).`);
    }

    return {
      dataUrl: await blobToDataUrl(blob),
      mimeType: blob.type
    };
  }

  function transferImageInChunks(imageData, metadata) {
    const separatorIndex = imageData.dataUrl.indexOf(',');
    const base64 = separatorIndex >= 0 ? imageData.dataUrl.slice(separatorIndex + 1) : '';
    if (!base64) {
      return Promise.reject(new Error('Donnees image vides avant le transfert.'));
    }

    const chunks = [];
    for (let offset = 0; offset < base64.length; offset += TRANSFER_CHUNK_SIZE) {
      chunks.push(base64.slice(offset, offset + TRANSFER_CHUNK_SIZE));
    }

    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: IMAGE_TRANSFER_PORT });
      let nextChunk = 0;
      let settled = false;
      const timeoutId = setTimeout(() => {
        finish(new Error('Delai depasse pendant le transfert de l’image.'));
      }, DOWNLOAD_TIMEOUT_MS);

      function finish(error, result) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        try {
          port.disconnect();
        } catch (_error) {
          // Le service worker a peut-etre deja ferme le canal.
        }
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }

      function sendNextChunk() {
        if (nextChunk >= chunks.length) {
          port.postMessage({ type: 'FINISH' });
          return;
        }

        port.postMessage({
          type: 'CHUNK',
          index: nextChunk,
          data: chunks[nextChunk]
        });
      }

      port.onMessage.addListener((message) => {
        if (message?.type === 'READY') {
          sendNextChunk();
          return;
        }

        if (message?.type === 'ACK' && message.index === nextChunk) {
          nextChunk += 1;
          sendNextChunk();
          return;
        }

        if (message?.type === 'DONE') {
          logEvent('info', 'transfer', 'Image transferee et telechargee.', {
            key: metadata.key,
            chunks: chunks.length
          });
          finish(null, message.result);
          return;
        }

        if (message?.type === 'ERROR') {
          finish(new Error(message.error || 'Erreur pendant le transfert de l’image.'));
        }
      });

      port.onDisconnect.addListener(() => {
        if (!settled) {
          finish(new Error(chrome.runtime.lastError?.message || 'Canal de transfert ferme avant la fin.'));
        }
      });

      logEvent('info', 'transfer', 'Envoi de l’image par blocs.', {
        key: metadata.key,
        chunks: chunks.length,
        characters: base64.length
      });

      port.postMessage({
        type: 'START',
        metadata: {
          ...metadata,
          totalChunks: chunks.length,
          totalCharacters: base64.length
        }
      });
    });
  }

  function extensionFromMime(mimeType) {
    const map = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif'
    };
    return map[mimeType] || 'png';
  }

  function extensionFromPath(src) {
    try {
      const pathname = new URL(src).pathname;
      const match = pathname.match(/\.([a-z0-9]{3,4})$/i);
      return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : null;
    } catch (_error) {
      return null;
    }
  }

  function describeImageSource(src) {
    const source = String(src || '');
    if (source.startsWith('data:')) {
      return 'data:image';
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

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function waitForElement(getElement, timeoutMs, errorMessage) {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const tick = () => {
        const element = getElement();
        if (element) {
          resolve(element);
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(errorMessage));
          return;
        }

        setTimeout(tick, 500);
      };

      tick();
    });
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function normalizeSettings(settings = {}) {
    const minDelaySeconds = normalizeDelay(settings.minDelaySeconds, DEFAULT_MIN_DELAY_SECONDS);
    const maxDelaySeconds = normalizeDelay(settings.maxDelaySeconds, DEFAULT_MAX_DELAY_SECONDS);

    return {
      downloadDir: normalizeDownloadDir(settings.downloadDir),
      minDelaySeconds: Math.min(minDelaySeconds, maxDelaySeconds),
      maxDelaySeconds: Math.max(minDelaySeconds, maxDelaySeconds),
      reliableMode: Boolean(settings.reliableMode),
      useGlobalPrefix: settings.useGlobalPrefix !== false,
      globalPrefix: normalizeGlobalPrefix(settings.globalPrefix)
    };
  }

  function normalizeGlobalPrefix(value) {
    return String(value || '')
      .replace(/\r\n/g, '\n')
      .trim();
  }

  function buildPrompt(scenePrompt, settings) {
    const prompt = String(scenePrompt || '').trim();
    const prefix = settings.useGlobalPrefix ? settings.globalPrefix : '';

    if (!prefix) {
      return prompt;
    }

    return `${prefix}\n\nSCENE TO ILLUSTRATE:\n${prompt}`;
  }

  function normalizeDelay(value, fallback) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3600) {
      return fallback;
    }

    return parsed;
  }

  function normalizeDownloadDir(value) {
    const parts = String(value || DEFAULT_DOWNLOAD_DIR)
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean)
      .filter((part) => part !== '.' && part !== '..');

    return parts.join('/') || DEFAULT_DOWNLOAD_DIR;
  }

  function randomDelay(settings) {
    const minDelayMs = settings.minDelaySeconds * 1000;
    const maxDelayMs = settings.maxDelaySeconds * 1000;
    return Math.floor(minDelayMs + Math.random() * (maxDelayMs - minDelayMs + 1));
  }

  async function waitBeforeNextPrompt(delayMs, run, completed, total) {
    const endsAt = Date.now() + delayMs;

    while (true) {
      ensureNotAborted(run);
      await keepChatGptActiveIfReliable(run);

      const remainingMs = Math.max(0, endsAt - Date.now());
      const remainingSeconds = Math.ceil(remainingMs / 1000);

      await publishStatus({
        state: 'waiting',
        message: `Pause : prochain prompt dans ${remainingSeconds} seconde${remainingSeconds > 1 ? 's' : ''}...`,
        completed,
        total
      });

      if (remainingMs <= 0) {
        return;
      }

      await sleep(Math.min(1000, remainingMs), run);
    }
  }

  function sleep(ms, run) {
    return new Promise((resolve, reject) => {
      let intervalId = null;
      const timeoutId = setTimeout(() => {
        if (intervalId) {
          clearInterval(intervalId);
        }
        resolve();
      }, ms);

      if (!run) {
        return;
      }

      intervalId = setInterval(() => {
        if (run.aborted) {
          clearTimeout(timeoutId);
          clearInterval(intervalId);
          reject(new DOMException('Automatisation arretee.', 'AbortError'));
        }
      }, 250);
    });
  }

  function ensureNotAborted(run) {
    if (run?.aborted) {
      throw new DOMException('Automatisation arretee.', 'AbortError');
    }
  }

  function publishStatus(status) {
    return chrome.runtime.sendMessage({
      type: 'AUTOMATION_STATUS',
      status
    }).catch(() => {});
  }

  function logEvent(level, scope, event, details = null) {
    chrome.runtime.sendMessage({
      type: 'LOG_EVENT',
      level,
      scope,
      event,
      details
    }).catch(() => {});
  }
})();

