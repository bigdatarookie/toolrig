import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentsAdapter } from '../src/documents.js';

test('document CSV adapter reads bounded contained source and preserves exact cells', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'toolrig-csv-reader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'documents'); await mkdir(root);
  const file = join(root, 'prices.csv');
  await writeFile(file, 'Ticker,NAME,ID,Date,Price,Units,PIT\n  ABC ,Name,0001,2026-11-14,1.00,USD,2026-11-14T10:00:00Z\n');
  const adapter = new DocumentsAdapter({ root });
  const result = await adapter.extractCsv({ path: file, ticker_column: 'Ticker' });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].values.Ticker, '  ABC ');
  assert.equal(result.rows[0].typed_ticker.typed, 'ABC');
  assert.equal(result.rows[0].values.NAME, 'Name');
  assert.equal(result.rows[0].values.ID, '0001');
  assert.equal(result.rows[0].values.Price, '1.00');
  assert.equal(result.rows[0].values.PIT, '2026-11-14T10:00:00Z');
});

test('document CSV adapter rejects invalid UTF-8 rather than replacing exact source bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'toolrig-csv-reader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'documents'); await mkdir(root);
  const file = join(root, 'invalid.csv');
  await writeFile(file, Buffer.from([0x41, 0x2c, 0x42, 0x0a, 0xff, 0x2c, 0x31, 0x0a]));
  const result = await new DocumentsAdapter({ root }).extractCsv({ path: file });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_utf8');
});

test('Qwen fallback retains direct extracted result and successful compaction keeps source references', async () => {
  const adapter = new DocumentsAdapter({ root: '/tmp', qwenCompactor: {
    compact: async () => ({ status: 'direct_source', reason: 'gateway_busy', model_calls: 0 }),
  } });
  const original = { ok: true, data: 'source text', source_refs: [{ page: 8 }] };
  const fallback = await adapter.compactReadResult(original, { qwen_eligible: true });
  assert.equal(fallback.data, original.data);
  assert.equal(fallback.compaction.reason, 'gateway_busy');

  adapter.qwenCompactor.compact = async () => ({ status: 'compacted', summary: {
    facts: [{ text: 'x', source_ids: ['s1'] }], source_refs: [{ page: 8 }],
  }, output_tokens_o200k: 20 });
  const compacted = await adapter.compactReadResult({ ...original, data: { text: 'source text' } }, { qwen_eligible: true });
  assert.equal(compacted.data.kind, 'question_directed_compaction');
  assert.deepEqual(compacted.data.source_refs, [{ page: 8 }]);
  assert.deepEqual(compacted.source_refs, [{ page: 8 }]);
});

test('document read invokes Qwen only on explicit eligible compaction and preserves direct source on fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'toolrig-document-qwen-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'documents'); await mkdir(root);
  const file = join(root, 'excerpt.txt'); await writeFile(file, 'fixture');
  const text = Array.from({ length: 9000 }, (_, i) => `source item ${i}`).join('\n');
  const cli = join(dir, 'documents-cli');
  await writeFile(cli, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,status:'ok',operation:'read',source:{name:'excerpt.txt',format:'txt'},data:{text:${JSON.stringify(text)}},source_refs:[{page:3,paragraph:2}],warnings:[]}));\n`, { mode: 0o700 });
  const received = [];
  const adapter = new DocumentsAdapter({ command: cli, root, qwenCompactor: {
    compact: async input => {
      received.push(input);
      return { status: 'direct_source', reason: 'gateway_busy', model_calls: 0 };
    },
  } });
  const ordinary = await adapter.invoke('read', { path: file });
  assert.equal(received.length, 0);
  const compact = await adapter.invoke('read', { path: file, compact_for_context: true, qwen_eligible: true,
    question: 'Which fact is stated?', consumer_window_tokens: 16_000, consumer_tokens_used: 100 });
  assert.equal(received.length, 1);
  assert.equal(received[0].qwenEligible, true);
  assert.deepEqual(received[0].sourceRefs, [{ page: 3, paragraph: 2 }]);
  assert.equal(received[0].question, 'Which fact is stated?');
  assert.equal(ordinary.data.text, text);
  assert.equal(compact.data.text, text);
  assert.equal(compact.compaction.reason, 'gateway_busy');
});
