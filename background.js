import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  clampQuestion,
  buildUserPrompt,
  buildWebPrompt,
  extractApiContent,
  extractAnswerNumbers,
  describeApiError,
} from './lib/core.js';

const SETTINGS_KEY = 'dsq_settings';
const API_TIMEOUT_MS = 120_000;
const WEB_TIMEOUT_MS = 190_000;
const WEB_TAB_URL = 'https://chat.deepseek.com/';

/* ------------------------------------------------------------------ */
/* Установка                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local
    .get(SETTINGS_KEY)
    .then((data) => {
      if (!data[SETTINGS_KEY]) return chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
      return undefined;
    })
    .then(() => {
      if (details.reason === 'install') {
        return chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
      }
      return undefined;
    })
    .catch((err) => console.warn('[DSQ] install init failed', err));
});

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(data[SETTINGS_KEY]);
}

function resolveBackends(settings) {
  if (settings.mode === 'api') return ['api'];
  if (settings.mode === 'web') return ['web'];
  return settings.apiKey ? ['api', 'web'] : ['web'];
}

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fetchWithTimeout(url, options, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  // Продлеваем жизнь service worker'а, пока ждём медленный ответ DeepSeek.
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20_000);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/* ------------------------------------------------------------------ */
/* Буфер обмена через offscreen-документ                               */
/* ------------------------------------------------------------------ */

let offscreenCreating = null;

async function ensureOffscreen() {
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    try {
      if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [chrome.runtime.getURL('offscreen.html')],
        });
        if (contexts.length > 0) return;
      }
      await chrome.offscreen
        .createDocument({
          url: 'offscreen.html',
          reasons: ['CLIPBOARD'],
          justification: 'Чтение вопроса из буфера обмена по нажатию кнопки расширения',
        })
        .catch((err) => {
          if (!/single offscreen/i.test(String(err?.message || err))) throw err;
        });
    } finally {
      offscreenCreating = null;
    }
  })();
  return offscreenCreating;
}

async function readClipboard() {
  await ensureOffscreen();
  let response;
  try {
    response = await withTimeout(
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'read-clipboard' }),
      8_000,
      'Браузер слишком долго отдаёт буфер обмена.',
    );
  } catch (err) {
    throw new Error('Не удалось прочитать буфер обмена. Вставьте вопрос вручную (Ctrl+V).');
  }
  if (!response || !response.ok) {
    throw new Error(response?.error || 'Браузер не разрешил чтение буфера обмена. Вставьте вопрос вручную.');
  }
  return response.text || '';
}

/* ------------------------------------------------------------------ */
/* DeepSeek API                                                        */
/* ------------------------------------------------------------------ */

