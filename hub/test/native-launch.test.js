import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { NativeLaunchHooks } from '../src/native-hooks.js';
import { NativeSeatRuntime } from '../src/native-runtime.js';
import { Store } from '../src/store.js';
import { AvailabilityService } from '../src/service.js';
import { GenerationLease, digest, backendOverrides } from '../src/native-plan.js';

function plan(t) {
  const root = realpathSync(mkdtempSync('/tmp/tr-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { version: 1, enabled: true, seat: 'fixture-seat', nodeId: 'node-fixture', generation: 'generation-1',
    threadId: 'original-thread', qitem: 'owned-qitem', project: 'fixture-project', cwd: root, home: root,
    model: 'preserved-model', effort: 'medium', modelProvider: 'fixture', accountId: 'fixture-account',
    approvalPolicy: 'never', approvalsReviewer: 'user', serviceTier: null, sandbox: { type: 'dangerFullAccess' }, sandboxMode: 'danger-full-access',
    permissionsRef: 'builtin:yolo', configRef: 'preserved-config', affectedCohort: ['fixture-seat'],
    runtimeWorkspaceRoots: [], activePermissionProfile: null, configProfile: null,
    configDigest: digest({ model: 'preserved-model', fixture: true }), configOverrides: {},
    runtimeRoot: join(root, 'leases'), codexEntry: { file: process.execPath, prefix: ['/fixture/codex.js'] } };
}
const environment = s => ({ OPENRIG_NODE_ID: s.nodeId, OPENRIG_SESSION_NAME: s.seat,
  OPENRIG_OCCUPANT_GENERATION: s.generation, OPENRIG_RUNTIME: 'codex', CODEX_HOME: s.home,
  FIXTURE_SECRET: 'inherited-only' });
const context = s => ({ seat: s.seat, qitem: s.qitem, conversationId: s.threadId, cwd: s.cwd,
  configRef: s.configRef, permissions: s.permissionsRef, model: s.model, effort: s.effort, affectedCohort: s.affectedCohort });
function child() {
  const p = new EventEmitter(); Object.assign(p, { pid: 999999, exitCode: null, signalCode: null });
  p.kill = signal => { p.signalCode = signal; p.emit('exit', null, signal); }; return p;
}
async function fixture(t, options = {}) {
  const spec = { ...plan(t), ...(options.spec ?? {}) }, env = environment(spec), requests = [], backendNotifications = [];
  const http = createServer();
  const socket = join(spec.cwd, 'engine.sock');
  const wss = new WebSocketServer({ server: http });
  const state = { accountId: spec.accountId, config: { model: spec.model, fixture: true }, loaded: [], sockets: [] };
  const resume = () => ({ thread: { id: spec.threadId }, model: spec.model, modelProvider: spec.modelProvider,
    cwd: spec.cwd, reasoningEffort: spec.effort, approvalPolicy: spec.approvalPolicy, approvalsReviewer: spec.approvalsReviewer, serviceTier: spec.serviceTier, sandbox: spec.sandbox,
    runtimeWorkspaceRoots: [], activePermissionProfile: null, ...options.resume });
  wss.on('connection', s => {
    state.sockets.push(s);
    s.on('message', data => {
      const m = JSON.parse(data); requests.push(m.method);
      let result = {};
      if (m.method === 'thread/resume') { state.loaded = [spec.threadId]; result = resume(); }
      if (m.method === 'initialized') return;
      s.send(JSON.stringify({ id: m.id, result }));
    });
  });
  await new Promise(resolve => http.listen(socket, resolve));
  const backend = { child: child(), physicalPath: socket, start: async () => {}, assertCustody() {
    if (this.child.signalCode) throw new Error('backend_exited');
  }, source() {
    const r = new EventEmitter();
    r.connect = async () => {};
    r.snapshot = async () => ({ usage: { accountId: state.accountId, ordinaryUsageAllowed: false,
      rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: Date.now() / 1000 + 600 } } },
      account: { account: { type: 'chatgpt', planType: 'pro' } }, observedAt: new Date().toISOString(), home: spec.home });
    r.rpc = async method => method === 'config/read' ? { config: state.config } : { data: state.loaded };
    backendNotifications.push(r); return r;
  }, async stop() { this.child.kill('SIGTERM'); } };
  let spawned;
  const runtime = new NativeSeatRuntime(spec, { environment: env, cwd: spec.cwd,
    createBackend(home, settings) { spawned = { home, settings }; return backend; },
    spawnTui(file, args, settings) { spawned.tui = { file, args, settings }; return child(); },
    onAttached: options.onAttached });
  t.after(async () => {
    await runtime.stop(); for (const s of state.sockets) s.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => http.close(resolve));
  });
  await runtime.start();
  const connect = async (token = runtime.token) => {
    const ws = new WebSocket(`ws://127.0.0.1:${runtime.server.address().port}`,
      { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    await once(ws, 'open'); return ws;
  };
  const attach = async (overrides = {}) => {
    const owner = await connect();
    let id = 0;
    const rpc = async (method, params) => {
      const result = once(owner, 'message');
      owner.send(JSON.stringify({ id: ++id, method, params }));
      return JSON.parse((await result)[0]);
    };
    await rpc('initialize', { clientInfo: { name: 'fixture-tui' } });
    const binding = once(runtime, 'binding');
    owner.send(JSON.stringify({ id: ++id, method: 'thread/resume', params: {
      threadId: spec.threadId, model: null, cwd: null, history: null, path: null, permissions: null,
      approvalPolicy: null, sandbox: null, config: null, initialTurnsPage: null, ...overrides } }));
    return { owner, binding, rpc };
  };
  return { spec, runtime, state, connect, attach, requests, backendNotifications, spawned };
}

test('opt-in hook preserves legacy, stages resume only, and uses existing seat environment once', async t => {
  const s = plan(t), binding = { nodeId: s.nodeId, launchGeneration: s.generation, cwd: s.cwd, tmuxSession: 'pane' };
  const prepared = { ok: true, model: s.model, effort: s.effort, profile: undefined };
  assert.equal(await new NativeLaunchHooks().prepareLaunch(binding, s.seat, prepared, {}), prepared);
  const hooks = new NativeLaunchHooks({ enabledFor: () => true, captureOriginal: async () => s,
    runtimeRoot: s.runtimeRoot, resolveCodexEntry: async () => s.codexEntry });
  await assert.rejects(hooks.prepareLaunch(binding, s.seat, prepared, {}), /requires_resume/);
  const p = await hooks.prepareLaunch(binding, s.seat, prepared, { installCorePlugin: false });
  const command = hooks.resumeCore(p, s.threadId);
  assert(!command.includes('inherited-only')); assert(command.includes('native-launch-main.js'));
  let calls = 0;
  const wrapped = await hooks.seatCommand(binding, command, { command: async (session, value, opts) => {
    calls++; assert.equal(session, 'pane'); assert.equal(opts.generation, s.generation);
    assert.equal(opts.codexCwd, undefined); return 'wrapped ' + value;
  } });
  assert.equal(calls, 1); assert(wrapped.startsWith('wrapped '));
  assert.equal(await hooks.seatCommand(binding, 'codex resume legacy', {}), undefined);
  assert.equal(existsSync(s.runtimeRoot), false); // preparing a plan has no launch effects
});
test('generation lease refuses duplicate ownership and never removes replacement state', t => {
  const s = plan(t), a = new GenerationLease(s).claim();
  assert(a.current()); assert.throws(() => new GenerationLease(s).claim(), /EEXIST/);
  writeFileSync(a.path, '{}'); assert.equal(a.current(), false); a.release(); assert(existsSync(a.path));
});
test('unsupported config/profile and environment drift fail before any launch', async t => {
  const s = plan(t); assert.throws(() => backendOverrides({ ...s, configOverrides: { auth_token: 'never' } }), /unsupported/);
  let called = false;
  const r = new NativeSeatRuntime(s, { environment: { ...environment(s), CODEX_HOME: '/different' }, cwd: s.cwd,
    createBackend: () => { called = true; } });
  await assert.rejects(r.start(), /environment_drift/); assert.equal(called, false);
});
test('owning resume attaches; same-backend snapshot and sole owner events authorize exact continuation', async t => {
  const f = await fixture(t); const { owner, binding } = await f.attach(); await binding;
  assert.equal(f.runtime.binding.nativeSeatBound, true);
  assert.equal(f.spawned.settings.environment.FIXTURE_SECRET, 'inherited-only');
  assert.equal(f.spawned.settings.environment.TOOLRIG_NATIVE_REMOTE_TOKEN, undefined);
  assert.equal(f.spawned.tui.settings.env.FIXTURE_SECRET, 'inherited-only');
  assert(!JSON.stringify(f.spawned.tui.args).includes(f.runtime.token));
  assert(f.spawned.tui.args.includes(f.spec.threadId));
  assert(!f.spawned.settings.configOverrides.includes('features.plugins=false'));
  const source = f.runtime.source(); await source.connect(); await source.snapshot();
  const input = { source, snapshot: { accountId: f.spec.accountId }, context: context(f.spec) };
  assert.equal(f.runtime.verifyNativeBinding(input), true);
  assert.equal(f.runtime.verifyNativeBinding({ ...input, source: { ...source } }), false);
  assert.equal(f.runtime.verifyNativeBinding({ ...input, context: { ...input.context, qitem: 'other' } }), false);
  let events = 0; source.on('notification', () => events++);
  f.backendNotifications[0].emit('notification', { method: 'account/rateLimits/updated' });
  assert.equal(events, 0);
  const invalidated = once(source, 'notification');
  f.state.sockets[0].send(JSON.stringify({ method: 'account/rateLimits/updated', params: {} }));
  await invalidated; assert.equal(events, 1);
  await assert.rejects(f.connect(), /401/); await assert.rejects(f.connect('wrong'), /401/);
  owner.terminate(); await once(f.runtime, 'revoked');
  assert.equal(f.runtime.verifyNativeBinding(input), false);
  await f.runtime.stop(); assert.equal(f.runtime.lease.current(), false);
  assert.equal(f.requests.filter(m => m === 'thread/resume').length, 1);
  assert(!f.requests.includes('thread/start'));
});
test('resume settings mismatch never emits receipt or allows a turn', async t => {
  const f = await fixture(t, { resume: { model: 'changed-model' } });
  let bound = false; f.runtime.on('binding', () => { bound = true; });
  const revoked = once(f.runtime, 'revoked'); await f.attach(); await revoked;
  assert.equal(bound, false); assert.equal(f.runtime.binding, null);
  assert(!f.requests.includes('turn/start'));
});
test('account/config drift revokes before event snapshot can authorize reservation', async t => {
  const f = await fixture(t); const { binding } = await f.attach(); await binding;
  const source = f.runtime.source(); f.state.accountId = 'changed-account';
  await assert.rejects(source.snapshot(), /account_or_config_drift/);
  assert.equal(f.runtime.valid(), false);
});
test('wrong-thread, permission mutation, generation replacement and pre-resume turns are denied', async t => {
  const f = await fixture(t);
  for (const [method, params] of [['thread/start', {}], ['turn/start', { threadId: f.spec.threadId }],
    ['thread/resume', { threadId: 'other' }], ['thread/resume', { threadId: f.spec.threadId, history: [] }]]) {
    assert.throws(() => f.runtime.validateRequest({ id: 8, method, params }));
  }
  const { binding } = await f.attach(); await binding;
  assert.throws(() => f.runtime.validateRequest({ id: 8, method: 'turn/start', params: {
    threadId: f.spec.threadId, permissions: 'changed' } }), /permissions_override/);
  writeFileSync(f.runtime.lease.path, '{}'); assert.equal(f.runtime.valid(), false);
});
test('owning invalidation reaches existing reservation/wake boundary; later generation drift prevents park', async t => {
  const f = await fixture(t); const { binding } = await f.attach(); await binding;
  const store = new Store(join(f.spec.home, 'fixture.sqlite'));
  store.register({ accountId: f.spec.accountId, authorized: true, authState: 'ready', authRef: 'fixture-ref',
    grants: [{ project: f.spec.project, model: f.spec.model, requiredBuckets: ['codex'] }] });
  const service = new AvailabilityService({ store, home: f.spec.home, seat: f.spec.seat, project: f.spec.project, model: f.spec.model });
  const checks = [];
  const listener = await f.runtime.listen(service, context(f.spec), { wake: async (_store, _home, _seat, options) => {
    checks.push(options.confirm());
    writeFileSync(f.runtime.lease.path, '{}');
    checks.push(options.confirm());
    return { action: 'not_parked' };
  } });
  t.after(async () => { listener.stop(); await listener.idle(); store.close(); });
  const result = once(listener, 'result');
  f.state.sockets[0].send(JSON.stringify({ method: 'account/rateLimits/updated', params: {} }));
  await result; await listener.idle();
  assert(store.pending(service.home)); assert.deepEqual(checks, [true, false]);
});
test('effective config drift revokes the owning attachment before snapshot authorization', async t => {
  const f = await fixture(t); const { binding } = await f.attach(); await binding;
  const source = f.runtime.source(); f.state.config = { changed: true };
  await assert.rejects(source.snapshot(), /account_or_config_drift/);
  assert.equal(f.runtime.valid(), false);
});

test('captured non-null service tier survives native resume and turn; changed or cleared tiers are denied', async t => {
  const f = await fixture(t, { spec: { serviceTier: 'fast' } });
  const outcome = Promise.race([once(f.runtime, 'binding').then(() => 'bound'),
    once(f.runtime, 'revoked').then(() => 'revoked')]);
  await f.attach({ serviceTier: 'fast' });
  assert.equal(await outcome, 'bound');
  assert(f.requests.includes('thread/resume'));
  assert.doesNotThrow(() => f.runtime.validateRequest({ id: 42, method: 'turn/start',
    params: { threadId: f.spec.threadId, serviceTier: 'fast' } }));
  for (const tier of ['default', null]) {
    assert.throws(() => f.runtime.validateRequest({ id: 43, method: 'turn/start',
      params: { threadId: f.spec.threadId, serviceTier: tier } }), /native_tier_override/);
  }
});
test('resume denies changed and explicitly cleared captured tier before forwarding to backend', async t => {
  const f = await fixture(t, { spec: { serviceTier: 'fast' } });
  for (const tier of ['default', null]) {
    assert.throws(() => f.runtime.validateRequest({ id: 42, method: 'thread/resume',
      params: { threadId: f.spec.threadId, serviceTier: tier } }), /native_tier_override/);
  }
  assert(!f.requests.includes('thread/resume'));
  const { binding } = await f.attach(); await binding; // omission preserves original tier
});
