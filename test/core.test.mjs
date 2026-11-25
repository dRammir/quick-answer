import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROMPT,
  DEFAULT_SETTINGS,
  normalizeSettings,
  clampQuestion,
  buildUserPrompt,
  buildWebPrompt,
  extractApiContent,
  parseAnswer,
  extractAnswerNumbers,
  describeApiError,
} from '../lib/core.js';

test('normalizeSettings: пустые данные → значения по умолчанию', () => {
  assert.deepEqual(normalizeSettings(), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings('мусор'), { ...DEFAULT_SETTINGS });
});

test('normalizeSettings: валидные поля проходят, мусор отсекается', () => {
  const settings = normalizeSettings({
    mode: 'web',
    apiKey: '  sk-123  ',
    apiBase: 'https://proxy.example.com/v1///',
    model: ' deepseek-reasoner ',
    temperature: 5,
    maxChars: 10,
    systemPrompt: '  Отвечай кратко.  ',
  });
  assert.equal(settings.mode, 'web');
  assert.equal(settings.apiKey, 'sk-123');
  assert.equal(settings.apiBase, 'https://proxy.example.com/v1');
  assert.equal(settings.model, 'deepseek-reasoner');
  assert.equal(settings.temperature, 2);
  assert.equal(settings.maxChars, 500);
  assert.equal(settings.systemPrompt, 'Отвечай кратко.');

  const fallback = normalizeSettings({
    mode: 'hack',
    apiBase: 'javascript:alert(1)',
    model: '   ',
    systemPrompt: '',
    temperature: 'abc',
  });
  assert.equal(fallback.mode, 'auto');
  assert.equal(fallback.apiBase, DEFAULT_SETTINGS.apiBase);
  assert.equal(fallback.model, DEFAULT_SETTINGS.model);
  assert.equal(fallback.temperature, DEFAULT_SETTINGS.temperature);
  assert.equal(fallback.systemPrompt, DEFAULT_PROMPT);

  const legacy = normalizeSettings({
    systemPrompt: 'ОТВЕТ: <буква/номер и текст правильного варианта>\nПОЯСНЕНИЕ: <1–3 предложения, почему это верно>',
  });
  assert.equal(legacy.systemPrompt, DEFAULT_PROMPT);
});

test('clampQuestion: обрезает пробелы и слишком длинный текст', () => {
  assert.deepEqual(clampQuestion('  Вопрос?\n\n A) да \n'), { text: 'Вопрос?\n\n A) да', truncated: false });
  const long = 'x'.repeat(600);
  const result = clampQuestion(long, 500);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 500);
  assert.deepEqual(clampQuestion(null), { text: '', truncated: false });
});

test('buildUserPrompt / buildWebPrompt содержат вопрос и инструкции', () => {
  assert.match(buildUserPrompt('Вопрос?'), /Вопрос и варианты ответов:\n\nВопрос\?/);
  const web = buildWebPrompt('Вопрос?', 'СИСТЕМА');
  assert.ok(web.startsWith('СИСТЕМА'));
  assert.ok(web.includes('Вопрос?'));
  assert.ok(buildWebPrompt('Вопрос?').startsWith(DEFAULT_PROMPT));
});

test('extractApiContent: content, fallback на reasoning, пустые ответы', () => {
  const content = extractApiContent({ choices: [{ message: { content: ' ОТВЕТ: A ' } }] });
  assert.equal(content, 'ОТВЕТ: A');
  const reasoning = extractApiContent({ choices: [{ message: { content: '', reasoning_content: 'размышление' } }] });
  assert.equal(reasoning, 'размышление');
  assert.equal(extractApiContent({}), '');
  assert.equal(extractApiContent(null), '');
  assert.equal(extractApiContent({ choices: [] }), '');
});

test('parseAnswer: строгий формат', () => {
  const result = parseAnswer('ОТВЕТ: B) Митохондрия\nПОЯСНЕНИЕ: В ней идёт дыхательная цепь.');
  assert.equal(result.answer, 'B) Митохондрия');
  assert.equal(result.explanation, 'В ней идёт дыхательная цепь.');
  assert.equal(result.parsed, true);
});

test('parseAnswer: markdown, разные двоеточия и английские метки', () => {
  assert.equal(parseAnswer('**ОТВЕТ:** C — Аппарат Гольджи').answer, 'C — Аппарат Гольджи');
  assert.equal(parseAnswer('**Ответ**: A\n**Пояснение**: так исторически сложилось.').answer, 'A');
  assert.equal(parseAnswer('ANSWER: D\nEXPLANATION: because.').answer, 'D');
  const withDash = parseAnswer('ОТВЕТ — 42\nПОЯСНЕНИЕ: это число.');
  assert.equal(withDash.answer, '42');
  assert.equal(withDash.explanation, 'это число.');
});

