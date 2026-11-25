/**
 * Offscreen-документ нужен только для чтения буфера обмена:
 * обычный контент-скрипт не может читать клипборд на большинстве сайтов.
 */
async function readClipboard() {
  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (typeof text === 'string' && text.length > 0) return text;
    }
  } catch {
    /* ниже пробуем execCommand('paste') */
  }

  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.tabIndex = -1;
  textarea.style.cssText =
    'position: fixed; left: 0; top: 0; width: 10px; height: 10px; opacity: 0; pointer-events: none;';
  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
  } catch {
    /* ignore */
  }

  let ok = false;
  try {
    ok = document.execCommand('paste');
  } catch {
    ok = false;
  }

  const value = textarea.value;
  textarea.remove();

  if (!ok && !value) {
    throw new Error('Браузер не разрешил чтение буфера обмена. Вставьте вопрос вручную (Ctrl+V).');
  }
  return value;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;
  if (message.type !== 'read-clipboard') return false;

  readClipboard()
    .then((text) => sendResponse({ ok: true, text }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
