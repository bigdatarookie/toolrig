import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CiDigestService } from '../src/ci-digest.js';

const repository = 'owner/project';
const runId = 100;
const headSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fixtureFetch({ run = {}, jobs = [], annotations = [], log = '', logStatus = 200, pull = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, query: parsed.search, accept: options.headers.accept });
    if (parsed.pathname.endsWith(`/actions/runs/${runId}`)) return json({
      id: runId, run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: headSha,
      head_branch: 'topic', event: 'pull_request', html_url: 'https://github.com/owner/project/actions/runs/100',
      created_at: '2026-11-12T12:00:00Z', updated_at: '2026-11-12T12:01:00Z', pull_requests: [], ...run,
    });
    if (parsed.pathname.endsWith(`/actions/runs/${runId}/attempts/${parsed.pathname.split('/').at(-2)}/jobs`)
      || parsed.pathname.includes(`/actions/runs/${runId}/attempts/`) && parsed.pathname.endsWith('/jobs')) {
      return json({ total_count: jobs.length, jobs });
    }
    if (parsed.pathname.endsWith(`/pulls/9`)) return pull ? json(pull) : json({ message: 'not found' }, 404);
    if (/\/check-runs\/\d+\/annotations$/.test(parsed.pathname)) return json(annotations);
    if (parsed.pathname.endsWith('/actions/jobs/202/logs')) {
      if (logStatus !== 200) return json({ message: 'must have admin rights to repository' }, logStatus);
      return new Response(log, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return json({ message: 'unexpected fixture request' }, 500);
  };
  return { fetchImpl, calls };
}

function failedJob(overrides = {}) {
  return {
    id: 202, name: 'macos tests', status: 'completed', conclusion: 'failure',
    completed_at: '2026-11-12T12:01:00Z', html_url: 'https://github.com/owner/project/actions/runs/100/job/202',
    check_run_url: 'https://api.github.com/repos/owner/project/check-runs/202',
    steps: [
      { name: 'Install', number: 1, status: 'completed', conclusion: 'success' },
      { name: 'Run tests', number: 2, status: 'completed', conclusion: 'failure' },
    ],
    ...overrides,
  };
}

function genericAnnotation() {
  return [{ annotation_level: 'failure', path: '.github/workflows/test.yml', start_line: 12, end_line: 12,
    title: '', message: 'Process completed with exit code 1.', raw_details: '' }];
}

async function tempCache(t) {
  const dir = await mkdtemp(join(tmpdir(), 'toolrig-ci-digest-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('failed job combines exact annotation and bounded log findings, redacts secrets/PII, groups exact repeats', async t => {
  const cacheDir = await tempCache(t);
  const { fetchImpl, calls } = fixtureFetch({
    jobs: [failedJob()], annotations: genericAnnotation(),
    log: 'Run tests\nAssertionError: token=ghp_123456789012345678901234 and dev@example.invalid\nAssertionError: token=ghp_123456789012345678901234 and dev@example.invalid\n',
  });
  const result = await new CiDigestService({ fetchImpl, cacheDir }).digest({ repository, run_id: runId });
  assert.equal(result.status, 'failure');
  assert.equal(result.identity.runId, runId);
  assert.equal(result.identity.attempt, 1);
  assert.equal(result.identity.headSha, headSha);
  assert.deepEqual(result.jobs[0].failedSteps.map(step => step.name), ['Run tests']);
  assert.equal(result.jobs[0].logStatus, 'available');
  const finding = result.jobs[0].findings.find(item => item.errorType === 'ASSERTION_FAILURE');
  assert.equal(finding.occurrenceCount, 2);
  assert.match(finding.message, /token=\[REDACTED\]/);
  assert.match(finding.message, /\[EMAIL\]/);
  assert.doesNotMatch(JSON.stringify(result), /ghp_123456|dev@example/);
  assert.equal(result.metrics.apiCalls, calls.length);
  assert.ok(result.metrics.apiResponseBytes > 0);
  assert.equal(calls.find(call => call.path.endsWith('/logs')).accept, 'application/vnd.github+json');
  assert.ok(result.metrics.responseBytes > 0);
  assert.ok(result.metrics.tokenEstimate.method.includes('rough estimate'));
});

test('passing, queued, canceled and skipped states stay distinct and do not fetch logs', async t => {
  const { fetchImpl, calls } = fixtureFetch({
    run: { status: 'completed', conclusion: 'success' },
    jobs: [
      failedJob({ id: 301, conclusion: 'success', steps: [] }),
      failedJob({ id: 302, status: 'queued', conclusion: null, steps: [] }),
      failedJob({ id: 303, conclusion: 'cancelled', steps: [] }),
      failedJob({ id: 304, conclusion: 'skipped', steps: [] }),
    ],
  });
  const result = await new CiDigestService({ fetchImpl, cacheDir: await tempCache(t) }).digest({ repository, run_id: runId });
  assert.deepEqual(result.jobs.map(job => job.kind), ['success', 'queued', 'canceled', 'skipped']);
  assert.equal(result.status, 'success');
  assert.equal(calls.some(call => call.path.endsWith('/logs')), false);
});

test('running jobs refresh on every call and are not cached', async t => {
  const cacheDir = await tempCache(t);
  let job = failedJob({ status: 'in_progress', conclusion: null, completed_at: null, steps: [{ name: 'Run tests', number: 2, status: 'in_progress', conclusion: null }] });
  const { fetchImpl, calls } = fixtureFetch({ run: { status: 'in_progress', conclusion: null }, get jobs() { return [job]; } });
  const service = new CiDigestService({ fetchImpl, cacheDir });
  const a = await service.digest({ repository, run_id: runId });
  const n = calls.length;
  const b = await service.digest({ repository, run_id: runId });
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'running');
  assert.equal(b.metrics.apiCalls, 2);
  assert.equal(calls.length, n + 2);
  assert.equal(calls.some(call => call.path.endsWith('/logs')), false);
  job = failedJob();
});

