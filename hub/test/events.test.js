import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AvailabilityService } from '../src/service.js';
import { ProviderLimitListener } from '../src/events.js';
import { CodexSession } from '../src/codex.js';
import { armWake } from '../src/native.js';

const now = Math.floor(Date.now() / 1000) * 1000;
const context = { seat: 's', qitem: 'q', conversationId: 'native-c', cwd: '/work', configRef: 'cfg',
  permissions: 'builtin:yolo', model: 'fixed', effort: 'high', affectedCohort: ['s', 'neighbor'] };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Source extends EventEmitter {
  closed = false;
  reads = 0;
  async connect() {}
  async snapshot() { ++this.reads; return this.read(); }
  notify(params = {}) { this.emit('notification', { method: 'account/rateLimits/updated', params }); }
  close() { this.closed = true; this.emit('disconnected'); }
}
function setup(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'toolrig-events-')));
  const store = new Store(join(home, 'state.sqlite'));
  store.register({ accountId: 'a', authorized: true, authState: 'ready', authRef: 'fixture-a',
    grants: [{ project: 'toolrig', model: 'fixed', requiredBuckets: ['codex'] }] });
  const service = new AvailabilityService({ store, home, seat: 's', project: 'toolrig', model: 'fixed', clock: () => now });
  const source = new Source();
  const raw = (overrides = {}) => ({ home, account: { account: { type: 'chatgpt', planType: 'pro' } },
    usage: { accountId: 'a', ordinaryUsageAllowed: false, rateLimits: {
      limitId: 'codex', primary: { usedPercent: 100, resetsAt: now / 1000 + 600 },
    }, ...overrides }, observedAt: new Date(now).toISOString() });
  source.read = async () => raw();
  let q = { destinationSession: 's', state: 'in-progress' };
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (args[1] === 'show') return q;
    q = { destinationSession: 's', state: 'blocked', blockedOn: 'external:availability:' + store.pending(home).id };
    return q;
  };
  const listener = new ProviderLimitListener(service, context, {
    createSource: () => source,
    wake: (s, h, owner, options) => armWake(s, h, owner, { ...options, run }),
  });
  const results = [], diagnostics = [];
  listener.on('result', v => results.push(v)); listener.on('diagnostic', v => diagnostics.push(v));
  t.after(async () => { listener.stop(); await listener.idle(); store.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, store, service, source, raw, listener, calls, results, diagnostics };
}
test('sparse/missing/out-of-order payload is only an invalidation; fresh full block arms once', async t => {
  const x = setup(t); await x.listener.start();
  x.source.notify({ rateLimits: { primary: null } });
  x.source.notify({ rateLimits: { primary: { usedPercent: 1, resetsAt: 1 } } });
  await x.listener.idle();
  assert.equal(x.source.reads, 1);
  assert.equal(x.calls.filter(c => c[1] === 'block').length, 1);
  assert.equal(x.store.pending(x.home).decision.readyAt, new Date(now + 600000).toISOString());
  const operationId = x.store.pending(x.home).id;
  x.source.notify(); await x.listener.idle();
  assert.equal(x.store.pending(x.home).id, operationId);
  assert.equal(x.calls.filter(c => c[1] === 'block').length, 1);
  assert.equal(x.results.at(-1).wake, 'already_parked');
});
test('full-read missing identity/permission/window/grant, stale or nonblocked result cannot arm', async t => {
  const x = setup(t); await x.listener.start();
  for (const usage of [
    { ordinaryUsageAllowed: true }, { ordinaryUsageAllowed: null }, { accountId: null },
    { rateLimits: { limitId: 'codex', primary: null } },
    { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: null } } },
    { rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } }, ordinaryUsageAllowed: true },
  ]) {
    x.source.read = async () => x.raw(usage);
    x.source.notify({ rateLimits: { primary: { usedPercent: 100 } } }); await x.listener.idle();
  }
  x.source.read = async () => ({ ...x.raw(), observedAt: new Date(now - 180000).toISOString() });
  x.source.notify(); await x.listener.idle();
  x.service.project = 'ungranted'; x.source.read = async () => x.raw();
  x.source.notify(); await x.listener.idle();
  assert.equal(x.calls.length, 0); assert.equal(x.store.pending(x.home), null);
});
test('incomplete current quota cannot wait on a different account with a valid reset', async t => {
  const x = setup(t);
  x.store.register({ accountId: 'b', authorized: true, authState: 'ready', authRef: 'fixture-b',
    grants: [{ project: 'toolrig', model: 'fixed', requiredBuckets: ['codex'] }] });
  x.service.observe(x.raw({ accountId: 'b' }));
  await x.listener.start();
  for (const rateLimits of [
    { limitId: 'other', primary: { usedPercent: 100, resetsAt: now / 1000 + 600 } },
    { limitId: 'codex', primary: null },
    { limitId: 'codex', primary: { usedPercent: null } },
    { limitId: 'codex', primary: { usedPercent: 101 } },
    { limitId: 'codex', primary: { usedPercent: 100, resetsAt: now / 1000 + 600 }, secondary: { usedPercent: null } },
    { limitId: 'codex', primary: { usedPercent: 100, resetsAt: now / 1000 + 600 }, individualLimit: { remainingPercent: null } },
  ]) {
    x.source.read = async () => x.raw({ rateLimits });
    x.source.notify(); await x.listener.idle();
    assert.equal(x.calls.length, 0);
    assert.equal(x.store.pending(x.home), null);
    assert.equal(x.results.at(-1).reason, 'provider_block_unconfirmed');
  }
  x.store.register({ accountId: 'a', authorized: true, authState: 'ready', authRef: 'fixture-a',
    grants: [{ project: 'toolrig', model: 'fixed', requiredBuckets: ['codex', 'missing-required'] }] });
  x.source.read = async () => x.raw();
  x.source.notify(); await x.listener.idle();
  assert.equal(x.calls.length, 0); assert.equal(x.store.pending(x.home), null);
});
test('notification arriving during full read invalidates its snapshot before wake', async t => {
  const x = setup(t); const read = deferred(); let first = true;
  x.source.read = () => first ? (first = false, read.promise) : x.raw({ ordinaryUsageAllowed: true });
  await x.listener.start(); x.source.notify(); await Promise.resolve();
  x.source.notify({ rateLimits: {} }); read.resolve(x.raw()); await x.listener.idle();
  assert.equal(x.source.reads, 2); assert.equal(x.calls.length, 0);
  assert(x.diagnostics.some(d => d.code === 'superseded_snapshot'));
});
test('notification churn cannot produce an infinite read loop or arm', async t => {
  const x = setup(t);
  x.source.read = async () => { x.source.notify(); return x.raw(); };
  await x.listener.start(); x.source.notify(); await x.listener.idle();
  assert.equal(x.source.reads, 2); assert.equal(x.calls.length, 0);
  assert(x.diagnostics.some(d => d.code === 'notification_churn_unconfirmed'));
});
test('full-read failure stops without stale wake; explicit reconnect uses a fresh source', async t => {
  const x = setup(t);
  x.source.read = async () => { throw new Error('private-provider-body'); };
  await x.listener.start(); x.source.notify(); await x.listener.idle();
  assert.equal(x.listener.connected, false); assert.equal(x.calls.length, 0);
  assert.equal(x.listener.failure, 'full_snapshot_failed');
  assert.doesNotMatch(JSON.stringify(x.diagnostics), /private-provider-body/);
  const replacement = new Source(); replacement.read = async () => x.raw();
  x.listener.createSource = () => replacement;
  await x.listener.reconnect();
  assert.equal(x.listener.failure, null);
  x.source.notify(); await x.listener.idle(); assert.equal(replacement.reads, 0);
  replacement.notify(); await x.listener.idle();
  assert.equal(x.calls.filter(c => c[1] === 'block').length, 1);
});
test('disconnect invalidates a full read that finishes after connection loss', async t => {
  const x = setup(t); const read = deferred(); x.source.read = () => read.promise;
  await x.listener.start(); x.source.notify(); await Promise.resolve();
  x.source.close(); read.resolve(x.raw()); await x.listener.idle();
  assert.equal(x.calls.length, 0); assert.equal(x.store.pending(x.home), null);
});
test('new invalidation during owned-qitem lookup prevents native wake mutation', async t => {
  const x = setup(t);
  x.listener.wake = (s, h, owner, options) => armWake(s, h, owner, { ...options,
    run: async args => {
      x.calls.push(args);
      assert.equal(args[1], 'show');
      x.source.read = async () => x.raw({ ordinaryUsageAllowed: true });
      x.source.notify();
      return { destinationSession: 's', state: 'in-progress' };
    },
  });
  await x.listener.start(); x.source.notify(); await x.listener.idle();
  assert.equal(x.calls.filter(c => c[1] === 'block').length, 0);
  assert.equal(x.store.pending(x.home).wake, null);
});
test('unknown native effect reconciles repeated events without another park', async t => {
  const x = setup(t); let parked = false;
  x.listener.wake = (s, h, owner, options) => armWake(s, h, owner, { ...options,
    run: async args => {
      x.calls.push(args);
      if (args[1] === 'show') return parked ? { destinationSession: 's', state: 'blocked',
        blockedOn: 'external:availability:' + x.store.pending(h).id } : { destinationSession: 's', state: 'in-progress' };
      parked = true; throw new Error('response_lost');
    },
  });
  await x.listener.start(); x.source.notify(); await x.listener.idle();
  assert.equal(x.store.pending(x.home).wake, 'unknown');
  x.source.notify(); await x.listener.idle();
  assert.equal(x.store.pending(x.home).wake, 'armed');
  assert.equal(x.calls.filter(c => c[1] === 'block').length, 1);
});
test('two listeners join one operation and do not duplicate the native wake', async t => {
  const x = setup(t); const source = new Source(); source.read = async () => x.raw();
  const second = new ProviderLimitListener(x.service, context, { createSource: () => source, wake: x.listener.wake });
  t.after(async () => { second.stop(); await second.idle(); });
  await x.listener.start(); await second.start();
  x.source.notify(); source.notify();
  await Promise.all([x.listener.idle(), second.idle()]);
  assert.equal(x.calls.filter(c => c[1] === 'block').length, 1);
  assert.equal(x.store.pending(x.home).waiters.length, 1);
});
test('public JSON-RPC notification transport reaches adapter; no model/private method used', async t => {
  const x = setup(t); const binary = join(x.home, 'fixture-codex');
  x.service.clock = Date.now;
  writeFileSync(binary, `#!/usr/bin/env node
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',l=>{const m=JSON.parse(l);let result;
if(m.method==='initialize')result={codexHome:process.env.CODEX_HOME,userAgent:'fixture/0.166.0'};
else if(m.method==='initialized'){console.log(JSON.stringify({method:'account/rateLimits/updated',params:{rateLimits:{primary:null}}}));return;}
else if(m.method==='account/read')result={account:{type:'chatgpt'}};
else if(m.method==='account/rateLimits/read')result=${JSON.stringify(x.raw().usage)};
else throw new Error('unexpected_method');
console.log(JSON.stringify({id:m.id,result}));});`, { mode: 0o700 });
  x.listener.createSource = () => new CodexSession(x.home, { binary, timeoutMs: 5000 });
  let timeout;
  const receipt = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('fixture_notification_not_received')), 10000);
    x.listener.once('result', r => { clearTimeout(timeout); resolve(r); });
  });
  try {
    await x.listener.start();
    assert.equal((await receipt).wake, 'armed');
    await x.listener.idle();
    assert.equal(x.calls.filter(c => c[1] === 'block').length, 1);
  } finally { clearTimeout(timeout); }
});
