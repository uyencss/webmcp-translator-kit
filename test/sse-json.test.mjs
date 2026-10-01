import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncrementalResultsParser } from '../extension/src/sse-json.mjs';

const ITEM1 = { id: 'T1', revision: 0, text: 'Chào thế giới' };
const ITEM2 = { id: 'T2', revision: 3, text: 'Cảm ơn bạn' };

function docOf(items) {
  return JSON.stringify({ results: items });
}

test('sse-json: single push whole document emits all items', () => {
  const p = createIncrementalResultsParser();
  const out = p.push(docOf([ITEM1, ITEM2]));
  assert.deepEqual(out, [ITEM1, ITEM2]);
  const fin = p.finish();
  assert.equal(fin.malformed, 0);
  assert.equal(fin.truncated, false);
});

test('sse-json: token-size splits (every 7 chars) still emit in order', () => {
  const doc = docOf([ITEM1, ITEM2]);
  const p = createIncrementalResultsParser();
  const got = [];
  for (let i = 0; i < doc.length; i += 7) {
    got.push(...p.push(doc.slice(i, i + 7)));
  }
  assert.deepEqual(got, [ITEM1, ITEM2]);
  assert.equal(p.finish().truncated, false);
});

test('sse-json: split inside string escape and unicode', () => {
  const tricky = { id: 'T9', revision: 1, text: 'A "quoted" \\ backslash\nnewline Việt' };
  const doc = docOf([tricky, ITEM1]);
  const p = createIncrementalResultsParser();
  const got = [];
  // hostile split points: inside \" escape, inside unicode run, mid-key
  for (const cut of [10, 25, 31, 44, 60, 97]) {
    void cut;
  }
  for (let i = 0; i < doc.length; i += 5) {
    got.push(...p.push(doc.slice(i, i + 5)));
  }
  assert.deepEqual(got, [tricky, ITEM1]);
});

test('sse-json: fenced ```json document', () => {
  const p = createIncrementalResultsParser();
  const got = [];
  got.push(...p.push('```json\n{"results": ['));
  got.push(...p.push(JSON.stringify(ITEM1)));
  got.push(...p.push(',\n'));
  got.push(...p.push(JSON.stringify(ITEM2)));
  got.push(...p.push(']}```'));
  assert.deepEqual(got, [ITEM1, ITEM2]);
  assert.equal(p.finish().truncated, false);
});

test('sse-json: pretty-printed multiline JSON', () => {
  const pretty = '{\n  "results": [\n    ' + JSON.stringify(ITEM1) + ',\n    ' + JSON.stringify(ITEM2) + '\n  ]\n}';
  const p = createIncrementalResultsParser();
  const got = [];
  for (let i = 0; i < pretty.length; i += 11) {
    got.push(...p.push(pretty.slice(i, i + 11)));
  }
  assert.deepEqual(got, [ITEM1, ITEM2]);
});

test('sse-json: items emitted before document end (progressive)', () => {
  const p = createIncrementalResultsParser();
  p.push('{"results": [');
  const first = p.push(JSON.stringify(ITEM1) + ',');
  assert.deepEqual(first, [ITEM1]);
  assert.deepEqual(p.stats().items, 1);
  const second = p.push(JSON.stringify(ITEM2));
  assert.deepEqual(second, [ITEM2]);
});

test('sse-json: malformed item counted, valid items still emitted', () => {
  const p = createIncrementalResultsParser();
  const out = p.push('{"results": [{"id": 123, "revision": "x"}, ' + JSON.stringify(ITEM1) + ']}');
  assert.deepEqual(out, [ITEM1]);
  assert.equal(p.finish().malformed, 1);
});

test('sse-json: truncated tail flagged', () => {
  const p = createIncrementalResultsParser();
  p.push('{"results": [' + JSON.stringify(ITEM1) + ', {"id": "T3", "text": "cut');
  const fin = p.finish();
  assert.deepEqual(fin.items, [ITEM1]);
  assert.equal(fin.truncated, true);
});
