import { z } from 'zod';
export const schemaVersion = 'toolrig-state/1';
export const states = ['pending', 'in-progress', 'blocked', 'done', 'canceled', 'handed-off', 'failed', 'denied'];
export const active = ['pending', 'in-progress', 'blocked'];
const text = z.string().min(1).max(500);
export const requestSchema = z.strictObject({ rig: text, project: text,
  filter: z.strictObject({ states: z.enum(['all', 'active']), seat: text.optional() }),
  cursor: z.string().max(200).optional() });
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullText = v => typeof v === 'string' ? v : null;
export function tasksFrom(raw, scope) {
  if (!Array.isArray(raw)) throw new Error('queue_schema_invalid');
  const ids = new Set();
  const tasks = raw.map(q => {
    if (!q || typeof q.qitemId !== 'string' || !q.qitemId || ids.has(q.qitemId) || typeof q.destinationSession !== 'string' ||
        !states.includes(q.state) || !Array.isArray(q.tags) || !q.tags.every(t => typeof t === 'string') ||
        !stamp(q.tsCreated) || !stamp(q.tsUpdated)) throw new Error('queue_schema_invalid');
    ids.add(q.qitemId);
    if (['blockedOn', 'handedOffTo', 'handedOffFrom', 'sourceSession', 'summary', 'closureReason', 'closureTarget', 'humanIntent'].some(key => q[key] != null && typeof q[key] !== 'string')) throw new Error('queue_schema_invalid');
    if (Object.hasOwn(q, 'body') || Object.hasOwn(q, 'humanDetail')) throw new Error('queue_not_body_free');
    return q;
  }).filter(q => q.tags.includes('project:' + scope.project) || q.targetRepo === scope.project);
  const owners = new Map(raw.map(q => [q.qitemId, q.destinationSession]));
  return Object.fromEntries(tasks.map(q => [q.qitemId, {
    id: q.qitemId, owner: q.destinationSession, sender: nullText(q.sourceSession), state: q.state,
    parentItem: nullText(q.handedOffFrom), parentCoverage: 'immediate_native_handedOffFrom_only',
    summary: typeof q.summary === 'string' ? q.summary.slice(0, 200) : null,
    summaryTruncated: typeof q.summary === 'string' && q.summary.length > 200,
    updatedAt: q.tsUpdated, createdAt: q.tsCreated,
    blocker: q.blockedOn ? { ref: q.blockedOn, owner: owners.get(q.blockedOn) ?? null,
      since: null, ageSeconds: null, sinceCoverage: 'not_exposed_by_compact_list' } : null,
    handoff: q.handedOffTo ? { to: q.handedOffTo, fromItem: nullText(q.handedOffFrom) } : null,
    closure: q.closureReason ? { reason: q.closureReason, target: nullText(q.closureTarget) } : null,
    // Report only source labels. A tag/decision intent alone does not prove a
    // real human gate; that authority requires the native addressable detail.
    humanGate: q.tags.includes('gate:human') ? 'source_tagged' :
      q.humanIntent === 'decision' ? 'decision_intent; destination_type_unknown' : null,
    source: { command: ['queue', 'show', q.qitemId, '--json'] },
  }]));
}
export function seatsFrom(raw) {
  if (!raw || !Array.isArray(raw.entries) || typeof raw.truncated !== 'boolean' ||
      typeof raw.totalNodes !== 'number') throw new Error('seats_schema_invalid');
  return Object.fromEntries(raw.entries.map(s => {
    if (typeof s.logicalId !== 'string' || typeof s.canonicalSessionName !== 'string' ||
        typeof s.lifecycleState !== 'string' || typeof s.sessionStatus !== 'string') throw new Error('seats_schema_invalid');
    const a = s.agentActivity;
    return [s.canonicalSessionName, { id: s.canonicalSessionName, logicalId: s.logicalId,
      lifecycle: s.lifecycleState, session: s.sessionStatus, stopped: s.intentionallyStopped ?? null,
      activity: a ? { state: nullText(a.state), reason: nullText(a.reason), source: nullText(a.evidenceSource),
        eventAt: nullText(a.eventAt), stale: a.stale ?? null } : null,
      source: { command: ['seat', 'status', s.canonicalSessionName, '--json'] } }];
  }));
}
export function select(all, scope) {
  return { seats: Object.fromEntries(Object.entries(all.seats).filter(([id]) => !scope.filter.seat || id === scope.filter.seat)),
    tasks: Object.fromEntries(Object.entries(all.tasks).filter(([, t]) =>
      (!scope.filter.seat || t.owner === scope.filter.seat) &&
      (scope.filter.states === 'all' || active.includes(t.state)))) };
}
export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
export function delta(before, after) {
  const result = { added: [], changed: [], removed: [] };
  for (const kind of ['seats', 'tasks']) {
    for (const [id, value] of Object.entries(after[kind])) {
      if (!Object.hasOwn(before[kind], id)) result.added.push({ kind, value });
      else {
        const changes = {};
        for (const field of Object.keys(value)) {
          if (canonical(before[kind][id][field]) !== canonical(value[field])) changes[field] = { from: before[kind][id][field], to: value[field] };
        }
        if (Object.keys(changes).length) result.changed.push({ kind, id, fields: changes });
      }
    }
    for (const [id, value] of Object.entries(before[kind])) {
      if (!Object.hasOwn(after[kind], id)) result.removed.push({ kind, id, previousState: value.state ?? value.lifecycle,
        meaning: 'absent_from_selected_projection; deletion_not_established' });
    }
  }
  return result;
}
