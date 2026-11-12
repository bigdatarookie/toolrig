import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// This boundary plans native operations only. Executing a transition is refused
// until the running host's native capabilities and full cohort safety are proven.
export function recoveryPlan(operation, now = Date.now()) {
  const { decision, continuation: c } = operation;
  if (!decision.target) throw new Error('no_target');
  const reset = Date.parse(decision.readyAt);
  const delay = Number.isFinite(reset) && reset > now ? Math.ceil((reset - now) / 1000) : null;
  return {
    operationId: operation.id,
    precheck: ['rig', 'provider', 'precheck', '--seat', c.seat, '--to-account', '<resolved permitted authRef>', '--json'],
    wake: delay ? ['rig', 'queue', 'block', c.qitem, '--on', 'external:availability:' + operation.id,
      '--wake-after', delay + 's', '--continuation', 'Re-observe provider quota for operation ' + operation.id + '; verify native account and useful tool turn before closure.'] : null,
    verify: ['rig', 'seat', 'restart', c.seat, '--keep-conversation', '--verify', '--expect-account', '<provider-observed account label>', '--json'],
    action: delay ? 'native_wake_plan' : 'fresh_observation_and_precheck_required',
    constraints: ['No elapsed reset implies recovery', 'Do not retry unknown-effect transitions',
      'Resolve all live shared-home consumers before auth change', 'No automatic restart of active neighbors'],
  };
}

export async function precheck(seat, authRef) {
  const { stdout } = await exec('rig', ['provider', 'precheck', '--seat', seat, '--to-account', authRef, '--json'],
    { timeout: 35000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

const runJson = async args => JSON.parse((await exec('rig', args, { timeout: 35000, maxBuffer: 1024 * 1024 })).stdout);

// Native queue owns the durable timer and work. Reconcile a lost response before
// retrying; never mint another task, timer loop or synthetic completion.
export async function armWake(store, home, seat, { run = runJson, now = Date.now() } = {}) {
  const op = store.pending(home);
  if (!op || op.continuation.seat !== seat) throw new Error('wake_owner_mismatch');
  const q = await run(['queue', 'show', op.continuation.qitem, '--full', '--json']);
  if (q.destinationSession !== seat) throw new Error('wake_owner_mismatch');
  const gate = 'external:availability:' + op.id;
  if (q.state === 'blocked' && q.blockedOn === gate) {
    // The native queue's park receipt owns liveness; a time passing is not proof
    // of recovery and this operation remains pending until verification.
    store.markWake(op.id, 'armed');
    return { operationId: op.id, wake: 'already_parked', qitem: op.continuation.qitem };
  }
  if (op.wake) throw new Error('wake_effect_unknown_reconcile_native_queue');
  if (!['pending', 'in-progress'].includes(q.state)) throw new Error('native_qitem_not_actionable');
  const plan = recoveryPlan(op, now);
  if (!plan.wake) throw new Error('fresh_observation_required');
  if (!store.claimWake(op.id)) throw new Error('wake_effect_unknown_reconcile_native_queue');
  try {
    const result = await run([...plan.wake.slice(1), '--json']);
    // CLI can return JSON errors even with a successful exit status.
    if (result.error) throw new Error('native_park_failed');
    store.markWake(op.id, 'armed');
    return { operationId: op.id, wake: 'armed', qitem: op.continuation.qitem };
  } catch {
    store.markWake(op.id, 'unknown');
    throw new Error('wake_effect_unknown_reconcile_native_queue');
  }
}
