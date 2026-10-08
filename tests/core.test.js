'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extension/core');
const dictionary = require('../extension/data/cefr.json');
test('CEFR data has six nonempty bands and recognizable vocabulary', () => {
  for (const level of C.LEVELS) assert(Object.values(dictionary).filter(v => v === level).length > 100);
  assert.equal(dictionary.apple, 'A1');
  assert(Object.keys(dictionary).length > 8000);
});
test('multi-level seed is a one-time union, preserving manually recorded states', () => {
  const state = C.emptyState(); C.mark(state, 'apple', 'mastered', dictionary);
  C.seed(state, ['A1', 'B2', 'B2'], dictionary);
  assert.deepEqual(state.levels, ['A1', 'B2']);
  assert.equal(state.words.apple.status, 'mastered');
  assert(Object.values(state.words).every(r => ['A1', 'B2'].includes(r.level)));
  assert.throws(() => C.seed(state, ['C1'], dictionary));
  assert.throws(() => C.seed(C.emptyState(), [], dictionary));
});
test('any English word moves exclusively through three states and retains examples', () => {
  const state = C.emptyState();
  for (const status of ['learning', 'mastered', 'new']) C.mark(state, 'Quasar', status, dictionary, { text: 'A quasar shines.', url: 'https://example.org', title: 'Space' });
  assert.equal(state.words.quasar.status, 'new'); assert.equal(state.words.quasar.examples.length, 1);
  assert.deepEqual(C.counts(state), { new: 1, learning: 0, mastered: 0 });
  C.mark(state, 'constructor', 'learning', {});
  assert.equal(state.words.constructor.word, 'constructor'); assert.equal({}.status, undefined);
  assert.throws(() => C.mark(state, '__proto__', 'new', dictionary));
  assert.throws(() => C.mark(state, 'two words', 'learning', dictionary));
});
test('examples deduplicate, cap at ten, and reject executable source links', () => {
  const state = C.emptyState();
  for (let i = 0; i < 14; i++) C.mark(state, 'hello', 'learning', dictionary, { text: `Context ${i}`, url: 'javascript:alert(1)' });
  assert.equal(state.words.hello.examples.length, 10); assert.equal(state.words.hello.examples[0].url, '');
});
test('tokens honor complete English words, case, hyphens and accented boundaries', () => {
  assert.deepEqual(C.tokens('APPLE café naïve caféapple apple42 state-of-the-art don’t.').map(t => t.word), ['apple', 'state-of-the-art', "don't"]);
});
test('AI parser rejects truncated/empty outputs and bounds every displayed field', () => {
  const result = C.parseAI({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ meaning: 'm'.repeat(300), example: 'e'.repeat(900) }) } }] });
  assert.equal(result.meaning.length, 80); assert.equal(result.example.length, 180);
  assert.throws(() => C.parseAI({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }));
  assert.throws(() => C.parseAI({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }));
});
test('pronunciation URLs are limited to HTTPS dictionary hosts', () => {
  assert.equal(C.safeAudio('javascript:alert(1)'), ''); assert.equal(C.safeAudio('https://evil.example/audio.mp3'), '');
  assert.equal(C.safeAudio(C.dictionaryAudio('resilient')), 'https://dict.youdao.com/dictvoice?audio=resilient&type=2');
  assert.equal(C.dictionaryAudio('two words'), '');
});
test('every CEFR entry has short Chinese translation or an explicit source-word warning', () => {
  const translations = require('../extension/data/translations.json');
  assert.deepEqual(Object.keys(translations).sort(), Object.keys(dictionary).sort());
  for (const [word, meaning] of Object.entries(translations)) {
    assert(/[\u4e00-\u9fff]/.test(meaning), word); assert(meaning.length <= 60, word);
  }
  assert.equal(translations.apple, '苹果；家伙'); assert.equal(translations.download, '下载');
  assert.match(translations.porten, /待核对/);
});
test('changing levels removes only untouched entries of dropped levels and seeds added ones', () => {
  const dict = { apple: 'A1', forest: 'B1', trail: 'B1', quasar: 'B1', candid: 'B1', glimpse: 'B1', obscure: 'C1', yield: 'C2' };
  assert.throws(() => C.setLevels(C.emptyState(), ['B2'], dict), /请先建立/);
  const state = C.emptyState(); C.seed(state, ['B1', 'C1'], dict, 10);
  C.mark(state, 'trail', 'learning', dict, null, 20);
  C.mark(state, 'quasar', 'new', dict, null, 30);
  state.words.candid.examples.push({ text: 'A candid answer.', url: '', title: '', created: 40 });
  state.words.glimpse.lookup = { meaning: '一瞥', example: 'A glimpse.' };
  assert.throws(() => C.setLevels(state, [], dict), /至少一个/);
  assert.deepEqual(C.setLevels(state, ['C2', 'C1', 'C2'], dict, 50), { added: 1, removed: 1 });
  assert.deepEqual(state.levels, ['C1', 'C2']); assert.equal(state.levelsUpdated, 50);
  assert.deepEqual(Object.keys(state.words).sort(), ['candid', 'glimpse', 'obscure', 'quasar', 'trail', 'yield']);
  assert.equal(state.words.trail.status, 'learning'); assert.equal(state.words.yield.status, 'new');
});
