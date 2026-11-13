import test from 'node:test';
import assert from 'node:assert/strict';
import { countO200kTokens, QwenCompactor } from '../src/qwen-compactor.js';

const sourceText = Array.from({ length: 9000 }, (_, i) => `record${i} value observed`).join('\n');
const refs = [{ source: 'annual-report.pdf', page: 4, paragraph: 2 }];
const goodSummary = JSON.stringify({
  facts: [{ text: 'Reported value is 12.0 USD.', source_ids: ['s1'] }],
  limits: [{ text: 'The excerpt covers one page only.', source_ids: ['s1'] }],
  unknowns: [{ question: 'What was the later value?', source_ids: ['s1'] }],
  source_ids: ['s1'],
});

function compactorWith(complete) {
  const calls = [];
  const compactor = new QwenCompactor({
    endpoint: 'http://127.0.0.1:18583/v1/chat/completions',
    healthUrl: 'http://127.0.0.1:18583/__alfarig_health', model: 'configured-local-model', apiKey: 'test-secret',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('__alfarig_health')) return Response.json({ active_requests: 0, waiting_requests: 0 });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: complete } }] });
    },
  });
  return { compactor, calls };
}

test('Qwen route counts o200k tokens and performs one no-thinking request within dynamic window', async () => {
  assert.ok(countO200kTokens(sourceText) >= 8000);
  const { compactor, calls } = compactorWith(goodSummary);
  const result = await compactor.compact({ question: 'What value is reported?', text: sourceText,
    sourceRefs: refs, exactFacts: [{ field: 'unit', value: 'USD' }], consumerWindowTokens: 10_000,
    consumerTokensUsed: 9_000, consumerReserveTokens: 512, qwenEligible: true });
  assert.equal(result.status, 'compacted');
  assert.equal(result.total_output_budget_o200k, 488);
  assert.ok(result.model_max_output_o200k > 128 && result.model_max_output_o200k < 488);
  assert.ok(result.output_tokens_o200k <= 488);
  assert.deepEqual(result.summary.unknowns, [{ question: 'What was the later value?', source_ids: ['s1'] }]);
  assert.deepEqual(result.summary.source_refs, refs);
  assert.deepEqual(result.summary.exact_facts, [{ field: 'unit', value: 'USD' }]);
  assert.equal(calls.length, 2);
  const request = JSON.parse(calls[1].options.body);
  assert.equal(request.max_tokens, result.model_max_output_o200k);
  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
  assert.equal(request.temperature, 0);
  assert.equal(calls[1].options.headers.authorization, 'Bearer test-secret');
  assert.doesNotMatch(JSON.stringify(result), /test-secret/);
});

test('short, ineligible, unlocated, or unknown-budget source stays direct without gateway calls', async () => {
  const { compactor, calls } = compactorWith(goodSummary);
  const base = { question: 'Find the answer.', text: sourceText, sourceRefs: refs,
    consumerWindowTokens: 10_000, consumerTokensUsed: 100, qwenEligible: true };
  for (const input of [
    { ...base, text: 'short' },
    { ...base, qwenEligible: false },
    { ...base, sourceRefs: [] },
    { ...base, consumerWindowTokens: undefined },
  ]) {
    const result = await compactor.compact(input);
    assert.equal(result.status, 'direct_source');
    assert.equal(result.model_calls, 0);
  }
  assert.deepEqual(calls, []);
});

test('busy gateway and malformed model output return direct-source fallback without retries', async () => {
  const busy = compactorWith(goodSummary);
  busy.calls.length = 0;
  busy.compactor.fetchImpl = async (url) => {
    busy.calls.push(String(url));
    if (String(url).includes('__alfarig_health')) return Response.json({ active_requests: 1, waiting_requests: 0 });
    throw new Error('must not infer while busy');
  };
  assert.equal((await busy.compactor.compact({ question: 'Q?', text: sourceText, sourceRefs: refs,
    consumerWindowTokens: 10_000, consumerTokensUsed: 100, qwenEligible: true })).reason, 'gateway_busy');
  assert.equal(busy.calls.length, 1);

  const malformed = compactorWith('{"facts":[],"limits":[],"unknowns":[{"text":"unknown","source_ids":["s1"]}],"source_ids":["s1"]}');
  const result = await malformed.compactor.compact({ question: 'Q?', text: sourceText, sourceRefs: refs,
    consumerWindowTokens: 10_000, consumerTokensUsed: 100, qwenEligible: true });
  assert.equal(result.status, 'direct_source');
  assert.equal(result.reason, 'compactor_output_schema_invalid');
  assert.equal(result.model_calls, 1);
  assert.equal(malformed.calls.length, 2);
});

test('Qwen route refuses non-loopback endpoints', () => {
  assert.throws(() => new QwenCompactor({ endpoint: 'https://example.com/api',
    healthUrl: 'http://127.0.0.1/health', model: 'm', apiKey: 'k' }), /loopback/);
});
