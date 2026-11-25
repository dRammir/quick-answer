/**
 * E2E-проверка расширения в настоящем Chrome (new headless).
 *
 * Проверяется:
 *  - расширение загружается, страница настроек сохраняет ключ;
 *  - на сайте появляется маленький неприметный квадрат;
 *  - клик читает буфер, шлёт запрос и показывает только номер ответа;
 *  - несколько ответов показываются как «2, 4»;
 *  - буквенный ответ (B) превращается в номер 2;
 *  - ошибка API показывается компактным «!» с подсказкой в title;
 *  - номера автоматически исчезают;
 *  - offscreen-документ читает буфер;
 *  - режим вкладки chat.deepseek.com работает через мок-страницу чата.
 *
 * Запуск: npm run test:e2e
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROMPT } from '../lib/core.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW = join(ROOT, 'preview');
const QUESTION = `Какой органоид клетки синтезирует основную часть АТФ в процессе клеточного дыхания?

A) Рибосома
B) Митохондрия
C) Аппарат Гольджи
D) Лизосома`;

const ANSWER_SINGLE = 'ОТВЕТ: 2\nПОЯСНЕНИЕ: Митохондрии — «энергетические станции» клетки.';
const ANSWER_MULTI = 'ОТВЕТ: 2, 4';
const ANSWER_LETTERS = 'ОТВЕТ: B) Митохондрия';

const MOCK_CHAT_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>DeepSeek Chat (mock)</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #f5f6fa; color: #1c2230; }
  header { padding: 14px 22px; border-bottom: 1px solid #e2e6ef; background: #fff; font-weight: 700; }
  #messages { max-width: 720px; margin: 22px auto; padding: 0 16px; }
  .ds-markdown { background: #fff; border: 1px solid #e2e6ef; border-radius: 12px; padding: 14px 16px; margin: 10px 0; white-space: pre-wrap; min-height: 42px; line-height: 1.55; }
  .composer { max-width: 720px; margin: 22px auto; padding: 0 16px 28px; }
  textarea { width: 100%; height: 92px; resize: none; border: 1px solid #cfd6e4; border-radius: 12px; padding: 12px; font: inherit; }
  .row { display: flex; justify-content: flex-end; margin-top: 8px; }
  button { display: flex; align-items: center; gap: 6px; border: 0; border-radius: 9px; padding: 9px 14px; background: #4d6bfe; color: #fff; cursor: pointer; font: inherit; }
  svg { width: 16px; height: 16px; }
</style>
</head>
<body>
<header>DeepSeek</header>
<div id="messages"></div>
<div class="composer">
  <textarea id="chat-input" placeholder="Send a message"></textarea>
  <div class="row">
    <button id="send" aria-label="Send message"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg><span>Send</span></button>
  </div>
</div>
<script>
  const input = document.getElementById('chat-input');
  const send = document.getElementById('send');
  const messages = document.getElementById('messages');
  send.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) return;
    // Специально не очищаем input: проверяем, что расширение не считает
    // отправку неудачной, если DeepSeek оставил текст в поле ввода.
    const box = document.createElement('div');
    box.className = 'ds-markdown';
    messages.appendChild(box);
    const full = ${JSON.stringify(ANSWER_LETTERS)};
    let index = 0;
    const timer = setInterval(() => {
      index += 8;
      box.textContent = full.slice(0, index);
      if (index >= full.length) clearInterval(timer);
    }, 45);
  });
</script>
</body>
</html>`;

let failures = 0;
const results = [];

function check(name, condition, details = '') {
  if (condition) {
    console.log(`✓ ${name}${details ? ` — ${details}` : ''}`);
  } else {
    failures += 1;
    console.log(`✗ ${name}${details ? ` — ${details}` : ''}`);
  }
  results.push({ name, ok: Boolean(condition), details });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const caches = [
    join(ROOT, '.cache', 'puppeteer', 'chrome'),
    join(process.env.HOME || '', '.cache', 'puppeteer', 'chrome'),
  ];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache)) {
      for (const folder of ['chrome-linux64', 'chrome-linux']) {
        const candidate = join(cache, entry, folder, 'chrome');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function startFixtureServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/' || url.pathname === '/fixture.html') {
      const html = await readFile(join(ROOT, 'test', 'fixture.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function waitForAny(browser, predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const target = browser.targets().find(predicate);
    if (target) return target;
    await sleep(250);
  }
  throw new Error(`Не дождались ${label} за ${timeoutMs} мс.`);
}

async function discoverExtension(browser) {
  const target = await waitForAny(
    browser,
    (item) => item.type() === 'service_worker' && item.url().includes('/background.js'),
    30_000,
    'service worker расширения',
  );
  return { extensionId: new URL(target.url()).host, target };
}

async function ensureWorkerTarget(browser, extensionId) {
  let target = browser
    .targets()
    .find((item) => item.type() === 'service_worker' && item.url().includes(extensionId));
  if (target) return target;

  const page = await browser.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'dsq-ping' })).catch(() => {});
  } finally {
    await page.close();
  }
  return waitForAny(
    browser,
    (item) => item.type() === 'service_worker' && item.url().includes(extensionId),
    15_000,
    'service worker',
  );
}

async function stubFetch(browser, extensionId, payload, status = 200) {
  const target = await ensureWorkerTarget(browser, extensionId);
  const worker = await target.worker();
  await worker.evaluate(
    (body, code) => {
      globalThis.__dsqRequests = [];
      globalThis.fetch = async (url, options = {}) => {
        globalThis.__dsqRequests.push({
          url: String(url),
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body || null,
        });
        return new Response(JSON.stringify(body), {
          status: code,
          headers: { 'Content-Type': 'application/json' },
        });
      };
    },
    payload,
    status,
  );
}

async function lastApiRequest(browser, extensionId) {
  const target = await ensureWorkerTarget(browser, extensionId);
  const worker = await target.worker();
  return worker.evaluate(() => globalThis.__dsqRequests?.at(-1) || null);
}

async function setSettings(optionsPage, settings) {
  await optionsPage.evaluate((value) => chrome.storage.local.set({ dsq_settings: value }), settings);
  await sleep(120);
}

async function readSettings(optionsPage) {
  return optionsPage.evaluate(async () => (await chrome.storage.local.get('dsq_settings')).dsq_settings);
}

async function getUi(page) {
  return page.evaluate(() => {
    const root = document.getElementById('dsq-root-host')?.shadowRoot;
    if (!root) return null;
    const fab = root.querySelector('.dsq-fab');
    const numbers = root.querySelector('.dsq-numbers');
    if (!fab || !numbers) return null;
    const fabRect = fab.getBoundingClientRect();
    const fabStyle = getComputedStyle(fab);
    const numberStyle = getComputedStyle(numbers);
    return {
      fab: {
        width: fabRect.width,
        height: fabRect.height,
        gapRight: window.innerWidth - fabRect.right,
        gapBottom: window.innerHeight - fabRect.bottom,
        opacity: Number(fabStyle.opacity),
        busy: fab.dataset.busy === 'true',
        title: fab.getAttribute('title') || '',
      },
      numbers: {
        text: numbers.textContent.trim(),
        show: numbers.dataset.show === 'true',
        kind: numbers.dataset.kind || '',
        opacity: Number(numberStyle.opacity),
      },
      hasPanel: Boolean(root.querySelector('.dsq-panel')),
    };
  });
}

async function waitUi(page, predicate, timeoutMs, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await getUi(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`UI не дошёл до состояния «${label}» за ${timeoutMs} мс. Последнее: ${JSON.stringify(last)}`);
}

async function clickFab(page) {
  const box = await page.evaluate(() => {
    const root = document.getElementById('dsq-root-host')?.shadowRoot;
    const fab = root?.querySelector('.dsq-fab');
    if (!fab) return null;
    const rect = fab.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (!box) throw new Error('Квадрат расширения не найден.');
  await page.mouse.click(box.x, box.y);
  return box;
}

async function waitForNumbers(page, expected, timeoutMs = 25_000) {
  return waitUi(
    page,
    (ui) => ui.numbers.show && ui.numbers.text === expected,
    timeoutMs,
    `номера ${expected}`,
  );
}

async function writeClipboard(page, text) {
  return page.evaluate(async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }, text);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('Chrome for Testing не найден. Выполните: PUPPETEER_CACHE_DIR=./.cache/puppeteer npx puppeteer browsers install chrome');
    process.exit(1);
  }
  console.log(`Chrome: ${chrome}`);

  mkdirSync(PREVIEW, { recursive: true });
  const { server, origin } = await startFixtureServer();

  const localLibs = join(ROOT, '.cache', 'libs', 'usr', 'lib', 'x86_64-linux-gnu');
  const chromeHome = join(ROOT, '.cache', 'chrome-home');
  mkdirSync(chromeHome, { recursive: true });
  const env = {
    ...process.env,
    HOME: chromeHome,
    XDG_CONFIG_HOME: join(chromeHome, '.config'),
    XDG_CACHE_HOME: join(chromeHome, '.cache'),
  };
  if (existsSync(localLibs)) {
    env.LD_LIBRARY_PATH = [localLibs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }

  const browser = await puppeteer
    .launch({
      executablePath: chrome,
      headless: false,
      env,
      args: [
        '--headless=new',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
      ],
      defaultViewport: { width: 1280, height: 900 },
      protocolTimeout: 120_000,
    })
    .catch((error) => {
      server.close();
      throw error;
    });

  try {
    const { extensionId } = await discoverExtension(browser);
    console.log(`Extension ID: ${extensionId}\n`);

    const optionsPage = await browser.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await optionsPage.waitForSelector('#save', { timeout: 10_000 });
    check('Страница настроек открывается', true);
    check('В настройках есть три режима', (await optionsPage.$$('input[name="mode"]')).length === 3);

    // Программный ввод: мышиные клики Puppeteer по extension-странице иногда
    // зависают в headless, хотя сама страница работает.
    await optionsPage.evaluate(() => {
      const input = document.getElementById('apiKey');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'sk-e2e-test-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await optionsPage.evaluate(() => document.getElementById('save').click());
    await sleep(500);
    const saved = await readSettings(optionsPage);
    check('Сохранение ключа из интерфейса', saved?.apiKey === 'sk-e2e-test-key', JSON.stringify(saved?.apiKey));

    await optionsPage.reload({ waitUntil: 'domcontentloaded' });
    await optionsPage.waitForSelector('#save');
    await optionsPage.setViewport({ width: 1280, height: 1160 });
    await sleep(350);
    await optionsPage.screenshot({ path: join(PREVIEW, 'settings.png') });

    await setSettings(optionsPage, {
      mode: 'api',
      apiKey: 'sk-e2e-test-key',
      apiBase: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      systemPrompt: DEFAULT_PROMPT,
    });
    await stubFetch(browser, extensionId, {
      choices: [{ message: { content: ANSWER_SINGLE } }],
      usage: { total_tokens: 52 },
    });

    await browser.defaultBrowserContext().overridePermissions(origin, [
      'clipboard-read',
      'clipboard-write',
      'clipboard-sanitized-write',
    ]);

    const page = await browser.newPage();
    await page.goto(`${origin}/fixture.html`, { waitUntil: 'networkidle2' });
    await page.bringToFront();

    const hostPresent = await page.waitForSelector('#dsq-root-host', { timeout: 8_000 }).then(() => true).catch(() => false);
    check('Контент-скрипт вставляет виджет', hostPresent);
    if (!hostPresent) throw new Error('Виджет не появился — дальше проверять нечего.');

    const initial = await getUi(page);
    check(
      'Квадрат 18×18 в правом нижнем углу',
      initial.fab.width === 18 &&
        initial.fab.height === 18 &&
        Math.abs(initial.fab.gapRight - 8) < 1 &&
        Math.abs(initial.fab.gapBottom - 8) < 1,
      JSON.stringify({ width: initial.fab.width, height: initial.fab.height, right: initial.fab.gapRight, bottom: initial.fab.gapBottom }),
    );
    check('Квадрат ненавязчивый в покое', initial.fab.opacity <= 0.3, `opacity=${initial.fab.opacity}`);
    check('Большой панели больше нет', initial.hasPanel === false);

    const copied = await writeClipboard(page, QUESTION);
    console.log(`  буфер обмена: ${copied.ok ? 'записан' : `недоступен (${copied.error})`}`);

    await clickFab(page);
    let ui = await waitForNumbers(page, '2', 30_000);
    await sleep(300);
    ui = await getUi(page);
    check('Один ответ показывается одним номером', ui.numbers.text === '2');
    check('Номера отрисованы полупрозрачно', ui.numbers.opacity > 0 && ui.numbers.opacity <= 0.75, `opacity=${ui.numbers.opacity}`);
    check('После ответа нет всплывающей панели', ui.hasPanel === false);

    const apiRequest = await lastApiRequest(browser, extensionId);
    check(
      'Запрос идёт на /chat/completions с Bearer-ключом',
      Boolean(apiRequest) &&
        apiRequest.url.endsWith('/chat/completions') &&
        apiRequest.headers?.Authorization === 'Bearer sk-e2e-test-key',
      apiRequest ? apiRequest.url : 'запроса нет',
    );
    let apiBody = null;
    try {
      apiBody = JSON.parse(apiRequest?.body || 'null');
    } catch {
      apiBody = null;
    }
    check(
      'В теле запроса модель, system-промпт и вопрос',
      apiBody?.model === 'deepseek-chat' &&
        apiBody?.stream === false &&
        apiBody?.messages?.[0]?.role === 'system' &&
        /номер/i.test(String(apiBody?.messages?.[0]?.content || '')) &&
        String(apiBody?.messages?.[1]?.content || '').includes('органоид'),
      apiBody ? `model=${apiBody.model}, messages=${apiBody.messages?.length}` : 'тело не разобрано',
    );

    await page.mouse.move(20, 20);
    await sleep(300);
    await page.screenshot({ path: join(PREVIEW, 'answer.png') });

    await stubFetch(browser, extensionId, {
      choices: [{ message: { content: ANSWER_MULTI } }],
      usage: { total_tokens: 60 },
    });
    await clickFab(page);
    ui = await waitForNumbers(page, '2, 4', 30_000);
    check('Несколько ответов показываются списком номеров', ui.numbers.text === '2, 4');

    await stubFetch(browser, extensionId, {
      choices: [{ message: { content: ANSWER_LETTERS } }],
      usage: { total_tokens: 58 },
    });
    await clickFab(page);
    ui = await waitForNumbers(page, '2', 30_000);
    check('Буквенный ответ B превращается в номер 2', ui.numbers.text === '2');

    await stubFetch(browser, extensionId, { error: { message: 'Authentication Fails' } }, 401);
    await clickFab(page);
    ui = await waitUi(page, (state) => state.numbers.show && state.numbers.kind === 'error', 25_000, 'ошибка 401');
    check('Ошибка 401 показывается компактным «!»', ui.numbers.text === '!', ui.numbers.text);
    check('Текст ошибки доступен в подсказке', ui.fab.title.includes('Неверный API-ключ'), ui.fab.title.split('\n')[0]);

    await stubFetch(browser, extensionId, {
      choices: [{ message: { content: ANSWER_SINGLE } }],
      usage: { total_tokens: 52 },
    });
    await clickFab(page);
    ui = await waitForNumbers(page, '2', 30_000);
    check('После ошибки можно повторить запрос', ui.numbers.text === '2');

    await sleep(16_000);
    const hidden = await getUi(page);
    check('Номера исчезают сами (15 секунд)', hidden.numbers.show === false && hidden.numbers.opacity === 0, `show=${hidden.numbers.show}, opacity=${hidden.numbers.opacity}`);

    /* ---------- Offscreen-чтение буфера ---------- */

    await page.bringToFront();
    await writeClipboard(page, QUESTION);
    const offscreenResult = await optionsPage.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'dsq-read-clipboard' }),
    );
    check(
      'Offscreen-документ читает буфер обмена',
      Boolean(offscreenResult?.ok) && (offscreenResult.text || '').trim() === QUESTION,
      offscreenResult?.ok ? `получено ${offscreenResult.text.length} символов` : offscreenResult?.error,
    );

    /* ---------- Режим вкладки chat.deepseek.com ---------- */

    const chatPage = await browser.newPage();
    await chatPage.setRequestInterception(true);
    chatPage.on('request', (request) => {
      if (request.isNavigationRequest() && request.url().startsWith('https://chat.deepseek.com/')) {
        request
          .respond({ status: 200, contentType: 'text/html; charset=utf-8', body: MOCK_CHAT_HTML })
          .catch(() => {});
      } else {
        request.abort().catch(() => {});
      }
    });
    await chatPage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
    await chatPage.waitForSelector('#chat-input', { timeout: 10_000 });
    await sleep(1_200);
    check('Мок-вкладка chat.deepseek.com загружена', true);

    await setSettings(optionsPage, {
      mode: 'web',
      apiKey: 'sk-e2e-test-key',
      apiBase: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      systemPrompt: DEFAULT_PROMPT,
    });

    await page.bringToFront();
    await writeClipboard(page, QUESTION);
    await sleep(300);
    await clickFab(page);
    ui = await waitForNumbers(page, '2', 90_000);
    check('Веб-режим получает номер через вкладку чата', ui.numbers.text === '2');

    const failing = results.filter((item) => !item.ok);
    console.log(`\n${failing.length === 0 ? '✓ E2E пройден' : `✗ Провалено проверок: ${failing.length}`}`);
    for (const item of failing) console.log(`  - ${item.name}: ${item.details}`);
    process.exitCode = failing.length === 0 ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main().catch((error) => {
  console.error('\nE2E упал:', error);
  process.exitCode = 1;
});
