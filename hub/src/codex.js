import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// Public app-server JSON-RPC transport shared by short reads and the opt-in
// notification adapter. This subscribes only to this connection's notifications;
// it does not attach to or claim events from another running native CLI seat.
export class CodexSession extends EventEmitter {
  constructor(home, { binary = 'codex', timeoutMs = 35000 } = {}) {
    super();
    Object.assign(this, { home, binary, timeoutMs });
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
  }
  async connect() {
    this.child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      env: { ...process.env, CODEX_HOME: this.home }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    const fail = () => this.close();
    this.child.on('error', fail);
    this.child.on('exit', fail);
    this.child.stdin.on('error', fail);
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && !Object.hasOwn(message, 'id')) {
        this.emit('notification', message);
        return;
      }
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error('provider_rpc_error'));
      else item.resolve(message.result);
    });
    try {
      this.init = await this.rpc('initialize', { clientInfo: { name: 'toolrig_availability', version: '0.1.0' } });
      this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    } catch (error) { this.close(); throw error; }
  }
  rpc(method, params) {
    if (!['initialize', 'account/read', 'account/rateLimits/read'].includes(method)) {
      return Promise.reject(new Error('provider_method_not_allowed'));
    }
    if (this.closed || !this.child) return Promise.reject(new Error('provider_unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      // A bounded RPC deadline, not a quota polling/reconnect scheduler.
      const timer = setTimeout(() => this.close(), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async snapshot() {
    if (!this.init || this.closed) throw new Error('provider_unavailable');
    const account = await this.rpc('account/read', { refreshToken: false });
    const identityObservedAt = new Date().toISOString();
    const usage = await this.rpc('account/rateLimits/read', null);
    return { account, usage, identityObservedAt, observedAt: new Date().toISOString(),
      home: this.init.codexHome, providerVersion: this.init.userAgent };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('provider_unavailable'));
    }
    this.pending.clear();
    this.lines?.close();
    this.child?.stdin.end();
    this.child?.kill();
    this.emit('disconnected');
  }
}

// Only supported read RPCs; no native files, inference turns, or login mutations.
export class CodexReader {
  constructor(home, { binary = 'codex', timeoutMs = 35000 } = {}) {
    this.home = home;
    this.binary = binary;
    this.timeoutMs = timeoutMs;
  }
  async read() {
    const session = new CodexSession(this.home, this);
    const deadline = setTimeout(() => session.close(), this.timeoutMs);
    try {
      await session.connect();
      return await session.snapshot();
    } finally { clearTimeout(deadline); session.close(); }
  }
}
