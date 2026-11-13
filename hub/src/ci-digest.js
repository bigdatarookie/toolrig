import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

const API_VERSION = '2022-11-28';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_FINDINGS = 8;
const MAX_EXCERPT_CHARS = 800;
const CACHE_VERSION = 1;

function repoParts(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('repository must be owner/name');
  }
  return repository.split('/');
}

function redact(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[PRIVATE_KEY_REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[TOKEN_REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .slice(0, MAX_EXCERPT_CHARS);
}

function errorType(message) {
  if (/AssertionError|assertion failed/i.test(message)) return 'ASSERTION_FAILURE';
  if (/\bFAILED\s+[^\n]+::|\bnot ok\s+\d+\b|test failed/i.test(message)) return 'TEST_FAILURE';
  if (/ModuleNotFoundError|Cannot find module|module not found/i.test(message)) return 'MISSING_MODULE';
  if (/\bTypeError\b/i.test(message)) return 'TYPE_ERROR';
  if (/\bReferenceError\b/i.test(message)) return 'REFERENCE_ERROR';
  if (/\bSyntaxError\b/i.test(message)) return 'SYNTAX_ERROR';
  if (/\b(?:TS\d{3,5}|error\[[A-Z]\d+\])/i.test(message)) return 'COMPILER_ERROR';
  if (/\bnpm ERR!/i.test(message)) return 'PACKAGE_MANAGER_ERROR';
  return 'UNKNOWN';
}

function classifyApiError(status, message, headers = {}) {
  const lower = String(message ?? '').toLowerCase();
  if (status === 401) return { code: 'authentication_required', status };
  if (status === 403 && (headers.get?.('x-ratelimit-remaining') === '0' || /rate limit/.test(lower))) {
    return { code: 'rate_limited', status };
  }
  if (status === 403) return { code: 'permission_denied', status };
  if (status === 404) return { code: 'not_found', status };
  if (status === 429) return { code: 'rate_limited', status };
  return { code: 'github_api_error', status };
}

async function readBounded(response, limit) {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    const kept = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    chunks.push(Buffer.from(kept));
    total += kept.byteLength;
    if (kept.byteLength < value.byteLength) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

function statusKind(status, conclusion) {
  if (status === 'queued' || status === 'waiting' || status === 'requested' || status === 'pending') return 'queued';
  if (status === 'in_progress') return 'running';
  if (conclusion === 'cancelled' || conclusion === 'timed_out' && status === 'completed') return conclusion === 'cancelled' ? 'canceled' : 'failure';
  if (conclusion === 'skipped' || conclusion === 'neutral') return 'skipped';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') return 'failure';
  if (conclusion === 'success') return 'success';
  if (status === 'completed' && !conclusion) return 'unknown';
  return 'unknown';
}

function apiBase(value) {
  const url = new URL(value ?? 'https://api.github.com');
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) throw new Error('GitHub API URL must use HTTPS');
  return url.href.replace(/\/$/, '');
}

class GitHubRest {
  constructor({ baseUrl, token, fetchImpl }) {
    this.baseUrl = apiBase(baseUrl);
    this.token = token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  async get(path, { accept = 'application/vnd.github+json', limit = MAX_JSON_BYTES, textResponse = false } = {}) {
    let response;
    try {
      const headers = { accept, 'x-github-api-version': API_VERSION };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET', headers, signal: AbortSignal.timeout(20_000), redirect: 'follow',
      });
    } catch (error) {
      return { ok: false, responseBytes: 0, error: { code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'request_timeout' : 'network_error' } };
    }
    const { bytes, truncated } = await readBounded(response, limit);
    if (!response.ok) {
      let body = {};
      try { body = JSON.parse(bytes.toString('utf8')); } catch { /* Keep API error body out of the result. */ }
      const classified = classifyApiError(response.status, body.message, response.headers);
      return { ok: false, responseBytes: bytes.byteLength, error: { ...classified, message: classified.code === 'permission_denied'
        ? 'GitHub denied access to this resource.' : classified.code === 'rate_limited'
          ? 'GitHub API rate limit is exhausted.' : classified.code === 'authentication_required'
            ? 'GitHub authentication is required for this resource.' : classified.code === 'not_found'
              ? 'The requested GitHub resource was not found or is not visible.' : 'GitHub request failed.' } };
    }
    if (truncated) return { ok: false, responseBytes: bytes.byteLength, error: { code: 'response_too_large', status: response.status, message: 'GitHub JSON exceeded the configured response limit.' } };
    if (textResponse) return { ok: true, data: bytes.toString('utf8'), bytes: bytes.byteLength,
      responseBytes: bytes.byteLength, contentLength: Number(response.headers.get('content-length')) || null, truncated };
    try { return { ok: true, data: JSON.parse(bytes.toString('utf8')), bytes: bytes.byteLength, responseBytes: bytes.byteLength }; }
    catch { return { ok: false, responseBytes: bytes.byteLength, error: { code: 'invalid_github_json', status: response.status, message: 'GitHub returned invalid JSON.' } }; }
  }
}

function makeFinding(message, sourceRef, sourceKind = 'annotation') {
  const safeMessage = redact(message).trim();
  return {
    errorType: errorType(safeMessage),
    message: safeMessage,
    occurrenceCount: 1,
    sourceRefs: sourceRef ? [sourceRef] : [],
    sourceKind,
  };
}

function groupFindings(findings) {
  const grouped = new Map();
  for (const finding of findings) {
    const key = `${finding.errorType}\n${finding.message}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrenceCount += 1;
      if (finding.sourceRefs[0] && existing.sourceRefs.length < 5) existing.sourceRefs.push(finding.sourceRefs[0]);
      if (existing.sourceKind !== finding.sourceKind) existing.sourceKind = 'mixed';
    } else grouped.set(key, { ...finding, sourceRefs: [...finding.sourceRefs] });
  }
  return [...grouped.values()].slice(0, MAX_FINDINGS);
}

function logFindings(text, { url, truncated }) {
  const clean = String(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = clean.split(/\r?\n/);
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = redact(lines[index]).trim();
    if (!line || !/(error|failed|failure|exception|traceback|fatal|assertion|not ok\s+\d+|npm ERR!|exit code [1-9])/i.test(line)) continue;
    const sourceRef = { url, ...(truncated ? {} : { line: index + 1 }) };
    candidates.push(makeFinding(line, sourceRef, 'job_log'));
  }
  return { findings: groupFindings(candidates), capturedLines: lines.length };
}

function classifyAnnotation(annotation, jobUrl) {
  const message = [annotation.title, annotation.message, annotation.raw_details].filter(Boolean).join('\n');
  return makeFinding(message || 'GitHub reported a check annotation without details.', {
    url: jobUrl,
    ...(annotation.path ? { path: redact(annotation.path) } : {}),
    ...(Number.isInteger(annotation.start_line) ? { startLine: annotation.start_line } : {}),
    ...(Number.isInteger(annotation.end_line) ? { endLine: annotation.end_line } : {}),
    annotationLevel: annotation.annotation_level ?? 'unknown',
  }, 'check_annotation');
}

function cacheIdentity(repo, run, attempt, job) {
  const stable = [repo, run.id, attempt, run.head_sha, job.id, job.check_run_url, job.completed_at].join('\n');
  return createHash('sha256').update(stable).digest('hex');
}

function defaultCacheDir() {
  return process.env.TOOLRIG_CI_CACHE_DIR || join(homedir() || tmpdir(), '.cache', 'toolrig', 'ci-digest');
}

async function readCache(cacheDir, key) {
  try {
    const value = JSON.parse(await readFile(join(cacheDir, `${key}.json`), 'utf8'));
    if (value.version === CACHE_VERSION && value.key === key && Array.isArray(value.findings)) return value;
  } catch { /* Cache is best effort; fetch current data if absent or malformed. */ }
  return null;
}

async function writeCache(cacheDir, value) {
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(join(cacheDir, `${value.key}.json`), JSON.stringify(value), { mode: 0o600 });
  } catch { /* Cache failure does not change the digest outcome. */ }
}

function boundedString(value, max = 300) { return redact(value).slice(0, max); }

export class CiDigestService {
  constructor({ baseUrl, token, fetchImpl, cacheDir = defaultCacheDir(), maxLogBytes = MAX_LOG_BYTES } = {}) {
    this.api = new GitHubRest({ baseUrl, token, fetchImpl });
    this.cacheDir = cacheDir;
    this.maxLogBytes = maxLogBytes;
  }

  async digest({ repository, run_id: runId, attempt: requestedAttempt, job_id: jobId, pull_request: pullRequest } = {}) {
    const started = Date.now();
    let apiCalls = 0;
    let apiResponseBytes = 0;
    const get = async (...args) => {
      apiCalls += 1;
      const response = await this.api.get(...args);
      apiResponseBytes += response.responseBytes ?? 0;
      return response;
    };
    let owner; let repoName;
    try {
      [owner, repoName] = repoParts(repository);
      if (!Number.isSafeInteger(Number(runId)) || Number(runId) < 1) throw new Error('run_id must be a positive integer');
      if (requestedAttempt !== undefined && (!Number.isSafeInteger(Number(requestedAttempt)) || Number(requestedAttempt) < 1)) throw new Error('attempt must be a positive integer');
      if (jobId !== undefined && (!Number.isSafeInteger(Number(jobId)) || Number(jobId) < 1)) throw new Error('job_id must be a positive integer');
      if (pullRequest !== undefined && (!Number.isSafeInteger(Number(pullRequest)) || Number(pullRequest) < 1)) throw new Error('pull_request must be a positive integer');
    } catch (error) {
      return this.#finish({ kind: 'ci_digest', status: 'invalid_input', error: { code: 'invalid_input', message: error.message }, metrics: {} }, started, apiCalls, apiResponseBytes);
    }
    const repo = `${owner}/${repoName}`;
    const escapedRepo = `${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
    const runResponse = await get(`/repos/${escapedRepo}/actions/runs/${encodeURIComponent(String(runId))}`);
    if (!runResponse.ok) return this.#finish({ kind: 'ci_digest', status: 'api_error', repository: repo,
      identity: { runId: Number(runId), attempt: Number(requestedAttempt) || null }, error: runResponse.error, metrics: {} }, started, apiCalls, apiResponseBytes);
    const run = runResponse.data;
    const latestAttempt = Number(run.run_attempt) || 1;
    const attempt = Number(requestedAttempt ?? latestAttempt);
    if (attempt > latestAttempt) return this.#finish({ kind: 'ci_digest', status: 'invalid_attempt', repository: repo,
      identity: { runId: run.id, attempt, latestAttempt, headSha: run.head_sha, sourceUrl: run.html_url },
      error: { code: 'attempt_not_found', message: 'Requested attempt is newer than the current run attempt.' }, metrics: {} }, started, apiCalls, apiResponseBytes);

    let pr = null;
    let staleHead = false;
    let pullRequestMatch = null;
    let partial = false;
    const apiErrors = [];
    if (pullRequest !== undefined) {
      const response = await get(`/repos/${escapedRepo}/pulls/${encodeURIComponent(String(pullRequest))}`);
      if (!response.ok) { apiErrors.push({ scope: 'pull_request', ...response.error }); partial = true; }
      else {
        const currentHeadSha = response.data.head?.sha ?? null;
        pullRequestMatch = Array.isArray(run.pull_requests) && run.pull_requests.some(item => Number(item.number) === Number(pullRequest));
        staleHead = Boolean(currentHeadSha && currentHeadSha !== run.head_sha);
        pr = { number: Number(pullRequest), currentHeadSha, runHeadSha: run.head_sha,
          associatedWithRun: pullRequestMatch, staleHead };
      }
    } else if (Array.isArray(run.pull_requests) && run.pull_requests.length) {
      pr = run.pull_requests.slice(0, 10).map(item => ({ number: item.number, url: item.url }));
    }

    const jobsPath = `/repos/${escapedRepo}/actions/runs/${encodeURIComponent(String(run.id))}/attempts/${attempt}/jobs?per_page=100`;
    const jobsResponse = await get(jobsPath);
    if (!jobsResponse.ok) return this.#finish({ kind: 'ci_digest', status: 'partial', repository: repo,
      identity: { runId: run.id, attempt, latestAttempt, staleAttempt: attempt < latestAttempt, headSha: run.head_sha,
        pullRequest: pr, sourceUrl: run.html_url }, runStatus: statusKind(run.status, run.conclusion),
      apiErrors: [...apiErrors, { scope: 'jobs', ...jobsResponse.error }], jobs: [], partial: true, metrics: {} }, started, apiCalls, apiResponseBytes);

    let jobs = Array.isArray(jobsResponse.data?.jobs) ? jobsResponse.data.jobs : [];
    if (!Array.isArray(jobsResponse.data?.jobs)) partial = true;
    if (jobId !== undefined) jobs = jobs.filter(job => Number(job.id) === Number(jobId));
    if (jobId !== undefined && jobs.length === 0) {
      return this.#finish({ kind: 'ci_digest', status: 'partial', repository: repo,
        identity: { runId: run.id, attempt, latestAttempt, staleAttempt: attempt < latestAttempt, headSha: run.head_sha,
          pullRequest: pr, sourceUrl: run.html_url }, runStatus: statusKind(run.status, run.conclusion),
        apiErrors: [...apiErrors, { scope: 'job_selection', code: 'job_not_in_attempt', message: 'Selected job does not belong to this run attempt.' }],
        jobs: [], partial: true, metrics: {} }, started, apiCalls, apiResponseBytes);
    }

    const outputJobs = [];
    for (const job of jobs) {
      const jobStatus = statusKind(job.status, job.conclusion);
      const failedSteps = (job.steps ?? []).filter(step => step.conclusion === 'failure').map(step => ({
        name: boundedString(step.name), number: step.number, status: step.status,
        sourceRef: { url: job.html_url, ...(Number.isInteger(step.number) ? { step: step.number } : {}) },
      }));
      const summaryJob = { id: job.id, name: boundedString(job.name), status: job.status ?? 'unknown',
        conclusion: job.conclusion ?? null, kind: jobStatus, url: job.html_url ?? run.html_url,
        ...(failedSteps.length ? { failedSteps } : {}) };
      if (jobStatus !== 'failure') { outputJobs.push(summaryJob); continue; }

      const key = cacheIdentity(repo, run, attempt, job);
      const isFinal = run.status === 'completed' && job.status === 'completed';
      if (isFinal) {
        const cached = await readCache(this.cacheDir, key);
        if (cached) {
          summaryJob.findings = cached.findings;
          summaryJob.logStatus = cached.logStatus;
          summaryJob.annotationStatus = cached.annotationStatus;
          summaryJob.cache = 'hit';
          outputJobs.push(summaryJob);
          continue;
        }
      }

      const annotationsUrl = typeof job.check_run_url === 'string' ? job.check_run_url : null;
      const match = annotationsUrl?.match(/\/check-runs\/(\d+)$/);
      let annotations = [];
      let annotationStatus = 'unavailable';
      if (match) {
        const annotationsResponse = await get(`/repos/${escapedRepo}/check-runs/${match[1]}/annotations?per_page=100`);
        if (annotationsResponse.ok && Array.isArray(annotationsResponse.data)) {
          annotations = annotationsResponse.data.filter(item => item.annotation_level === 'failure').slice(0, 20);
          annotationStatus = 'available';
        } else {
          const error = annotationsResponse.error ?? { code: 'invalid_annotations', message: 'Check annotations were unavailable.' };
          annotationStatus = error.code;
          apiErrors.push({ scope: 'annotations', jobId: job.id, ...error });
          partial = true;
        }
      }
      const findings = annotations.map(annotation => classifyAnnotation(annotation, summaryJob.url));
      const hasSpecificAnnotation = findings.some(finding => finding.errorType !== 'UNKNOWN');
      let logStatus = 'not_needed';
      if (!hasSpecificAnnotation) {
        const logResponse = await get(`/repos/${escapedRepo}/actions/jobs/${encodeURIComponent(String(job.id))}/logs`,
          { limit: this.maxLogBytes, textResponse: true });
        if (logResponse.ok) {
          const parsed = logFindings(logResponse.data, { url: summaryJob.url, truncated: logResponse.truncated });
          findings.push(...parsed.findings);
          logStatus = logResponse.truncated ? 'truncated' : parsed.findings.length ? 'available' : 'available_no_excerpt';
        } else {
          logStatus = logResponse.error.code;
          apiErrors.push({ scope: 'job_logs', jobId: job.id, ...logResponse.error });
          partial = true;
        }
      }
      if (!findings.length) findings.push(makeFinding(`Job ${job.name} failed; detailed logs or structured diagnostics were unavailable.`,
        { url: summaryJob.url }, 'job_status'));
      summaryJob.findings = groupFindings(findings);
      summaryJob.logStatus = logStatus;
      summaryJob.annotationStatus = annotationStatus;
      summaryJob.cache = 'miss';
      if (isFinal && logStatus === 'available' && logStatus !== 'permission_denied') {
        await writeCache(this.cacheDir, { version: CACHE_VERSION, key, findings: summaryJob.findings, logStatus, annotationStatus });
      }
      outputJobs.push(summaryJob);
    }

    const result = {
      kind: 'ci_digest',
      status: staleHead || pullRequestMatch === false || attempt < latestAttempt ? 'stale' : statusKind(run.status, run.conclusion),
      repository: repo,
      identity: { runId: run.id, attempt, latestAttempt, staleAttempt: attempt < latestAttempt, headSha: run.head_sha,
        event: run.event ?? null, branch: run.head_branch ?? null, pullRequest: pr, sourceUrl: run.html_url },
      run: { status: run.status ?? 'unknown', conclusion: run.conclusion ?? null, name: boundedString(run.name ?? run.workflow_name ?? 'workflow'),
        createdAt: run.created_at ?? null, updatedAt: run.updated_at ?? null },
      jobs: outputJobs,
      partial: partial || staleHead || pullRequestMatch === false,
      ...(apiErrors.length ? { apiErrors } : {}),
      coverage: { runMetadata: true, attemptJobs: true, failedStepNames: true,
        structuredAnnotations: outputJobs.some(job => job.annotationStatus === 'available'),
        failedJobLogs: outputJobs.some(job => ['available', 'available_no_excerpt', 'truncated'].includes(job.logStatus)) },
      metrics: {},
    };
    return this.#finish(result, started, apiCalls, apiResponseBytes);
  }

  #finish(result, started, apiCalls, apiResponseBytes) {
    result.metrics ??= {};
    result.metrics.apiCalls = apiCalls;
    result.metrics.apiResponseBytes = apiResponseBytes;
    result.metrics.cacheHits = result.jobs?.filter(job => job.cache === 'hit').length ?? 0;
    result.metrics.elapsedMs = Date.now() - started;
    let guess = 0;
    for (let i = 0; i < 8; i += 1) {
      result.metrics.responseBytes = guess;
      result.metrics.tokenEstimate = { value: Math.ceil(guess / 4), method: 'UTF-8 response bytes divided by 4; rough estimate, not billing usage' };
      const actual = Buffer.byteLength(JSON.stringify(result));
      if (actual === guess) break;
      guess = actual;
    }
    result.metrics.responseBytes = guess;
    result.metrics.tokenEstimate.value = Math.ceil(guess / 4);
    return result;
  }
}

export function createCiDigestService(options = {}) { return new CiDigestService(options); }
