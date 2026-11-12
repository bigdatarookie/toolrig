import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { OwnedAppServer } from './owned-server.js';
import { launchSpec, backendOverrides, canonical, digest, validateLaunchEnvironment, GenerationLease } from './native-plan.js';
import { ProviderLimitListener } from './events.js';

// One native TUI and its original thread; no new execution or task engine.
const reads = new Set(['initialize', 'account/read', 'account/rateLimits/read', 'config/read',
  'configRequirements/read', 'model/list', 'experimentalFeature/list', 'skills/list',
  'app/list', 'plugin/list', 'mcpServerStatus/list', 'thread/list', 'thread/read', 'thread/loaded/list', 'thread/turns/list', 'thread/items/list']);
const TOKEN_ENV = 'TOOLRIG_NATIVE_REMOTE_TOKEN';
const live = child => Boolean(child?.pid && child.exitCode === null && child.signalCode === null);
const equal = (a, b) => canonical(a) === canonical(b);
export class NativeSeatRuntime extends EventEmitter {
  constructor(input, { environment = process.env, cwd = process.cwd(), spawnTui = spawn,
    createBackend = (home, options) => new OwnedAppServer(home, options), onAttached = async () => {} } = {}) {
    super();
    this.spec = launchSpec.parse(input);
    if (Object.hasOwn(environment, TOKEN_ENV)) throw new Error('native_token_environment_collision');
    Object.assign(this, { environment: { ...environment }, cwd, spawnTui, createBackend, onAttached });
    this.sources = new Set(); this.pending = new Map(); this.revoked = false;
  }
  async start() {
    const s = this.spec;
    validateLaunchEnvironment(s, this.environment, this.cwd);
    this.lease = new GenerationLease(s).claim();
    try {
      this.backend = this.createBackend(s.home, { binary: s.codexEntry.file, prefix: s.codexEntry.prefix,
        environment: this.environment, cwd: s.cwd, configOverrides: backendOverrides(s) });
      await this.backend.start();
      this.reader = this.backend.source({ inspectRuntime: true });
      this.reader.once('disconnected', () => this.revoke('backend_reader_disconnected'));
      this.backend.child.once('exit', () => this.revoke('backend_exited'));
      await this.reader.connect(); await this.attest(false);
      this.token = randomBytes(32).toString('hex');
      this.server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024,
        perMessageDeflate: false, verifyClient: ({ req }) => !this.revoked && !this.owner && live(this.tui) &&
          req.headers.authorization === 'Bearer ' + this.token });
      await once(this.server, 'listening');
      this.server.on('connection', owner => this.attach(owner));
      const args = [...s.codexEntry.prefix, '--no-daemon', '--remote', `ws://127.0.0.1:${this.server.address().port}`,
        '--remote-auth-token-env', TOKEN_ENV, 'resume', s.threadId];
      this.tui = this.spawnTui(s.codexEntry.file, args, { cwd: s.cwd,
        env: { ...this.environment, [TOKEN_ENV]: this.token }, stdio: 'inherit' });
      this.tui.once('error', () => this.revoke('tui_launch_failed'));
      this.tui.once('exit', () => this.revoke('tui_exited'));
      return this;
    } catch (error) { await this.stop(); throw error; }
  }
  async attest(requireThread = true) {
    this.backend.assertCustody();
    if (!this.lease.current() || this.revoked) throw new Error('native_generation_revoked');
    const raw = await this.reader.snapshot();
    const config = await this.reader.rpc('config/read', { includeLayers: false, cwd: this.spec.cwd });
    if (raw.usage.accountId !== this.spec.accountId || digest(config.config) !== this.spec.configDigest) {
      this.revoke('account_or_config_drift'); throw new Error('native_account_or_config_drift');
    }
    if (requireThread && !(await this.reader.rpc('thread/loaded/list', {})).data?.includes(this.spec.threadId)) {
      throw new Error('native_thread_not_loaded');
    }
    this.backend.assertCustody();
    if (!this.lease.current() || this.revoked) throw new Error('native_generation_revoked');
    return raw;
  }
  attach(owner) {
    if (this.owner || !live(this.tui) || this.revoked) { owner.close(); return; }
    this.owner = owner;
    this.upstream = new WebSocket('ws+unix://' + this.backend.physicalPath + ':/', {
      perMessageDeflate: false, handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 });
    let chain = Promise.resolve();
    const serialize = action => { chain = chain.then(action).catch(() => this.revoke('relay_validation_failed')); };
    const opened = once(this.upstream, 'open');
    // Frames may contain prompts/secrets: never log or persist them.
    owner.on('message', data => serialize(async () => {
      await opened;
      const message = JSON.parse(data.toString()); this.validateRequest(message);
      this.upstream.send(data.toString());
    }));
    this.upstream.on('message', data => serialize(async () => {
      const message = JSON.parse(data.toString());
      if (!message.method && Object.hasOwn(message, 'id')) {
        const method = this.pending.get(message.id); this.pending.delete(message.id);
        if (method === 'thread/resume' && !message.error) {
          this.validateResume(message.result); await this.attest();
          this.binding = Object.freeze({ kind: 'native-seat-owner', nativeSeatBound: true,
            seat: this.spec.seat, nodeId: this.spec.nodeId, generation: this.spec.generation,
            threadId: this.spec.threadId, accountId: this.spec.accountId,
            backendLauncherPid: this.backend.child.pid, tuiLauncherPid: this.tui.pid,
            socket: this.backend.physicalPath, observedAt: new Date().toISOString() });
          await this.onAttached(this); this.emit('binding', this.binding);
        }
      }
      if (message.method === 'account/updated') await this.attest(Boolean(this.binding));
      if (message.method === 'thread/settings/updated') this.validateSettings(message.params);
      if (message.method === 'account/rateLimits/updated' && this.valid()) {
        for (const source of this.sources) source.emit('notification', message);
      }
      if (this.revoked) return;
      if (message.method && Object.hasOwn(message, 'id')) { this.serverRequests ??= new Set(); this.serverRequests.add(message.id); }
      owner.send(data.toString());
    }));
    opened.catch(() => this.revoke('backend_connection_failed'));
    for (const socket of [owner, this.upstream]) {
      socket.on('error', () => this.revoke('owner_transport_failed'));
      socket.on('close', () => this.revoke('owner_disconnected'));
    }
  }
  validateRequest(m) {
    const s = this.spec;
    if (this.revoked || !this.lease.current()) throw new Error('native_generation_revoked');
    if (!m.method) {
      if (!this.serverRequests?.delete(m.id)) throw new Error('unexpected_owner_response'); return;
    }
    if (m.method === 'initialized' && !Object.hasOwn(m, 'id')) return;
    if (!Object.hasOwn(m, 'id') || this.pending.has(m.id)) throw new Error('invalid_owner_request');
    if (m.method === 'thread/resume') {
      if (this.binding || [...this.pending.values()].includes('thread/resume') || m.params?.threadId !== s.threadId ||
          Object.keys(m.params).some(key => m.params[key] != null && !['threadId', 'model', 'modelProvider', 'cwd', 'approvalPolicy', 'sandbox', 'config', 'excludeTurns', 'initialTurnsPage', 'runtimeWorkspaceRoots', 'serviceTier'].includes(key))) {
        throw new Error('native_resume_scope_mismatch');
      }
      if (m.params.config && Object.keys(m.params.config).length) throw new Error('native_resume_config_override');
    } else if (!reads.has(m.method)) {
      if (!['turn/start', 'turn/interrupt'].includes(m.method) || !this.valid() || m.params?.threadId !== s.threadId) {
        throw new Error('native_method_not_allowed');
      }
      if (['permissions', 'collaborationMode', 'approvalsReviewer', 'config'].some(key => m.params[key] != null)) throw new Error('native_permissions_override');
    }
    // Omitted means preserve; explicit null clears and must match captured null.
    if (m.params && Object.hasOwn(m.params, 'serviceTier') && !equal(m.params.serviceTier, s.serviceTier)) {
      throw new Error('native_tier_override');
    }
    const names = { model: s.model, modelProvider: s.modelProvider, cwd: s.cwd,
      approvalPolicy: s.approvalPolicy, sandbox: s.sandboxMode, sandboxPolicy: s.sandbox, effort: s.effort, runtimeWorkspaceRoots: s.runtimeWorkspaceRoots };
    for (const [key, expected] of Object.entries(names)) {
      if (m.params && m.params[key] != null && !equal(m.params[key], expected)) throw new Error('native_settings_override');
    }
    this.pending.set(m.id, m.method);
  }
  validateResume(r) {
    const s = this.spec;
    if (r?.thread?.id !== s.threadId || r.model !== s.model || r.modelProvider !== s.modelProvider || r.cwd !== s.cwd ||
        r.reasoningEffort !== s.effort || r.approvalsReviewer !== s.approvalsReviewer || r.serviceTier !== s.serviceTier || !equal(r.approvalPolicy, s.approvalPolicy) || !equal(r.sandbox, s.sandbox) || !equal(r.runtimeWorkspaceRoots, s.runtimeWorkspaceRoots) ||
        !equal(r.activePermissionProfile, s.activePermissionProfile)) {
      throw new Error('native_resume_settings_drift');
    }
  }
  validateSettings(params) {
    const s = this.spec, r = params?.threadSettings;
    if (params?.threadId !== s.threadId || !r || r.model !== s.model || r.modelProvider !== s.modelProvider ||
        r.cwd !== s.cwd || r.effort !== s.effort || !equal(r.approvalPolicy, s.approvalPolicy) ||
        !equal(r.sandboxPolicy, s.sandbox) || !equal(r.activePermissionProfile, s.activePermissionProfile) ||
        r.approvalsReviewer !== s.approvalsReviewer || r.serviceTier !== s.serviceTier) {
      throw new Error('native_thread_settings_drift');
    }
  }
  valid() {
    try {
      this.backend.assertCustody();
      return Boolean(this.binding && !this.revoked && this.lease.current() && live(this.tui) &&
        this.owner?.readyState === WebSocket.OPEN && this.upstream?.readyState === WebSocket.OPEN);
    } catch { return false; }
  }
  source() {
    if (!this.valid()) throw new Error('native_binding_unverified');
    const runtime = this;
    const source = new class extends EventEmitter {
      async connect() { if (!runtime.valid()) throw new Error('native_binding_unverified'); }
      async snapshot() {
        if (!runtime.valid() || this.closed) throw new Error('native_binding_unverified');
        try { return await runtime.attest(); }
        catch (error) { runtime.revoke('snapshot_attestation_failed'); throw error; }
      }
      close() { this.closed = true; runtime.sources.delete(this); this.emit('disconnected'); }
    }();
    this.sources.add(source); return source;
  }
  verifyNativeBinding({ source, snapshot, context }) {
    return this.sources.has(source) && !source.closed && this.valid() && snapshot.accountId === this.spec.accountId &&
      context.seat === this.spec.seat && context.qitem === this.spec.qitem && context.model === this.spec.model &&
      context.conversationId === this.spec.threadId && context.cwd === this.spec.cwd &&
      context.effort === this.spec.effort && context.permissions === this.spec.permissionsRef &&
      context.configRef === this.spec.configRef && equal(context.affectedCohort, this.spec.affectedCohort);
  }
  async listen(service, context, options = {}) {
    if (service.project !== this.spec.project) throw new Error('native_project_mismatch');
    this.listener = new ProviderLimitListener(service, context, { ...options,
      createSource: () => this.source(), verifyNativeBinding: input => this.verifyNativeBinding(input) });
    await this.listener.start(); return this.listener;
  }
  revoke(code) {
    if (this.revoked) return;
    this.revoked = true; this.binding = null; this.token = null;
    for (const source of [...this.sources]) source.close();
    this.owner?.terminate(); this.upstream?.terminate(); this.emit('revoked', { code });
    this.stopping ??= this.cleanup();
    this.stopping.catch(() => {}); // stop() still reports a retained/unknown cleanup outcome
  }
  async cleanup() {
    this.listener?.stop();
    if (live(this.tui)) {
      const exited = once(this.tui, 'exit').catch(() => {});
      this.tui.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); clearTimeout(timer);
      if (live(this.tui)) throw new Error('native_tui_stop_unconfirmed; lease retained');
    }
    this.server?.close(); await this.backend?.stop(); this.lease?.release();
  }
  async stop() { this.revoke('owner_stopped'); await this.stopping; }
}