test('parseAnswer: свободный текст без меток', () => {
  const result = parseAnswer('Правильный ответ: Париж.\nПотому что это столица Франции.');
  assert.equal(result.answer, 'Париж.');
  assert.equal(result.parsed, true);

  const inline = parseAnswer('Конечно! Правильный ответ — B) Митохондрия, потому что там АТФ.');
  assert.equal(inline.answer, 'B) Митохондрия, потому что там АТФ.');

  const plain = parseAnswer('42');
  assert.equal(plain.answer, '42');
  assert.equal(plain.parsed, true);
  assert.equal(parseAnswer('').parsed, false);
  assert.equal(parseAnswer(null).answer, '');
});

test('parseAnswer: пояснение без метки берётся из остатка ответа', () => {
  const result = parseAnswer('ОТВЕТ: B) Митохондрия\nМитохондрии — энергетические станции клетки.');
  assert.equal(result.answer, 'B) Митохондрия');
  assert.match(result.explanation, /энергетические станции/);
});

test('parseAnswer: метка пояснения в той же строке', () => {
  const result = parseAnswer('ОТВЕТ: B) Митохондрия ПОЯСНЕНИЕ: там идёт дыхательная цепь.');
  assert.equal(result.answer, 'B) Митохондрия');
  assert.equal(result.explanation, 'там идёт дыхательная цепь.');
});

test('parseAnswer: несколько вопросов перечисляются', () => {
  const result = parseAnswer('ОТВЕТ: A\nПОЯСНЕНИЕ: первое.\nОТВЕТ: C\nПОЯСНЕНИЕ: второе.');
  assert.equal(result.answer, 'A · C');
  assert.match(result.explanation, /первое/);
});

test('describeApiError: понятные сообщения', () => {
  assert.match(describeApiError(401, ''), /API-ключ/);
  assert.match(describeApiError(402, ''), /баланс/i);
  assert.match(describeApiError(429, ''), /Слишком много/i);
  assert.match(describeApiError(503, ''), /перегружен/i);
  assert.match(describeApiError(500, 'boom'), /временно недоступен/i);
  assert.match(describeApiError(418, 'teapot'), /418.*teapot/i);
});

/* ------------------------------------------------------------------ */
/* Номера вариантов                                                    */
/* ------------------------------------------------------------------ */

const OPTIONS = `Какой органоид клетки синтезирует основную часть АТФ?

A) Рибосома
B) Митохондрия
C) Аппарат Гольджи
D) Лизосома`;

test('extractAnswerNumbers: числовой ответ и несколько номеров', () => {
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: 2', OPTIONS), [2]);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: 2, 4', OPTIONS), [2, 4]);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: 2; 4; 1', OPTIONS), [2, 4, 1]);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: 2\nОТВЕТ: 4', OPTIONS), [2, 4]);
  assert.deepEqual(extractAnswerNumbers('ANSWER: 3', OPTIONS), [3]);
});

test('extractAnswerNumbers: буквы сопоставляются с порядком вариантов', () => {
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: B) Митохондрия', OPTIONS), [2]);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: C', OPTIONS), [3]);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: Вариант D', OPTIONS), [4]);
  assert.deepEqual(extractAnswerNumbers('**ОТВЕТ:** B', OPTIONS), [2]);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: (B)', OPTIONS), [2]);
});

test('extractAnswerNumbers: текстовый ответ ищется среди вариантов', () => {
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: Митохондрия', OPTIONS), [2]);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: Аппарат Гольджи', OPTIONS), [3]);
});

test('extractAnswerNumbers: варианты в скобках не путаются с вопросом', () => {
  const bracketed = `В каком году это было?\n(A) 1900\n(B) 1905\n(C) 1910`;
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: B', bracketed), [2]);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: (C) 1910', bracketed), [3]);
});

test('extractAnswerNumbers: кириллические метки и нумерованные варианты', () => {
  const cyrillic = `Вопрос?\nА) Рибосома\nБ) Митохондрия\nВ) Аппарат Гольджи`;
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: Б', cyrillic), [2]);

  const numbered = `1. Вопрос?\n1) Рибосома\n2) Митохондрия\n3) Аппарат Гольджи`;
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: 2', numbered), [2]);
});

test('extractAnswerNumbers: без вариантов, ноль и мусор', () => {
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: 42', 'Сколько будет 6 × 7?'), [42]);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: 0', OPTIONS), []);
  assert.deepEqual(extractAnswerNumbers('', OPTIONS), []);
  assert.deepEqual(extractAnswerNumbers('ОТВЕТ: не знаю', OPTIONS), []);
});