test('older explicit attempt and changed PR head are marked stale, never current success', async t => {
  const cacheDir = await tempCache(t);
  const oldRun = { run_attempt: 2, conclusion: 'success', status: 'completed', pull_requests: [{ number: 9 }] };
  const { fetchImpl } = fixtureFetch({ run: oldRun, jobs: [failedJob({ conclusion: 'success', steps: [] })],
    pull: { number: 9, head: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } } });
  const result = await new CiDigestService({ fetchImpl, cacheDir }).digest({ repository, run_id: runId, attempt: 1, pull_request: 9 });
  assert.equal(result.status, 'stale');
  assert.equal(result.identity.staleAttempt, true);
  assert.equal(result.identity.pullRequest.staleHead, true);
  assert.equal(result.identity.pullRequest.runHeadSha, headSha);
});

test('permission denied logs remain explicit and structured annotation survives', async t => {
  const { fetchImpl } = fixtureFetch({ jobs: [failedJob()], annotations: genericAnnotation(), logStatus: 403 });
  const result = await new CiDigestService({ fetchImpl, cacheDir: await tempCache(t) }).digest({ repository, run_id: runId });
  assert.equal(result.status, 'failure');
  assert.equal(result.partial, true);
  assert.equal(result.jobs[0].logStatus, 'permission_denied');
  assert.equal(result.jobs[0].findings[0].message, 'Process completed with exit code 1.');
  assert.equal(result.apiErrors[0].code, 'permission_denied');
  assert.doesNotMatch(JSON.stringify(result), /admin rights to repository/);
});

test('unknown log formats emit UNKNOWN with expandable job URL, never inferred cause', async t => {
  const { fetchImpl } = fixtureFetch({ jobs: [failedJob()], annotations: [], log: 'ERROR: worker returned an unusual sentinel code XYZ\n' });
  const result = await new CiDigestService({ fetchImpl, cacheDir: await tempCache(t) }).digest({ repository, run_id: runId });
  const finding = result.jobs[0].findings[0];
  assert.equal(finding.errorType, 'UNKNOWN');
  assert.match(finding.sourceRefs[0].url, /actions\/runs\/100\/job\/202/);
  assert.equal(finding.sourceRefs[0].line, 1);
});

test('final sanitized findings cache by exact run/attempt/job identity', async t => {
  const cacheDir = await tempCache(t);
  const { fetchImpl, calls } = fixtureFetch({ jobs: [failedJob()], annotations: genericAnnotation(), log: 'AssertionError: expected true\n' });
  const service = new CiDigestService({ fetchImpl, cacheDir });
  const first = await service.digest({ repository, run_id: runId });
  const firstCalls = calls.length;
  const second = await service.digest({ repository, run_id: runId });
  assert.equal(first.jobs[0].cache, 'miss');
  assert.equal(second.jobs[0].cache, 'hit');
  assert.equal(second.metrics.apiCalls, 2);
  assert.equal(calls.length, firstCalls + 2);
  assert.equal(second.metrics.cacheHits, 1);
});

test('API rate-limit and permission errors are typed instead of empty-success', async t => {
  const fetchImpl = async () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' });
  const result = await new CiDigestService({ fetchImpl, cacheDir: await tempCache(t) }).digest({ repository, run_id: runId });
  assert.equal(result.status, 'api_error');
  assert.equal(result.error.code, 'rate_limited');
  assert.equal(result.jobs, undefined);
});
