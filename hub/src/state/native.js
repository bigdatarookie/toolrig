import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const sourceCommands = {
  identity: ['whoami', '--json'], version: ['--version'],
  seats: rig => ['ps', '--nodes', '--rig', rig, '--no-cleanup', '--json', '--fields',
    'logicalId,canonicalSessionName,agentActivity,lifecycleState,sessionStatus,intentionallyStopped'],
  queue: ['queue', 'list', '--all', '--limit', '1000', '--json'],
};
export async function runRig(args) {
  const { stdout } = await execute('rig', args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}
export async function readSource(name, args, run, clock) {
  const startedAt = new Date(clock()).toISOString(), start = performance.now();
  try {
    const raw = await run(args);
    const value = name === 'version' ? raw.trim() : JSON.parse(raw);
    return { value, receipt: { name, command: ['rig', ...args], startedAt, observedAt: new Date(clock()).toISOString(),
      elapsedMs: Math.round(performance.now() - start), bytes: Buffer.byteLength(raw), ok: true } };
  } catch {
    // No raw stderr/provider payloads or command execution from source content.
    return { receipt: { name, command: ['rig', ...args], startedAt, observedAt: new Date(clock()).toISOString(),
      elapsedMs: Math.round(performance.now() - start), ok: false, error: 'source_unavailable_or_invalid_json' } };
  }
}
