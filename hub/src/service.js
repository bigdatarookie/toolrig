import { realpathSync } from 'node:fs';
import { normalize, choose, availability } from './policy.js';

export class AvailabilityService {
  constructor({ reader, store, home, seat, project, model, clock = Date.now }) {
    Object.assign(this, { reader, store, home: realpathSync(home), seat, project, model, clock });
  }
  async status() {
    return this.observe(await this.reader.read());
  }
  observe(raw) {
    const snapshot = normalize(raw);
    if (realpathSync(snapshot.home) !== this.home) throw new Error('provider_home_mismatch');
    this.store.observe(snapshot);
    return { ...snapshot, consumer: this.seat,
      identityScope: 'fresh_app_server_on_configured_home; live_seat_account_not_attested',
      pendingOperation: this.store.pending(this.home),
      permittedAccountCount: this.store.entries().filter(e => e.authorized).length };
  }
  async request(context, { providerLimit = false } = {}) {
    if (context.seat !== this.seat || context.model !== this.model) throw new Error('consumer_context_mismatch');
    const status = await this.status();
    return this.requestFromSnapshot(context, status, { providerLimit });
  }
  confirmedProviderBlock(snapshot) {
    const entry = this.store.entries().find(e => e.accountId === snapshot.accountId);
    const grant = entry?.grants.find(g => g.project === this.project && g.model === this.model);
    const knownPercent = w => typeof w.remainingPercent === 'number' &&
      Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100;
    // Policy may know the provider denied usage while quota details are unknown.
    // The event-to-park boundary requires all current required buckets/windows
    // before a different account's confirmed reset can justify a durable wait.
    const knownQuota = grant?.requiredBuckets.length && grant.requiredBuckets.every(id => {
      const bucket = snapshot.buckets[id];
      return bucket?.windows.length > 0 && bucket.windows.every(knownPercent) &&
        (!bucket.individualLimit || knownPercent(bucket.individualLimit));
    });
    return Boolean(knownQuota) && snapshot.ordinaryUsageAllowed === false &&
      availability(snapshot, grant?.requiredBuckets, this.clock()).state === 'blocked';
  }
  requestFromSnapshot(context, status, { providerLimit = false } = {}) {
    if (context.seat !== this.seat || context.model !== this.model) throw new Error('consumer_context_mismatch');
    const decision = this.decisionFor(status, { providerLimit });
    if (!['wait', 'transition_required'].includes(decision.action)) return { decision };
    return { decision, operation: this.store.reserve(this.home, decision, context, this.clock()),
      execution: 'pending_native_precheck; no_auth_or_restart_performed' };
  }
  decisionFor(status, { providerLimit = false } = {}) {
    return choose({ currentId: status.accountId, entries: this.store.entries(),
      snapshots: this.store.snapshots(), project: this.project, model: this.model,
      now: this.clock(), providerLimit });
  }
}
