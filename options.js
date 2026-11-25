import { DEFAULT_SETTINGS, DEFAULT_PROMPT, normalizeSettings } from './lib/core.js';

const SETTINGS_KEY = 'dsq_settings';
const KNOWN_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

const $ = (id) => document.getElementById(id);
const state = { saved: null, dirty: false, saveTimer: null };

init();

async function init() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = normalizeSettings(data[SETTINGS_KEY]);
  applySettings(settings);
  bindEvents();
  $('version').textContent = chrome.runtime.getManifest().version;
  await showShortcut();
}

/* ------------------------------------------------------------------ */
/* Данные формы                                                        */
/* ------------------------------------------------------------------ */

function applySettings(settings) {
  const radio = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
  if (radio) radio.checked = true;
  $('apiKey').value = settings.apiKey;
  $('apiBase').value = settings.apiBase;
  $('systemPrompt').value = settings.systemPrompt;
  ensureModelOption(settings.model);
  $('model').value = settings.model;
  state.saved = settings;
}

function ensureModelOption(model) {
  const select = $('model');
  if (!model || Array.from(select.options).some((option) => option.value === model)) return;
  const option = document.createElement('option');
  option.value = model;
  option.textContent = `${model} — из сохранённых настроек`;
  select.appendChild(option);
}

function getMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'auto';
}

/** Проверяет Base URL и возвращает нормализованное значение + origin. */
function parseBase(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: true, base: DEFAULT_SETTINGS.apiBase, origin: 'https://api.deepseek.com' };
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, error: 'Base URL должен начинаться с https:// (или http:// для локального прокси).' };
    }
    return { ok: true, base: raw.replace(/\/+$/, ''), origin: url.origin };
  } catch {
    return { ok: false, error: 'Base URL указан неверно. Пример: https://api.deepseek.com' };
  }
}

function collect() {
  const baseInfo = parseBase($('apiBase').value);
  if (!baseInfo.ok) return baseInfo;
  const settings = normalizeSettings({
    mode: getMode(),
    apiKey: $('apiKey').value,
    apiBase: baseInfo.base,
    model: $('model').value,
    systemPrompt: $('systemPrompt').value,
    temperature: state.saved?.temperature,
    maxChars: state.saved?.maxChars,
  });
  return { ok: true, settings, origin: baseInfo.origin };
}

/* ------------------------------------------------------------------ */
/* Статусы                                                            */
/* ------------------------------------------------------------------ */

function setSaveState(text, kind = '') {
  const node = $('saveState');
  node.textContent = text || '';
  node.dataset.kind = kind;
}

function setTestResult(text, kind = '', withDot = true) {
  const node = $('testResult');
  node.textContent = '';
  if (withDot && text) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    node.appendChild(dot);
  }
  node.appendChild(document.createTextNode(text || ''));
  node.dataset.kind = kind;
}

function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    setSaveState('Есть несохранённые изменения', '');
  }
}

function markClean() {
  state.dirty = false;
}

/* ------------------------------------------------------------------ */
/* Действия                                                           */
/* ------------------------------------------------------------------ */

async function ensureHostPermission(origin) {
  if (origin === 'https://api.deepseek.com') return true;
  try {
    return await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

async function save() {
  const payload = collect();
  if (!payload.ok) {
    setSaveState(payload.error, 'error');
    return;
  }
  if (!(await ensureHostPermission(payload.origin))) {
    setSaveState(`Нужно разрешение на доступ к ${payload.origin}`, 'error');
    return;
  }

  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: payload.settings });
  } catch (err) {
    setSaveState(err?.message || 'Не удалось сохранить настройки.', 'error');
    return;
  }

  state.saved = payload.settings;
  markClean();
  setSaveState('Сохранено ✓', 'ok');
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (!state.dirty) setSaveState('Изменений нет', '');
  }, 2400);
}

async function testConnection() {
  const payload = collect();
  if (!payload.ok) {
    setTestResult(payload.error, 'error');
    return;
  }
  if (!payload.settings.apiKey) {
    setTestResult('Сначала вставьте и сохраните API-ключ.', 'error');
    return;
  }
  if (!(await ensureHostPermission(payload.origin))) {
    setTestResult(`Нужно разрешение на доступ к ${payload.origin}`, 'error');
    return;
  }

  $('test').disabled = true;
  setTestResult('Проверяю ключ…', 'pending');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'dsq-test-key', settings: payload.settings });
    if (!result?.ok) {
      setTestResult(result?.error || 'Не удалось проверить ключ.', 'error');
      return;
    }
    if (result.modelWarning) {
      setTestResult(result.modelWarning, 'warn');
      return;
    }
    if (result.available === false) {
      setTestResult('Ключ принят, но API сообщает, что он сейчас недоступен.', 'warn');
      return;
    }
    setTestResult(result.balance ? `Ключ работает · баланс ${result.balance}` : 'Ключ работает ✓', 'ok');
  } catch {
    setTestResult('Расширение не ответило. Перезагрузите его на chrome://extensions.', 'error');
  } finally {
    $('test').disabled = false;
  }
}

async function resetPrompt() {
  $('systemPrompt').value = DEFAULT_PROMPT;
  markDirty();
  setSaveState('Промпт сброшен — не забудьте сохранить', '');
}

async function resetAll() {
  const confirmed = window.confirm(
    'Сбросить ключ, режим и системный промпт? Это действие нельзя отменить.',
  );
  if (!confirmed) return;
  await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  applySettings(DEFAULT_SETTINGS);
  markClean();
  setTestResult('');
  setSaveState('Настройки сброшены', 'ok');
}

async function showShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const command = commands.find((item) => item.name === 'ask-clipboard');
    $('shortcutLabel').textContent = command?.shortcut || 'Alt+Shift+D';
  } catch {
    $('shortcutLabel').textContent = 'Alt+Shift+D';
  }
}

/* ------------------------------------------------------------------ */
/* События                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', testConnection);
  $('resetPrompt').addEventListener('click', resetPrompt);
  $('resetAll').addEventListener('click', resetAll);

  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('toggleKey').textContent = reveal ? 'Скрыть' : 'Показать';
  });

  for (const input of document.querySelectorAll('input, select, textarea')) {
    input.addEventListener('input', markDirty);
    input.addEventListener('change', markDirty);
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  });
}
