#!/usr/bin/env node
import { createCiDigestService } from './ci-digest.js';

const USAGE = 'usage: node src/ci-digest-cli.js digest --repo owner/name --run <run-id> [--attempt <n>] [--job <job-id>] [--pr <number>] [--json]';

function parse(argv) {
  if (argv.shift() !== 'digest') throw new Error(USAGE);
  const result = { command: 'digest', json: false };
  const names = new Map([
    ['--repo', 'repository'], ['--run', 'run_id'], ['--run-id', 'run_id'],
    ['--attempt', 'attempt'], ['--job', 'job_id'], ['--job-id', 'job_id'], ['--pr', 'pull_request'],
  ]);
  while (argv.length) {
    const flag = argv.shift();
    if (flag === '--json') { result.json = true; continue; }
    const key = names.get(flag);
    if (!key) throw new Error(USAGE);
    const value = argv.shift();
    if (!value || value.startsWith('--')) throw new Error(USAGE);
    result[key] = ['attempt', 'job_id', 'pull_request', 'run_id'].includes(key) ? Number(value) : value;
  }
  if (!result.repository || !result.run_id) throw new Error(USAGE);
  return result;
}

function textReport(result) {
  const identity = result.identity ?? {};
  const lines = [`CI digest: ${result.repository ?? 'unknown'} run ${identity.runId ?? '?'} attempt ${identity.attempt ?? '?'}`,
    `Status: ${result.status}${identity.staleAttempt ? ' (stale attempt)' : ''}${result.partial ? ' (partial)' : ''}`];
  if (identity.headSha) lines.push(`Head: ${identity.headSha}`);
  if (identity.pullRequest?.number) lines.push(`PR #${identity.pullRequest.number}: current head ${identity.pullRequest.currentHeadSha ?? 'unknown'}; run head ${identity.pullRequest.runHeadSha ?? 'unknown'}`);
  if (result.error) lines.push(`Error: ${result.error.code} — ${result.error.message}`);
  for (const job of result.jobs ?? []) {
    const failedStepText = job.failedSteps?.map(step => step.name).join(', ');
    lines.push(`- ${job.name}: ${job.kind}${failedStepText ? `; failed step: ${failedStepText}` : ''}`);
    for (const finding of job.findings ?? []) {
      const count = finding.occurrenceCount > 1 ? ` (×${finding.occurrenceCount})` : '';
      lines.push(`  ${finding.errorType}${count}: ${finding.message}`);
      for (const ref of finding.sourceRefs ?? []) {
        const location = ref.path ? `${ref.path}${ref.startLine ? `:${ref.startLine}` : ''}` : ref.line ? `log line ${ref.line}` : 'job details';
        lines.push(`  Source: ${location} — ${ref.url}`);
      }
    }
    if (job.logStatus && job.logStatus !== 'not_needed') lines.push(`  Logs: ${job.logStatus}; expand: ${job.url}`);
  }
  if (result.apiErrors?.length) for (const error of result.apiErrors) lines.push(`API ${error.scope}: ${error.code} — ${error.message}`);
  if (result.identity?.sourceUrl) lines.push(`Run: ${result.identity.sourceUrl}`);
  lines.push(`Metrics: ${result.metrics?.apiCalls ?? 0} API calls; ${result.metrics?.elapsedMs ?? 0} ms; ${result.metrics?.responseBytes ?? 0} JSON bytes; ${result.metrics?.tokenEstimate?.value ?? 0} token estimate (bytes ÷ 4).`);
  return lines.join('\n');
}

try {
  const options = parse(process.argv.slice(2));
  const result = await createCiDigestService({ baseUrl: process.env.TOOLRIG_GITHUB_API_URL }).digest(options);
  process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${textReport(result)}\n`);
  if (['api_error', 'invalid_input', 'invalid_attempt'].includes(result.status)) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error.message === USAGE ? USAGE : 'CI digest failed: invalid invocation'}\n`);
  process.exitCode = 2;
}
