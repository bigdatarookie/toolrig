// Actual Support caller: retain one sourced migration checkpoint in its owned native task.
// Reuses Toolrig receipt/reconciliation; never retries a mutation after an unknown effect.
import { NativeQueue } from '/Users/garry/Documents/git/toolrig-package-d-install/hub/src/d/native-queue.js';
import { compactReceipt, writeThenReconcile } from '/Users/garry/Documents/git/toolrig-package-d-install/hub/src/d/receipts.js';
const qitem = 'qitem-20261114103815-035214349665d0fe';
const operationId = 'catalog-callers-035214-checkpoint-20261114';
const queue = new NativeQueue();
const before = await queue.read(qitem);
const actor = await queue.identity();
if (before.destinationSession !== actor.sessionName) throw new Error('caller_task_owner_mismatch');
const marker = { operationId, phase: 'caller_migration_checkpoint',
  decision: 'Lead says no forced count;taskTrace consumed clarification transition34774;OpenTourDevOps no-fit;State owner-ID repair awaits accepted pin. Native remains valid.',
  sourceRefs: ['native:qitem-20261114103815-035214349665d0fe:transition:34774',
    'platform-devops@opentour-rig:2026-11-14T10:50Z',
    'qitem-20261114103815-f542375eea5bb754'] };
const note = 'toolrig-d/1 ' + JSON.stringify(marker);
let additionalNoteWritten = false;
let alreadyRecorded = false;
const started = performance.now();
const result = await writeThenReconcile(operationId, async () => {
  const journal = await queue.journal(qitem);
  // A repeat of this caller reconciles its same checkpoint instead of appending it again.
  if (journal.some(row => row.transitionNote === note)) { alreadyRecorded = true; return before; }
  if (before.state !== 'in-progress') throw new Error('caller_task_not_in_progress');
  additionalNoteWritten = true;
  return queue.note(qitem, marker);
}, async () => {
  const journal = await queue.journal(qitem);
  if (!journal.some(row => row.transitionNote === note)) return { operationId, outcome: 'unknown' };
  return queue.read(qitem);
});
const receipt = compactReceipt(operationId, result, { outcome: 'checkpoint_recorded', before });
console.log(JSON.stringify({ ...receipt, elapsedMs: performance.now() - started,
  modelUsage: 'UNKNOWN', additionalNoteWritten, alreadyRecorded, mutationReplay: false }));
if (receipt.outcome === 'unknown') process.exitCode = 2;
