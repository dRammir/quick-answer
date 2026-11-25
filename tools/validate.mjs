/**
 * Статическая проверка расширения: манифест, ссылки, CSP, иконки, синтаксис.
 * Запуск: npm run validate
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const notes = [];

function fail(message) {
  errors.push(message);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${file}: некорректный JSON — ${err.message}`);
    return null;
  }
}

const manifestPath = join(ROOT, 'manifest.json');
const manifest = readJson(manifestPath);
if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest.json: ожидается Manifest V3');
  if (!manifest.name) fail('manifest.json: нет name');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) fail('manifest.json: version должен быть вида 1.0.0');
  if (!manifest.background?.service_worker) fail('manifest.json: не указан background.service_worker');
  if (!manifest.content_scripts?.some((item) => (item.matches || []).includes('<all_urls>'))) {
    fail('manifest.json: контент-скрипт должен матчить <all_urls>');
  }
  for (const permission of ['storage', 'clipboardRead', 'offscreen', 'tabs']) {
    if (!manifest.permissions?.includes(permission)) fail(`manifest.json: нет обязательного разрешения ${permission}`);
  }
  if (!manifest.host_permissions?.includes('https://api.deepseek.com/*')) {
    fail('manifest.json: нет host_permissions для api.deepseek.com');
  }
  if (!manifest.host_permissions?.includes('https://chat.deepseek.com/*')) {
    fail('manifest.json: нет host_permissions для chat.deepseek.com');
  }

  const referenced = new Set();
  if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) referenced.add(file);
    for (const file of script.css || []) referenced.add(file);
  }
  if (manifest.options_ui?.page) referenced.add(manifest.options_ui.page);
  if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
  for (const size of Object.values(manifest.icons || {})) referenced.add(size);
  for (const size of Object.values(manifest.action?.default_icon || {})) referenced.add(size);

  for (const file of referenced) {
    if (!existsSync(join(ROOT, file))) fail(`manifest.json ссылается на отсутствующий файл: ${file}`);
  }
  notes.push(`manifest: ${referenced.size} локальных файлов найдено`);

  const pngSizes = { 'icons/icon16.png': 16, 'icons/icon32.png': 32, 'icons/icon48.png': 48, 'icons/icon128.png': 128 };
  for (const [file, expected] of Object.entries(pngSizes)) {
    const absolute = join(ROOT, file);
    if (!existsSync(absolute)) continue;
    const buffer = readFileSync(absolute);
    const isPng = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!isPng) fail(`${file}: не PNG`);
    else {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width !== expected || height !== expected) fail(`${file}: размер ${width}×${height}, ожидался ${expected}×${expected}`);
    }
  }
}

/* ---------- HTML: локальные ссылки и inline-скрипты ---------- */

const htmlFiles = readdirSync(ROOT).filter((file) => extname(file) === '.html');
for (const file of htmlFiles) {
  const html = readFileSync(join(ROOT, file), 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
    fail(`${file}: inline <script> запрещён политикой CSP расширения`);
  }
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    if (/^(?:https?:|data:|#|\/\/)/i.test(value)) continue;
    const target = join(ROOT, value);
    if (!existsSync(target)) fail(`${file}: ссылка на отсутствующий файл ${value}`);
  }
}

/* ---------- Синтаксис JS ---------- */

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (['node_modules', '.cache', '.git', 'preview'].includes(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) files.push(...walk(absolute));
    else if (extname(entry) === '.js' || extname(entry) === '.mjs') files.push(absolute);
  }
  return files;
}

for (const file of walk(ROOT)) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`${file.slice(ROOT.length + 1)}: синтаксическая ошибка\n${err.stderr?.toString() || err.message}`);
  }
}
notes.push(`синтаксис JS проверен: ${walk(ROOT).length} файлов`);

/* ---------- Импорты внутри расширения ---------- */

for (const file of walk(ROOT)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[1]);
    if (!existsSync(target)) fail(`${file.slice(ROOT.length + 1)}: импорт не найден — ${match[1]}`);
  }
}

/* ---------- Итог ---------- */

for (const note of notes) console.log(`• ${note}`);
if (errors.length) {
  console.error(`\n✗ Найдено ошибок: ${errors.length}`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('\n✓ Проверка пройдена');
