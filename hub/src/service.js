import { realpathSync } from 'node:fs';
import { normalize, choose } from './policy.js';

export class AvailabilityService {
  constructor({ reader, store, home, seat, project, model, clock = Date.now }) {
    Object.assign(this, { reader, store, home: realpathSync(home), seat, project, model, clock });
  }
  async status() {
    const snapshot = normalize(await this.reader.read());
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
    const decision = choose({ currentId: status.accountId, entries: this.store.entries(),
      snapshots: this.store.snapshots(), project: this.project, model: this.model,
      now: this.clock(), providerLimit });
    if (!['wait', 'transition_required'].includes(decision.action)) return { decision };
    return { decision, operation: this.store.reserve(this.home, decision, context, this.clock()),
      execution: 'pending_native_precheck; no_auth_or_restart_performed' };
  }
}
