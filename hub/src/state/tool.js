import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CursorCache } from './cache.js';
import { sourceCommands, readSource, runRig } from './native.js';
import { requestSchema, schemaVersion, queueErrorCodes, tasksFrom, seatsFrom, select, canonical, delta } from './projection.js';
export class StateTool {
  constructor({ run = runRig, clock = Date.now, cache = new CursorCache(process.env.TOOLRIG_STATE_CACHE_DIR ?? join(homedir(), '.cache/toolrig/state-v1')) } = {}) {
    Object.assign(this, { run, clock, cache });
  }
  async snapshot(input) {
    const parsed=requestSchema.parse(input);
    const request={...parsed,filter:{...parsed.filter,
      ...(parsed.filter.owners?{owners:[...parsed.filter.owners].sort()}:{}),...(parsed.filter.ids?{ids:[...parsed.filter.ids].sort()}:{})}};
    const {cursor,...scope}=request;
    const start = performance.now();
    const identity = await readSource('identity', sourceCommands.identity, this.run, this.clock);
    const i = identity.value?.identity;
    if (!identity.receipt.ok || !i?.rigName || !i?.sessionName) throw new Error('native_consumer_identity_unavailable');
    // Default list is current-rig. Explicit destinations use the native CLI
    // owner scope, including named other-rig owners; never impersonate identity
    // or request an all-rigs dump. Seat/project mode retains its old boundary.
    if (i.rigName !== scope.rig || (scope.filter.seat && !scope.filter.seat.endsWith('@' + scope.rig))) throw new Error('scope_not_supported_for_native_consumer');
    const results = await Promise.all([
      readSource('version', sourceCommands.version, this.run, this.clock),
      readSource('seats', sourceCommands.seats(scope.rig), this.run, this.clock),
      ...(scope.filter.owners
        ?scope.filter.owners.map(owner=>readSource('queue_owner:'+owner,[...sourceCommands.queue,'--destination',owner],this.run,this.clock))
        :[readSource('queue',[...sourceCommands.queue,...(scope.filter.seat?['--destination',scope.filter.seat]:[])],this.run,this.clock)]),
    ]);
    const [version, seats, ...queues] = results, sources = [identity, ...results].map(r => r.receipt);
    const errors = sources.filter(s => !s.ok).map(s => s.name + ':' + s.error);
    const all = { seats: {}, tasks: {} };
    try { if (seats.receipt.ok) all.seats = seatsFrom(seats.value); } catch { errors.push('seats:schema_invalid'); }
    const rows=[];
    for(const [index,queue] of queues.entries()) {
      if(!queue.receipt.ok)continue;
      if(!Array.isArray(queue.value)){errors.push('queue:queue_not_array');continue;}
      if(scope.filter.owners&&queue.value.some(q=>q?.destinationSession!==scope.filter.owners[index])){errors.push('queue:explicit_owner_filter_not_respected');continue;}
      rows.push(...queue.value);
      if(queue.value.length>=1000)errors.push(queue.receipt.name+':limit_reached; history_coverage_unknown');
    }
    try { all.tasks = tasksFrom(rows, scope); } catch (error) { errors.push('queue:' + (queueErrorCodes.has(error.message) ? error.message : 'schema_invalid_or_not_body_free')); }
    const missingIds=scope.filter.ids?.filter(id=>!Object.hasOwn(all.tasks,id));
    if(missingIds?.length)errors.push('queue:requested_ids_not_observed');
    if (seats.value?.truncated || seats.value?.entries?.length < seats.value?.totalNodes) errors.push('seats:truncated');
    if (typeof version.value !== 'string' || !/^\d+\.\d+\.\d+/.test(version.value)) errors.push('version:unknown');
    const selected = select(all, scope);
    const staleActivity = Object.values(selected.seats).filter(s => !s.activity || s.activity.stale === true || !s.activity.state || s.activity.state === 'unknown').map(s => s.id);
    const binding = createHash('sha256').update(canonical({ consumer: i.sessionName, scope, schemaVersion, nativeVersion: version.value })).digest('hex');
    const hasCursor = cursor !== undefined;
    const previous = hasCursor ? this.cache.read(cursor, i.sessionName, binding) : {};
    const coverage = { status: errors.length ? 'partial' : 'complete_for_bounded_sources', errors,
      atomic: false, nativeSnapshotAge: 'UNKNOWN; source_has_no_atomic_asOf_token', observation: 'independent_native_reads; intermediate_transitions_may_be_unobserved',
      work: scope.filter.owners?'explicit_owner_and_optional_ids; project_is_context_not_membership; assigned_metadata_only':'project_tag_or_targetRepo; assigned_metadata_only',
      seats:scope.filter.owners?'consumer_rig_context; external_owner_seats_not_observed':'rig_context_not_project_membership',
      ...(scope.filter.ids?{requestedIds:{observed:scope.filter.ids.filter(id=>!missingIds.includes(id)),missing:missingIds,meaning:'not_observed_in_bounded_owner_sources; deletion_not_established'}}:{}),
      blockerSince: 'unknown; compact_list_has_no_block_transition_time', staleActivity,
      history: scope.filter.owners?'up_to_1000_current_records_per_explicit_owner; no_transition_log_or_body_reads':'up_to_1000_current_records; no_transition_log_or_body_reads',
      sourceFilter: scope.filter.owners?'explicit_destinations; local_daemon_metadata; no_rig_fanout_or_identity_override':scope.filter.seat ? 'destination_only; external_blocker_owner_may_be_unknown' : 'native_current_rig' };
    const base = { schemaVersion, status: errors.length ? 'partial' : 'ok', scope, consumer: i.sessionName,
      observedAt: new Date(this.clock()).toISOString(), sources, coverage,
      cost: { nativeCalls: sources.length, nativeResponseBytes: sources.reduce((n, s) => n + (s.bytes ?? 0), 0),
        elapsedMs: Math.round(performance.now() - start), modelCallsInTool: 0, nativeTokenUsage: 'UNKNOWN; no_provider_usage_read' } };
    // Failed/incomplete sources never advance a cursor or imply mass removal.
    if (errors.length) return { ...base, changed: null, cursor: null, comparison: 'unavailable_due_to_source_coverage',
      reset_required: Boolean(hasCursor && !previous.entry), baseline: selected };
    let next;
    try { next = this.cache.save(i.sessionName, binding, selected, all.tasks); }
    catch { return { ...base, status: 'partial', changed: null, cursor: null, comparison: 'cursor_cache_unavailable', baseline: selected }; }
    if (!previous.entry) return { ...base, changed: true, cursor: next, reset_required: hasCursor,
      ...(hasCursor ? { resetReason: previous.reason } : {}), baseline: selected };
    const changes = delta(previous.entry.selected, selected);
    // Even with active-only filtering, final stop/cancel/fail/complete/handoff
    // and source-tagged gates remain visible when native current records change.
    const critical = Object.values(all.tasks).filter(t =>
      (!scope.filter.seat || t.owner === scope.filter.seat) &&
      (t.closure || t.handoff || t.humanGate || ['done', 'canceled', 'failed', 'denied', 'handed-off'].includes(t.state)) &&
      canonical(t) !== canonical(previous.entry.allTasks[t.id]));
    const changed = Boolean(changes.added.length || changes.changed.length || changes.removed.length || critical.length);
    if (!changed) return { changed: false, observedAt: base.observedAt, coverage, cursor: next };
    return { ...base, changed: true, cursor: next, delta: changes, critical };
  }
}
