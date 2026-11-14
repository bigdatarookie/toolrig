import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { configuredQwenCompactor, countO200kTokens, QwenCompactor } from '../src/qwen-compactor.js';

const sourceText = Array.from({ length: 1800 }, (_, i) => `record${i} value observed`).join('\n');
const refs = [{ source: 'annual-report.pdf', page: 4, paragraph: 2 }];
const goodSummary = JSON.stringify({
  facts: [{ text: 'Reported value is 12.0 USD.', source_ids: ['s1'] }],
  limits: [{ text: 'The excerpt covers one page only.', source_ids: ['s1'] }],
  unknowns: [{ question: 'What was the later value?', source_ids: ['s1'] }],
  source_ids: ['s1'],
});

function compactorWith(complete, limits = { input: 262_144, output: 262_144 }) {
  const calls = [];
  const compactor = new QwenCompactor({
    endpoint: 'http://127.0.0.1:18583/v1/chat/completions',
    healthUrl: 'http://127.0.0.1:18583/__alfarig_health', model: 'configured-local-model', apiKey: 'test-secret',
    maxInputTokens: limits.input, maxOutputTokens: limits.output,
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
  assert.equal(result.model_max_input_tokens, 262_144);
  assert.equal(result.inference_input_tokens_o200k,
    countO200kTokens(JSON.stringify(request.messages)));
});

test('short, ineligible, unlocated, or unknown-budget source stays direct without gateway calls', async () => {
  const { compactor, calls } = compactorWith(goodSummary);
  const base = { question: 'Find the answer.', text: sourceText, sourceRefs: refs,
    consumerWindowTokens: 10_000, consumerTokensUsed: 100, qwenEligible: true };
  const belowThreshold = await compactor.compact({ ...base, text: 'short' });
  assert.equal(belowThreshold.status, 'direct_source');
  assert.equal(belowThreshold.reason, 'below_8000_extracted_o200k_tokens');
  assert.equal(belowThreshold.source_tokens_o200k, countO200kTokens('short'));
  assert.equal(belowThreshold.model_calls, 0);

  for (const input of [
    { ...base, qwenEligible: false },
    { ...base, sourceRefs: [] },
    { ...base, consumerWindowTokens: undefined },
    { ...base, consumerWindowTokens: 0 },
    { ...base, consumerTokensUsed: -1 },
  ]) {
    const result = await compactor.compact(input);
    assert.equal(result.status, 'direct_source');
    assert.equal(result.model_calls, 0);
  }
  assert.deepEqual(calls, []);
});

test('full serialized inference input is checked against the configured model input cap before health or inference', async () => {
  const sourceTokens = countO200kTokens(sourceText);
  const { compactor, calls } = compactorWith(goodSummary, { input: sourceTokens, output: 262_144 });
  const result = await compactor.compact({ question: 'Q?', text: sourceText, sourceRefs: refs,
    consumerWindowTokens: 100_000, consumerTokensUsed: 0, qwenEligible: true });
  assert.equal(result.status, 'direct_source');
  assert.equal(result.reason, 'qwen_input_exceeds_model_limit');
  assert.ok(result.inference_input_tokens_o200k > sourceTokens);
  assert.equal(result.model_max_input_tokens, sourceTokens);
  assert.deepEqual(calls, []);
});

test('unknown or invalid model context caps use direct source without gateway calls', async () => {
  for (const limits of [
    { input: null, output: 262_144 },
    { input: 262_144, output: null },
    { input: 0, output: 262_144 },
    { input: 262_144, output: -1 },
  ]) {
    const { compactor, calls } = compactorWith(goodSummary, limits);
    const result = await compactor.compact({ question: 'Q?', text: sourceText, sourceRefs: refs,
      consumerWindowTokens: 100_000, consumerTokensUsed: 0, qwenEligible: true });
    assert.equal(result.status, 'direct_source');
    assert.equal(result.reason, 'qwen_model_context_unknown');
    assert.deepEqual(calls, []);
  }
});

test('only the metadata-qualified Qwen model receives a configured context cap', async () => {
  const base = { TOOLRIG_QWEN_API_KEY: 'synthetic-secret',
    TOOLRIG_QWEN_API_URL: 'http://127.0.0.1:18583/v1/chat/completions',
    TOOLRIG_QWEN_HEALTH_URL: 'http://127.0.0.1:18583/__alfarig_health' };
  const configured = configuredQwenCompactor({ ...base, TOOLRIG_QWEN_MODEL: 'Qwen3.8-27B' });
  assert.equal(configured.maxInputTokens, 262_144);
  assert.equal(configured.maxOutputTokens, 262_144);
  const unknown = configuredQwenCompactor({ ...base, TOOLRIG_QWEN_MODEL: 'unqualified-alias' }, async () => {
    throw new Error('unknown model must not call the gateway');
  });
  const result = await unknown.compact({ question: 'Q?', text: sourceText, sourceRefs: refs,
    consumerWindowTokens: 100_000, consumerTokensUsed: 0, qwenEligible: true });
  assert.equal(result.reason, 'qwen_model_context_unknown');
});

test('exact complete MCP envelope fit is accepted; actual envelope overflow falls back to direct source', async () => {
  const envelopeFor = result => ({
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  });
  const exactSummary = JSON.stringify({
    facts: Array.from({ length: 12 }, (_, index) => ({
      text: `Synthetic supported fact ${index} preserves a useful detail and its measured unit.`, source_ids: ['s1'],
    })),
    limits: Array.from({ length: 8 }, (_, index) => ({
      text: `Synthetic coverage limit ${index} applies only to this located excerpt.`, source_ids: ['s1'],
    })),
    unknowns: Array.from({ length: 8 }, (_, index) => ({
      question: `Which related source fact ${index} is not included in this excerpt?`, source_ids: ['s1'],
    })),
    source_ids: ['s1'],
  });
  const runAtBudget = async (budget, complete = exactSummary, envelopeBuilder = envelopeFor) => {
    const { compactor } = compactorWith(complete);
    const result = await compactor.compact({ question: 'Q?', text: sourceText, sourceRefs: refs,
      exactFacts: [{ field: 'unit', value: 'USD' }], consumerWindowTokens: budget + 10_000,
      consumerTokensUsed: 9_000, consumerReserveTokens: 1_000, qwenEligible: true,
      buildConsumerEnvelope: envelopeBuilder,
    });
    return result;
  };

  let exactBudget = 10_000;
  let exact;
  for (let i = 0; i < 3; i += 1) {
    exact = await runAtBudget(exactBudget);
    assert.equal(exact.status, 'compacted');
    const measured = countO200kTokens(JSON.stringify(envelopeFor(exact)));
    if (measured === exactBudget) break;
    exactBudget = measured;
  }
  assert.equal(exact.status, 'compacted');
  assert.equal(exact.output_tokens_o200k, exactBudget);
  assert.equal(countO200kTokens(JSON.stringify(envelopeFor(exact))), exactBudget);

  const envelopeOverflow = JSON.stringify({
    facts: [{ text: 'detail '.repeat(1_000), source_ids: ['s1'] }],
    limits: [], unknowns: [], source_ids: ['s1'],
  });
  const overflow = await runAtBudget(exactBudget, envelopeOverflow);
  assert.equal(overflow.status, 'direct_source');
  assert.equal(overflow.reason, 'compactor_result_exceeds_consumer_budget');
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

test('Qwen health and inference requests reject redirects before following them', async t => {
  const forwarded = [];
  const collector = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    forwarded.push({ path: request.url, body });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health-target') response.end(JSON.stringify({ active_requests: 0, waiting_requests: 0 }));
    else response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: goodSummary } }] }));
  });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  const collectorUrl = `http://127.0.0.1:${collector.address().port}`;
  t.after(() => new Promise(resolve => collector.close(resolve)));

  const healthGateway = createServer((request, response) => {
    response.writeHead(307, { location: `${collectorUrl}/health-target` });
    response.end();
  });
  await new Promise(resolve => healthGateway.listen(0, '127.0.0.1', resolve));
  const healthUrl = `http://127.0.0.1:${healthGateway.address().port}/health`;
  t.after(() => new Promise(resolve => healthGateway.close(resolve)));
  const healthResult = await new QwenCompactor({ endpoint: `${collectorUrl}/chat`, healthUrl,
    model: 'configured-local-model', apiKey: 'test-secret', maxInputTokens: 262_144,
    maxOutputTokens: 262_144 }).compact({ question: 'Q?', text: sourceText,
    sourceRefs: refs, consumerWindowTokens: 10_000, consumerTokensUsed: 100, qwenEligible: true });
  assert.equal(healthResult.status, 'direct_source');
  assert.equal(healthResult.reason, 'gateway_health_unavailable');
  assert.deepEqual(forwarded, []);
  await new Promise((resolve, reject) => healthGateway.close(error => error ? reject(error) : resolve()));

  const inferenceGateway = createServer((request, response) => {
    if (request.url === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ active_requests: 0, waiting_requests: 0 }));
      return;
    }
    response.writeHead(307, { location: `${collectorUrl}/inference-target` });
    response.end();
  });
  await new Promise(resolve => inferenceGateway.listen(0, '127.0.0.1', resolve));
  const inferenceBase = `http://127.0.0.1:${inferenceGateway.address().port}`;
  t.after(() => new Promise(resolve => inferenceGateway.close(resolve)));
  const inferenceResult = await new QwenCompactor({ endpoint: `${inferenceBase}/chat`,
    healthUrl: `${inferenceBase}/health`, model: 'configured-local-model', apiKey: 'test-secret',
    maxInputTokens: 262_144, maxOutputTokens: 262_144 }).compact({
    question: 'Q?', text: sourceText, sourceRefs: refs, consumerWindowTokens: 10_000,
    consumerTokensUsed: 100, qwenEligible: true,
  });
  assert.equal(inferenceResult.status, 'direct_source');
  assert.equal(inferenceResult.reason, 'compactor_request_failed');
  assert.deepEqual(forwarded, []);
});