async function askViaApi(settings, text) {
  if (!settings.apiKey) {
    const error = new Error('API-ключ не задан. Откройте настройки расширения (⚙) и вставьте ключ DeepSeek.');
    error.code = 'NO_KEY';
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response;
  let bodyText = '';
  try {
    response = await fetch(`${settings.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: settings.systemPrompt },
          { role: 'user', content: buildUserPrompt(text) },
        ],
        ...(settings.model.includes('reasoner') ? {} : { temperature: settings.temperature }),
        max_tokens: 1000,
        stream: false,
      }),
      signal: controller.signal,
    });
    // Читаем тело здесь же: таймаут должен покрывать и ответ, а не только заголовки.
    bodyText = await response.text();
  } catch (err) {
    const aborted = controller.signal.aborted;
    const error = new Error(
      aborted
        ? 'DeepSeek API не ответил за 120 секунд. Попробуйте ещё раз.'
        : 'Нет соединения с DeepSeek API. Проверьте интернет/VPN или Base URL в настройках.',
    );
    error.code = aborted ? 'TIMEOUT' : 'NETWORK';
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const error = new Error(describeApiError(response.status, bodyText));
    error.code = response.status === 429 ? 'RATE_LIMIT' : 'API_ERROR';
    throw error;
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    const error = new Error('DeepSeek API вернул некорректный JSON. Попробуйте повторить запрос.');
    error.code = 'API_ERROR';
    throw error;
  }

  const content = extractApiContent(json);
  if (!content) {
    const error = new Error('DeepSeek API вернул пустой ответ. Попробуйте повторить запрос.');
    error.code = 'API_ERROR';
    throw error;
  }
  return { content, usage: json.usage || null };
}

/* ------------------------------------------------------------------ */
/* Режим «вкладка chat.deepseek.com»                                   */
/* ------------------------------------------------------------------ */

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer = null;

    const finish = (error, tab) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve(tab);
    };

    const listener = (id, info, tab) => {
      if (id === tabId && info.status === 'complete') finish(null, tab);
    };

    chrome.tabs.onUpdated.addListener(listener);

    timer = setTimeout(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.status === 'complete') finish(null, tab);
        else finish(new Error('Вкладка chat.deepseek.com не загрузилась за 40 секунд.'));
      } catch (err) {
        finish(err);
      }
    }, timeoutMs);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === 'complete') finish(null, tab);
      })
      .catch((err) => finish(err));
  });
}

function isUsableChatUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)chat\.deepseek\.com$/i.test(parsed.hostname)) return false;
    return !/^\/(?:sign_in|login|share)(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function restoreFocus(originTabId) {
  if (!originTabId) return;
  try {
    const tab = await chrome.tabs.get(originTabId);
    await chrome.tabs.update(originTabId, { active: true });
    if (tab?.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    /* вкладку могли закрыть */
  }
}

let pendingChatFocus = null;

function scheduleChatFocusRestore(chatTabId, originTabId) {
  if (!originTabId) return;
  clearChatFocusPending(chatTabId, false);
  const timer = setTimeout(() => {
    restoreChatFocus(chatTabId);
  }, 5_000);
  pendingChatFocus = { chatTabId, originTabId, timer };
}

async function restoreChatFocus(chatTabId) {
  if (!pendingChatFocus || pendingChatFocus.chatTabId !== chatTabId) return;
  const pending = pendingChatFocus;
  pendingChatFocus = null;
  clearTimeout(pending.timer);

  // Если пользователь уже сам переключился, не выдёргиваем его обратно.
  try {
    const tab = await chrome.tabs.get(chatTabId);
    if (!tab.active) return;
  } catch {
    return;
  }
  await restoreFocus(pending.originTabId);
}

function clearChatFocusPending(chatTabId, restore) {
  if (!pendingChatFocus || pendingChatFocus.chatTabId !== chatTabId) return;
  if (restore) {
    restoreChatFocus(chatTabId);
    return;
  }
  clearTimeout(pendingChatFocus.timer);
  pendingChatFocus = null;
}

async function findOrOpenChatTab(originTabId) {
  const tabs = (await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' }))
    .filter((item) => isUsableChatUrl(item.url))
    .sort(
      (a, b) =>
        Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
        (b.lastAccessed || 0) - (a.lastAccessed || 0),
    );
  let tab = tabs[0] || null;

  if (tab) {
    if (tab.status !== 'complete') tab = await waitForTabComplete(tab.id, 40_000);

    if (tab.discarded) {
      // «Спящую» вкладку нужно активировать, иначе её DOM не отрисован.
      await chrome.tabs.update(tab.id, { active: true });
      tab = await waitForTabComplete(tab.id, 40_000);
      return { tab, restore: true };
    }
    return { tab, restore: false };
  }

  // Новую вкладку открываем активной: CloudFront/React успевают
  // отрисовать страницу и поле ввода. Куда вернуть фокус — решает caller.
  const created = await chrome.tabs.create({ url: WEB_TAB_URL, active: true });
  try {
    const ready = await waitForTabComplete(created.id, 40_000);
    await sleep(600); // редактор ещё подождёт bridge; вкладка мелькает короче
    return { tab: ready, restore: true };
  } catch (error) {
    await restoreFocus(originTabId);
    throw error;
  }
}

async function sendToChatTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Вкладка могла быть открыта до установки расширения — внедряем скрипт вручную.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await sleep(700);
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      const error = new Error(
        'Не удалось подключиться к вкладке chat.deepseek.com. Откройте её, обновите страницу и попробуйте снова.',
      );
      error.code = 'WEB_CONNECT';
      throw error;
    }
  }
}

async function askViaWeb(settings, text, originTabId) {
  const { tab, restore } = await findOrOpenChatTab(originTabId);
  if (restore) scheduleChatFocusRestore(tab.id, originTabId);

  try {
    const prompt = buildWebPrompt(text, settings.systemPrompt);
    let response;
    try {
      response = await withTimeout(
        sendToChatTab(tab.id, { type: 'dsq-web-ask', prompt, originTabId }),
        WEB_TIMEOUT_MS,
        'Веб-вкладка не ответила за 190 секунд. Проверьте, что вы вошли в chat.deepseek.com.',
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!error.code) error.code = 'WEB_TIMEOUT';
      throw error;
    }

    if (!response) {
      const error = new Error('Вкладка chat.deepseek.com не вернула ответ. Обновите её и попробуйте снова.');
      error.code = 'WEB_ERROR';
      throw error;
    }
    if (!response.ok) {
      const error = new Error(response.error || 'Не удалось получить ответ в chat.deepseek.com.');
      error.code = response.code || 'WEB_ERROR';
      throw error;
    }

    const content = String(response.text || '').trim();
    if (!content) {
      const error = new Error('DeepSeek вернул пустой ответ в чате. Попробуйте повторить.');
      error.code = 'WEB_ERROR';
      throw error;
    }
    return { content };
  } finally {
    if (restore) await restoreChatFocus(tab.id);
  }
}

/* ------------------------------------------------------------------ */
/* Основной сценарий                                                   */
/* ------------------------------------------------------------------ */

async function handleAsk(rawText, originTabId) {
  const settings = await getSettings();
  const { text } = clampQuestion(rawText, settings.maxChars);
  if (!text) {
    return {
      ok: false,
      code: 'EMPTY',
      error: 'В буфере обмена нет текста. Скопируйте вопрос с вариантами ответов и нажмите кнопку снова.',
    };
  }

  const backends = resolveBackends(settings);
  const attempts = [];

  startKeepAlive();
  try {
    for (const backend of backends) {
      try {
        const result =
          backend === 'api' ? await askViaApi(settings, text) : await askViaWeb(settings, text, originTabId);
        const numbers = extractAnswerNumbers(result.content, text);
        return {
          ok: true,
          backend,
          numbers,
          raw: result.content.slice(0, 500),
        };
      } catch (err) {
        attempts.push({
          backend,
          code: err?.code || 'ERROR',
          message: err?.message || String(err),
        });
      }
    }
  } finally {
    stopKeepAlive();
  }

  const error =
    attempts.length > 1
      ? attempts.map((item) => `• ${item.backend === 'api' ? 'API' : 'Вкладка'}: ${item.message}`).join('\n')
      : attempts[0]?.message || 'Не удалось получить ответ от DeepSeek.';
  return { ok: false, code: 'ALL_FAILED', error, attempts };
}

/* ------------------------------------------------------------------ */
/* Проверка API-ключа                                                  */
/* ------------------------------------------------------------------ */

async function testApiKey({ apiKey, apiBase, model } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const base = (typeof apiBase === 'string' && apiBase.trim() ? apiBase.trim() : DEFAULT_SETTINGS.apiBase).replace(
    /\/+$/,
    '',
  );
  if (!key) return { ok: false, error: 'Вставьте API-ключ.' };

  try {
    const response = await fetchWithTimeout(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const bodyText = await response.text();

    if (response.status === 401) return { ok: false, error: 'Ключ неверный (401). Скопируйте его заново из platform.deepseek.com.' };
    if (response.ok) {
      let balance = '';
      let available = null;
      try {
        const json = JSON.parse(bodyText);
        const info = json?.balance_infos?.[0];
        if (info) balance = `${info.total_balance} ${info.currency}`;
        available = typeof json?.is_available === 'boolean' ? json.is_available : null;
      } catch {
        /* баланс не критичен */
      }
      let modelWarning = '';
      try {
        const modelsResponse = await fetchWithTimeout(`${base}/models`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (modelsResponse.ok) {
          const modelsJson = await modelsResponse.json();
          const ids = (modelsJson?.data || []).map((item) => item.id);
          if (ids.length && model && !ids.includes(model)) {
            modelWarning = `Модель «${model}» не найдена в списке доступных: ${ids.join(', ')}.`;
          }
        }
      } catch {
        /* список моделей не обязателен */
      }
      return { ok: true, balance, available, modelWarning };
    }

    // /user/balance может быть недоступен для некоторых ключей — проверяем /models.
    const modelsResponse = await fetchWithTimeout(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (modelsResponse.ok) return { ok: true, balance: '' };
    return { ok: false, error: describeApiError(response.status, bodyText) };
  } catch {
    return { ok: false, error: 'Нет соединения с DeepSeek API. Проверьте Base URL и интернет.' };
  }
}

/* ------------------------------------------------------------------ */
/* Маршрутизация сообщений                                             */
/* ------------------------------------------------------------------ */

function reply(sendResponse, promise) {
  Promise.resolve(promise)
    .then((value) => sendResponse(value))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || message.target === 'offscreen') return false;
  const originTabId = sender?.tab?.id;

  switch (message.type) {
    case 'dsq-ping':
      sendResponse({ ok: true });
      return false;

    case 'dsq-read-clipboard':
      return reply(sendResponse, readClipboard().then((text) => ({ ok: true, text })));

    case 'dsq-web-sent': {
      const chatTabId = sender?.tab?.id;
      if (chatTabId) restoreChatFocus(chatTabId);
      sendResponse({ ok: true });
      return false;
    }

    case 'dsq-ask': {
      if (typeof message.text !== 'string') {
        sendResponse({ ok: false, error: 'Не передан текст вопроса.' });
        return false;
      }
      return reply(sendResponse, handleAsk(message.text, originTabId));
    }

    case 'dsq-test-key':
      return reply(sendResponse, testApiKey(message.settings || message));

    case 'dsq-open-options':
      chrome.runtime.openOptionsPage().catch(() => {});
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

/* ------------------------------------------------------------------ */
/* Тулбар и горячая клавиша                                            */
/* ------------------------------------------------------------------ */

function triggerInTab(tab) {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'dsq-trigger' }).catch(() => {
    // На chrome:// и страницах магазина расширений контент-скрипт недоступен.
  });
}

chrome.action.onClicked.addListener((tab) => triggerInTab(tab));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'ask-clipboard') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    triggerInTab(tab);
  } catch (err) {
    console.warn('[DSQ] command failed', err);
  }
});
