/**
 * DeepSeek Quick Answer — контент-скрипт.
 *
 * 1) На обычных сайтах рисует маленький квадрат в правом нижнем углу
 *    и показывает рядом только номера правильных вариантов.
 * 2) На chat.deepseek.com работает «мостом»: вставляет промпт в чат,
 *    отправляет его и дожидается готового ответа ассистента.
 */
(() => {
  'use strict';

  const GUARD = '__dsqContentLoaded__';
  if (window[GUARD]) return;
  window[GUARD] = true;

  const CHAT_HOST = /(^|\.)chat\.deepseek\.com$/i;

  /* ================================================================ */
  /*  ОБЩИЕ УТИЛИТЫ (нужны и виджету, и мосту)                        */
  /* ================================================================ */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) resolve({ ok: false, error: error.message || 'Расширение недоступно.' });
          else resolve(response || { ok: false, error: 'Расширение не ответило.' });
        });
      } catch (err) {
        resolve({ ok: false, error: err?.message || String(err) });
      }
    });
  }

  function isDisabled(element) {
    if (!element) return true;
    if (element.disabled === true) return true;
    if (element.getAttribute('aria-disabled') === 'true') return true;
    if (element.classList?.contains('disabled')) return true;
    const style = getComputedStyle(element);
    return style.pointerEvents === 'none' || style.display === 'none' || style.visibility === 'hidden';
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  async function waitFor(condition, timeoutMs, intervalMs = 150) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = condition();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  if (CHAT_HOST.test(location.hostname)) {
    initChatBridge();
    return;
  }
  if (window.top !== window.self) return;

  /* ================================================================ */
  /*  МОСТ chat.deepseek.com                                          */
  /* ================================================================ */

  function initChatBridge() {
    let busy = false;

    const errorWithCode = (message, code) => {
      const error = new Error(message);
      error.code = code;
      return error;
    };

    const debug = (...args) => {
      try {
        console.info('[DSQ][web]', ...args);
      } catch {
        /* ignore */
      }
    };

    function isChallengePage() {
      // Если поле ввода уже есть, это точно не страница блокировки —
      // даже если в переписке обсуждаются ошибки 403.
      if (document.querySelector('#chat-input, textarea, [contenteditable="true"]')) return false;
      const text = `${document.title} ${(document.body?.innerText || '').slice(0, 800)}`;
      return /Request blocked|could not be satisfied|403 ERROR|Just a moment|Checking your browser|Verify you are human/i.test(
        text,
      );
    }

    function findEditor() {
      const candidates = [
        document.querySelector('#chat-input'),
        document.querySelector('[data-testid="chat-input"]'),
        document.querySelector('textarea#chat-input'),
        document.querySelector('textarea[placeholder]'),
        document.querySelector('div[contenteditable="true"][role="textbox"]'),
        document.querySelector('div[contenteditable="true"]'),
        document.querySelector('textarea'),
      ];
      return candidates.find((element) => element && isVisible(element)) || null;
    }

    function isEditorEmpty(editor) {
      if (!editor) return true;
      if (editor.tagName === 'TEXTAREA') return !editor.value.trim();
      return !(editor.innerText || '').trim();
    }

    function findSendButton(editor) {
      const rect = editor.getBoundingClientRect();
      const all = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const near = all.filter((element) => {
        if (element === editor || element.contains(editor) || editor.contains(element)) return false;
        if (!isVisible(element) || isDisabled(element)) return false;
        const box = element.getBoundingClientRect();
        const withinVertical = box.top >= rect.top - 24 && box.top <= rect.bottom + 160;
        const withinHorizontal = box.left >= rect.left - 60;
        return withinVertical && withinHorizontal;
      });

      const explicit = near.find((element) =>
        /send|отправ/i.test(
          `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${
            element.getAttribute('data-testid') || ''
          }`,
        ),
      );
      if (explicit) return explicit;

      // Если рядом ничего не нашли — ищем явную кнопку Send по всему документу.
      const globalExplicit = Array.from(
        document.querySelectorAll(
          'button[aria-label*="send" i], div[role="button"][aria-label*="send" i], button[type="submit"], button[data-testid="send-button"], [role="button"][data-testid="send-button"]',
        ),
      ).filter(
        (element) =>
          element !== editor &&
          !element.contains(editor) &&
          !editor.contains(element) &&
          isVisible(element) &&
          !isDisabled(element),
      );
      if (globalExplicit.length) return globalExplicit[globalExplicit.length - 1];

      const withSvg = near.filter((element) => element.querySelector('svg'));
      if (withSvg.length) {
        // Кнопка отправки — самая правая в панели ввода.
        return withSvg.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
      }
      return near[near.length - 1] || null;
    }

    function pressEnter(editor) {
      const makeEvent = (type) =>
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        });
      editor.dispatchEvent(makeEvent('keydown'));
      editor.dispatchEvent(makeEvent('keypress'));
      editor.dispatchEvent(makeEvent('keyup'));
    }

    async function insertPrompt(editor, prompt) {
      editor.focus();
      try {
        editor.click();
      } catch {
        /* ignore */
      }

      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(editor, prompt);
        else editor.value = prompt;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));

        if (!editor.value || !editor.value.includes(prompt.slice(0, 24))) {
          editor.select();
          document.execCommand('insertText', false, prompt);
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }

      if (editor.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, prompt);
        } catch {
          inserted = false;
        }
        if (!inserted || !(editor.innerText || '').includes(prompt.slice(0, 24))) {
          editor.textContent = prompt;
          editor.dispatchEvent(
            new InputEvent('input', { bubbles: true, data: prompt, inputType: 'insertText' }),
          );
        }
        return;
      }

      throw errorWithCode('Поле ввода DeepSeek имеет неизвестный формат.', 'WEB_EDITOR');
    }

    async function submitPrompt(editor) {
      const button = findSendButton(editor);
      if (button) {
        debug('send-button', {
          tag: button.tagName,
          testid: button.getAttribute('data-testid') || '',
          label: `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`.trim(),
        });
        await waitFor(() => !isDisabled(button), 5_000);
        button.click();
      } else {
        debug('send-enter');
        pressEnter(editor);
      }

      let cleared = await waitFor(() => isEditorEmpty(editor), 5_000);
      if (!cleared) {
        pressEnter(editor);
        cleared = await waitFor(() => isEditorEmpty(editor), 3_000);
      }
      if (!cleared) {
        throw errorWithCode(
          'Вопрос вставился, но не отправился. Откройте chat.deepseek.com и отправьте его вручную, затем повторите.',
          'WEB_SUBMIT',
        );
      }
      debug('sent');
    }

    function collectAssistantBlocks() {
      const nodes = new Set();
      for (const selector of [
        'div.ds-markdown.ds-markdown--block',
        'div.ds-markdown',
        '[class*="ds-markdown"]',
        '[class*="markdown"]',
      ]) {
        document.querySelectorAll(selector).forEach((node) => nodes.add(node));
      }
      // Запасной вариант, если классы markdown уже другие.
      if (nodes.size === 0) {
        document.querySelectorAll('[data-message-author-role="assistant"]').forEach((node) => nodes.add(node));
      }
      const all = Array.from(nodes);
      return all
        .filter((node) => !all.some((other) => other !== node && other.contains(node)))
        .filter((node) => node.querySelector('p, li, pre, code, h1, h2, h3, table') || (node.innerText || '').trim())
        .filter((node) => isAnswerBlockVisible(node))
        .filter((node) => !isReasoningBlock(node))
        .map((node) => ({ node, text: (node.innerText || '').trim() }))
        .filter((item) => item.text.length > 0);
    }

    function isReasoningBlock(node) {
      // Исключаем только реальные контейнеры рассуждений, а не любой
      // родитель с «reason»/«think» в имени класса.
      return Boolean(
        node.closest(
          '.ds-think-content, [class*="think-content"], [class*="think_block"], [class*="reasoning-content"]',
        ),
      );
    }

    function isAnswerBlockVisible(node) {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    /** Кнопка «Stop» / «Остановить» видна, пока DeepSeek печатает. */
    function isGenerating() {
      const candidates = document.querySelectorAll('button, [role="button"], [aria-label*="stop" i]');
      for (const element of candidates) {
        if (!isVisible(element)) continue;
        const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${
          element.getAttribute('data-testid') || ''
        }`;
        if (/stop|останов/i.test(label)) return true;
        const className = typeof element.className === 'string' ? element.className : '';
        if (/(?:^|\s)(?:ds-)?stop(?:-|_|\s|$)/i.test(className)) return true;
      }
      return false;
    }

    function isEcho(text, prompt) {
      const normalizedText = text.replace(/\s+/g, ' ').trim();
      const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
      if (!normalizedText) return false;
      const promptPrefix = normalizedPrompt.slice(0, 60);
      return (
        normalizedText.startsWith(promptPrefix) ||
        normalizedText.includes(promptPrefix) ||
        normalizedPrompt.startsWith(normalizedText.slice(0, 40))
      );
    }

    /** Последний «ОТВЕТ: …» на странице после последнего сообщения пользователя. */
    function findAnswerInPage(prompt, baseline) {
      const userNodes = Array.from(
        document.querySelectorAll(
          '[data-message-author-role="user"], [class*="UserMessage"], .user-message',
        ),
      );
      const lastUser = userNodes[userNodes.length - 1] || null;

      const selectors = [
        '[data-message-author-role="assistant"]',
        'div.ds-markdown.ds-markdown--block',
        'div.ds-markdown',
        '[class*="ds-markdown"]',
        '[class*="markdown"]',
      ];
      const seen = new Set();

      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector)).slice(-40);
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          const node = nodes[index];
          if (seen.has(node)) continue;
          seen.add(node);

          if (
            lastUser &&
            !(lastUser.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
          ) {
            continue;
          }

          const text = (node.innerText || '').trim();
          if (!text || text.length > 12_000) continue;
          if (isEcho(text, prompt)) continue;
          if (baseline?.texts?.has(text)) continue;

          const matches = [
            ...text.matchAll(
              /(?:ОТВЕТ|ANSWER)\s*[:：\-–—]\s*(?:вариант\s+)?([A-Za-zА-Яа-я]|\d{1,2}(?:\s*[,;·]\s*\d{1,2})*)/gi,
            ),
          ];
          if (!matches.length) continue;
          const value = matches[matches.length - 1][1].trim();
          if (value) return `ОТВЕТ: ${value}`;
        }
      }
      return '';
    }

    async function waitForAnswer(baseline, prompt, timeoutMs) {
      const started = Date.now();
      let lastText = '';
      let stableSince = 0;
      let sawFresh = false;
      let patternText = '';
      let patternSince = 0;
      let lastDebugAt = 0;
      debug('waiting-answer', { baseline: baseline.count });

      while (Date.now() - started < timeoutMs) {
        const blocks = collectAssistantBlocks();
        const pageAnswer = findAnswerInPage(prompt, baseline);
        if (pageAnswer) {
          if (pageAnswer !== patternText) {
            patternText = pageAnswer;
            patternSince = Date.now();
          } else if (Date.now() - patternSince >= 1_500) {
            debug('answer-pattern', { chars: pageAnswer.length });
            return pageAnswer;
          }
        }
        // Новый блок — либо появился после уже существовавших, либо его текста
        // не было в истории (переживает перерисовку и виртуализацию списка).
        const fresh = blocks.filter(
          (item, index) =>
            (index >= baseline.count || !baseline.texts.has(item.text)) && !isEcho(item.text, prompt),
        );
        if (fresh.length) {
          if (!sawFresh) debug('answer-started');
          sawFresh = true;
          const latest = fresh[fresh.length - 1];
          if (latest.text !== lastText) {
            lastText = latest.text;
            stableSince = Date.now();
          } else if (!stableSince) {
            stableSince = Date.now();
          }
        }

        const stableFor = Date.now() - stableSince;
        if (sawFresh && lastText && ((!isGenerating() && stableFor >= 2_500) || stableFor >= 8_000)) {
          debug('answer-ready', { chars: lastText.length });
          return lastText;
        }

        if (!sawFresh && Date.now() - started > 5_000 && Date.now() - lastDebugAt > 5_000) {
          lastDebugAt = Date.now();
          debug('dom-snapshot', {
            markdown: document.querySelectorAll('.ds-markdown').length,
            markdownLike: document.querySelectorAll('[class*="markdown"]').length,
            assistant: document.querySelectorAll('[data-message-author-role="assistant"]').length,
            collected: blocks.length,
            pattern: Boolean(pageAnswer),
          });
        }
        await sleep(400);
      }

      if (sawFresh && lastText) {
        debug('answer-timeout-partial', { chars: lastText.length });
        return lastText;
      }
      debug('timeout', { blocks: collectAssistantBlocks().length });
      throw errorWithCode(
        'DeepSeek не прислал ответ за 180 секунд. Проверьте, что вопрос появился в чате, вы вошли в аккаунт и сайт не показывает проверку.',
        'WEB_TIMEOUT',
      );
    }

    async function handleWebAsk(prompt) {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw errorWithCode('Пустой запрос для чата.', 'WEB_EMPTY');
      }
      if (busy) {
        throw errorWithCode('Предыдущий запрос в чате ещё выполняется. Подождите немного.', 'WEB_BUSY');
      }
      debug('start', location.pathname);
      if (isChallengePage()) {
        throw errorWithCode(
          'chat.deepseek.com показывает проверку CloudFront. Откройте вкладку, пройдите проверку и повторите.',
          'WEB_BLOCKED',
        );
      }
      if (/\/sign_in|\/login/i.test(location.pathname)) {
        throw errorWithCode(
          'Вы не вошли в chat.deepseek.com. Откройте сайт, войдите в аккаунт и повторите.',
          'WEB_LOGIN',
        );
      }

      busy = true;
      try {
        const editor = await waitFor(findEditor, 25_000, 300);
        if (!editor) {
          throw errorWithCode(
            'Не нашёл поле ввода на chat.deepseek.com. Убедитесь, что вы вошли в аккаунт, страница не на экране входа, и обновите вкладку.',
            'WEB_EDITOR',
          );
        }
        debug('editor', { tag: editor.tagName, id: editor.id || '' });

        const baselineBlocks = collectAssistantBlocks();
        const baseline = {
          count: baselineBlocks.length,
          texts: new Set(baselineBlocks.map((item) => item.text)),
        };
        await insertPrompt(editor, prompt);
        debug('inserted', { tag: editor.tagName, chars: (editor.value || editor.innerText || '').length });
        await sleep(300);
        await submitPrompt(editor);
        return await waitForAnswer(baseline, prompt, 180_000);
      } finally {
        busy = false;
      }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false;

      if (message.type === 'dsq-bridge-ping') {
        sendResponse({ ok: true, url: location.href });
        return false;
      }

      if (message.type !== 'dsq-web-ask') return false;

      handleWebAsk(message.prompt)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((error) => {
          debug('error', { code: error?.code || 'WEB_ERROR', message: error?.message || String(error) });
          sendResponse({
            ok: false,
            error: error?.message || String(error),
            code: error?.code || 'WEB_ERROR',
          });
        });
      return true;
    });
  }


  /* ================================================================ */
  /*  КОМПАКТНЫЙ ВИДЖЕТ                                               */
  /* ================================================================ */

  if (document.getElementById('dsq-root-host')) {
    // Остаток от предыдущей инъекции (например, после перезагрузки расширения).
    document.getElementById('dsq-root-host').remove();
  }

  const CSS = `
    :host {
      all: initial;
      -webkit-text-size-adjust: 100%;
    }
    *, *::before, *::after { box-sizing: border-box; }

    .dsq-wrap {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
    }

    .dsq-fab {
      position: fixed;
      right: 8px;
      bottom: 8px;
      width: 18px;
      height: 18px;
      margin: 0;
      padding: 0;
      border: 1px solid rgba(128, 128, 128, 0.5);
      border-radius: 4px;
      background: rgba(128, 128, 128, 0.08);
      opacity: 0.28;
      cursor: pointer;
      pointer-events: auto;
      outline: none;
      -webkit-tap-highlight-color: transparent;
      transition: opacity 160ms ease, background-color 160ms ease, border-color 160ms ease;
    }
    .dsq-fab:hover,
    .dsq-fab:focus-visible {
      opacity: 1;
      background: rgba(109, 135, 255, 0.18);
      border-color: rgba(109, 135, 255, 0.62);
    }
    .dsq-fab:focus-visible {
      box-shadow: 0 0 0 2px rgba(109, 135, 255, 0.45);
    }
    .dsq-fab:active { transform: scale(0.92); }
    .dsq-fab::before {
      /* Невидимая зона нажатия чуть больше самого квадрата. */
      content: "";
      position: absolute;
      inset: -5px;
      border-radius: 8px;
    }
    .dsq-fab[data-busy="true"] { animation: dsq-breathe 1.2s ease-in-out infinite; }

    @keyframes dsq-breathe {
      0%, 100% { opacity: 0.22; }
      50% { opacity: 0.52; }
    }

    .dsq-numbers {
      position: fixed;
      right: 32px;
      bottom: 8px;
      height: 18px;
      min-width: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 2px;
      background: transparent;
      color: rgba(255, 255, 255, 0.97);
      font: 700 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
      letter-spacing: 0.02em;
      white-space: nowrap;
      text-shadow: 0 0 2px rgba(0, 0, 0, 0.9), 0 0 4px rgba(0, 0, 0, 0.65), 0 1px 2px rgba(0, 0, 0, 0.8);
      opacity: 0;
      transform: translateX(2px);
      transition: opacity 180ms ease, transform 180ms ease;
      pointer-events: none;
    }
    .dsq-numbers[data-show="true"] {
      opacity: 0.75;
      transform: translateX(0);
    }
    .dsq-numbers[data-kind="error"] {
      color: #ff9f9f;
      text-shadow: 0 0 2px rgba(0, 0, 0, 0.9), 0 0 5px rgba(40, 0, 0, 0.8);
    }
    .dsq-numbers[data-show="true"][data-kind="error"] { opacity: 0.85; }
    .dsq-numbers[data-kind="warn"] {
      color: #ffe1a0;
      text-shadow: 0 0 2px rgba(0, 0, 0, 0.9), 0 0 5px rgba(35, 25, 0, 0.8);
    }
    .dsq-numbers[data-show="true"][data-kind="warn"] { opacity: 0.8; }

    @media (prefers-reduced-motion: reduce) {
      .dsq-fab, .dsq-numbers { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
    }
  `;

  const host = document.createElement('div');
  host.id = 'dsq-root-host';
  host.setAttribute('data-dsq', 'root');
  host.style.cssText =
    'all: initial; position: fixed; right: 0; bottom: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
  (document.documentElement || document.body).appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  try {
    // Constructed stylesheet не блокируется CSP сайта, в отличие от <style>.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
  }

  const wrap = document.createElement('div');
  wrap.className = 'dsq-wrap';
  wrap.innerHTML = `
    <span class="dsq-numbers" role="status" aria-live="polite" data-show="false" data-kind="answer"></span>
    <button type="button" class="dsq-fab" data-busy="false" aria-busy="false" aria-label="DeepSeek: показать номер ответа"></button>
  `;
  shadow.appendChild(wrap);

  const fab = wrap.querySelector('.dsq-fab');
  const numbers = wrap.querySelector('.dsq-numbers');
  const state = { busy: false, hideTimer: null };

  function clearTitle() {
    fab.removeAttribute('title');
  }

  function showNumbers(values, { kind = 'answer', holdMs = 15_000, title = '' } = {}) {
    if (state.hideTimer) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    const list = Array.isArray(values) ? values : [];
    numbers.textContent = list.length ? list.join(', ') : kind === 'error' ? '!' : '?';
    numbers.dataset.kind = kind;
    numbers.dataset.show = 'true';
    if (title) fab.title = title;
    else clearTitle();

    state.hideTimer = setTimeout(() => {
      numbers.dataset.show = 'false';
      state.hideTimer = null;
      clearTitle();
    }, holdMs);
  }

  function setBusy(value, title = '') {
    state.busy = value;
    fab.dataset.busy = String(value);
    fab.setAttribute('aria-busy', String(value));
    if (!value) return;

    if (state.hideTimer) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    numbers.textContent = '…';
    numbers.dataset.kind = 'progress';
    numbers.dataset.show = 'true';
    if (title) fab.title = title;
    else clearTitle();
  }

  async function grabClipboard() {
    let direct = null;
    try {
      if (navigator.clipboard?.readText) {
        direct = await Promise.race([
          navigator.clipboard.readText(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard-timeout')), 1_500)),
        ]);
        if (typeof direct === 'string' && direct.trim()) return direct;
      }
    } catch {
      direct = null;
    }

    // Прямое чтение недоступно или вернуло пустоту — пробуем offscreen-документ.
    try {
      const result = await send({ type: 'dsq-read-clipboard' });
      if (result?.ok && typeof result.text === 'string' && result.text.trim()) return result.text;
      if (direct) return direct;
      if (result?.ok) return '';
      throw new Error(result?.error || 'Браузер не разрешил чтение буфера обмена.');
    } catch (err) {
      if (direct) return direct;
      throw err;
    }
  }

  async function runAsk() {
    if (state.busy) return;

    setBusy(true, 'DeepSeek…');
    try {
      let text = '';
      try {
        text = String(await grabClipboard()).trim();
      } catch (err) {
        console.warn('[DSQ] clipboard:', err?.message || err);
        showNumbers([], {
          kind: 'error',
          holdMs: 12_000,
          title: err?.message || 'Не удалось прочитать буфер обмена.',
        });
        return;
      }

      if (!text) {
        showNumbers([], {
          kind: 'warn',
          holdMs: 8_000,
          title: 'Буфер обмена пуст — скопируйте вопрос с вариантами.',
        });
        return;
      }

      const result = await send({ type: 'dsq-ask', text });
      if (!result?.ok) {
        console.warn('[DSQ] ask:', result?.error || 'no response');
        showNumbers([], {
          kind: 'error',
          holdMs: 15_000,
          title: result?.error || 'DeepSeek не ответил. Попробуйте ещё раз.',
        });
        return;
      }

      const values = Array.isArray(result.numbers) ? result.numbers : [];
      if (values.length) {
        showNumbers(values, { kind: 'answer', holdMs: 15_000 });
      } else {
        console.warn('[DSQ] no numbers in answer');
        showNumbers([], {
          kind: 'warn',
          holdMs: 12_000,
          title: result.raw ? `Ответ без номера: ${String(result.raw).slice(0, 300)}` : 'Не удалось определить номер ответа.',
        });
      }
    } catch (err) {
      console.warn('[DSQ] ask failed:', err?.message || err);
      showNumbers([], {
        kind: 'error',
        holdMs: 15_000,
        title: err?.message || 'Ошибка DeepSeek.',
      });
    } finally {
      setBusy(false);
    }
  }

  fab.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    runAsk();
  });

  // Правый клик — настройки, чтобы не плодить видимые кнопки.
  fab.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    send({ type: 'dsq-open-options' });
  });

  // Не даём сайту перехватывать клики по нашему UI.
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'dsq-trigger') runAsk();
    return false;
  });
})();
