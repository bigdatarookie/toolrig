import { EventEmitter } from 'node:events';
import { CodexSession } from './codex.js';
import { armWake } from './native.js';
import { continuation } from './store.js';

// Notifications are invalidations, never authoritative quota/account updates.
// No polling, reconnect timer, private native hook or business-operation retry.
export class ProviderLimitListener extends EventEmitter {
  constructor(service, context, { createSource = () => new CodexSession(service.home), wake = armWake } = {}) {
    super();
    continuation.parse(context);
    if (context.seat !== service.seat || context.model !== service.model) throw new Error('consumer_context_mismatch');
    Object.assign(this, { service, context, createSource, wake });
    this.revision = 0;
    this.connected = false;
    this.dirty = false;
  }
  async start() {
    if (this.source) throw new Error('listener_already_started');
    this.source = this.createSource();
    const source = this.source;
    this.failure = null;
    this.finished = new Promise(resolve => { this.finish = resolve; });
    this.onNotification = message => {
      if (message.method !== 'account/rateLimits/updated') return;
      ++this.revision;
      this.dirty = true;
      this.schedule();
    };
    this.onDisconnect = () => {
      ++this.revision;
      this.connected = false;
      this.failure = 'provider_disconnected';
      this.emit('diagnostic', { code: 'provider_disconnected', reconnect: 'explicit_native_owner_restart' });
      this.finish();
    };
    source.on('notification', this.onNotification);
    source.on('disconnected', this.onDisconnect);
    try {
      await source.connect();
      if (source !== this.source || source.closed) throw new Error('provider_unavailable');
      this.connected = true;
      this.schedule();
    } catch (error) { this.stop(); throw error; }
  }
  schedule() {
    if (!this.connected || this.running || !this.dirty) return;
    // Same-tick duplicate events coalesce. Each drain is bounded to two full
    // reads: an event emitted by a read cannot create an unbounded read loop.
    this.running = Promise.resolve().then(() => this.drain()).finally(() => {
      this.running = null;
      this.schedule(); // an external event may arrive as a completed drain settles
    });
  }
  async idle() { while (this.running) await this.running; }
  async drain() {
    for (let attempt = 0; attempt < 2 && this.connected && this.dirty; ++attempt) {
      this.dirty = false;
      const revision = this.revision;
      const source = this.source;
      let raw;
      try { raw = await source.snapshot(); }
      catch {
        this.failure = 'full_snapshot_failed';
        this.emit('diagnostic', { code: 'full_snapshot_failed', reconnect: 'explicit_native_owner_restart' });
        this.stop();
        return;
      }
      if (!this.connected || source !== this.source) return;
      if (revision !== this.revision) {
        this.emit('diagnostic', { code: 'superseded_snapshot' });
        continue;
      }
      try {
        const snapshot = this.service.observe(raw);
        if (!this.service.confirmedProviderBlock(snapshot)) {
          this.emit('result', { action: 'no_wake', reason: 'provider_block_unconfirmed', observedAt: snapshot.observedAt });
          continue;
        }
        const result = this.service.requestFromSnapshot(this.context, snapshot);
        if (result.decision.action !== 'wait' || !result.operation) {
          this.emit('result', { action: 'no_wake', reason: result.decision.action });
          continue;
        }
        const { operation: op, decision: d } = result;
        if (op.decision.target !== d.target || op.decision.readyAt !== d.readyAt) {
          this.emit('result', { action: 'no_wake', reason: 'pending_decision_requires_revalidation', operationId: op.id });
          continue;
        }
        const receipt = await this.wake(this.service.store, this.service.home, this.service.seat, {
          now: this.service.clock(), clock: this.service.clock,
          confirm: () => {
            const latest = this.service.decisionFor(snapshot);
            return this.connected && source === this.source && revision === this.revision &&
              this.service.confirmedProviderBlock(snapshot) && latest.action === 'wait' &&
              latest.target === d.target && latest.readyAt === d.readyAt;
          },
        });
        this.emit('result', receipt);
      } catch {
        // Unknown native effects remain in existing durable operation state.
        // Never print raw provider inputs/errors or treat this as recovery.
        this.emit('diagnostic', { code: 'event_continuation_not_armed' });
      }
    }
    if (this.dirty) {
      this.dirty = false;
      this.emit('diagnostic', { code: 'notification_churn_unconfirmed', retry: 'next_external_event_or_explicit_reconnect' });
    }
  }
  stop() {
    ++this.revision;
    this.connected = false;
    this.dirty = false;
    if (this.source) {
      this.source.off('notification', this.onNotification);
      this.source.off('disconnected', this.onDisconnect);
      this.source.close();
      this.source = null;
    }
    this.finish?.();
  }
  async reconnect() {
    this.stop();
    // Drain an invalidated old read before accepting a new source generation.
    await this.idle();
    await this.start();
  }
}
