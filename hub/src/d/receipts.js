// Receipts are projections of native results, never an alternate work ledger.
export const refFor = id => ({ command: ['rig', 'queue', 'show', id, '--json'] });
export function compactReceipt(operationId, q, { outcome = 'observed', before, fields = ['state','destinationSession','blockedOn','handedOffTo'] } = {}) {
  if (!q?.qitemId || !q.destinationSession || !q.state) return { operationId, outcome: 'unknown', source: q?.qitemId ? refFor(q.qitemId) : null };
  const changed = {};
  if (before) for (const field of fields) if (JSON.stringify(before[field]) !== JSON.stringify(q[field])) changed[field] = { from: before[field] ?? null, to: q[field] ?? null };
  return { operationId, outcome, qitemId: q.qitemId, owner: q.destinationSession, state: q.state,
    changed, source: refFor(q.qitemId) };
}
export async function writeThenReconcile(operationId, write, reconcile) {
  try { return await write(); }
  catch {
    // Exactly one read/reconciliation attempt, never re-execute the mutation.
    try { return await reconcile(operationId); }
    catch { return { operationId, outcome: 'unknown', action: 'reconcile_same_operation; do_not_replay' }; }
  }
}
