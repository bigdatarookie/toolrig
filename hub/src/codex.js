import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Only supported read RPCs; no native files, inference turns, or login mutations.
export class CodexReader {
  constructor(home, { binary = 'codex', timeoutMs = 35000 } = {}) {
    this.home = home;
    this.binary = binary;
    this.timeoutMs = timeoutMs;
  }
  async read() {
    const child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      env: { ...process.env, CODEX_HOME: this.home }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let seq = 0;
    const pending = new Map();
    const lines = createInterface({ input: child.stdout });
    const fail = () => {
      for (const { reject } of pending.values()) reject(new Error('provider_unavailable'));
      pending.clear();
    };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      // Rolling updates have sparse/null metadata. Refetch instead of treating
      // a notification's missing field as account/quota recovery.
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error('provider_rpc_error'));
      else item.resolve(message.result);
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    const timer = setTimeout(() => { fail(); child.kill(); }, this.timeoutMs);
    try {
      const init = await rpc('initialize', { clientInfo: { name: 'toolrig_availability', version: '0.1.0' } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      const account = await rpc('account/read', { refreshToken: false });
      const identityObservedAt = new Date().toISOString();
      const usage = await rpc('account/rateLimits/read', null);
      return { account, usage, identityObservedAt, observedAt: new Date().toISOString(), home: init.codexHome,
        providerVersion: init.userAgent };
    } finally {
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
    }
  }
}
