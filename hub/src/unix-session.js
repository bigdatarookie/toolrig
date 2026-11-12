import WebSocket from 'ws';
import { CodexSession } from './codex.js';

// Codex's public Unix transport is WebSocket-over-UDS, not NDJSON-over-UDS.
// This is a read-only transport adapter; it never starts/resumes/runs a thread.
export class UnixCodexSession extends CodexSession {
  constructor(home, socket, options = {}) { super(home, options); this.socketPath = socket; }
  async connect() {
    this.socket = new WebSocket('ws+unix://' + this.socketPath + ':/', { maxPayload: 1024 * 1024,
      perMessageDeflate: false, handshakeTimeout: this.timeoutMs });
    this.socket.on('error', () => this.close());
    this.socket.on('close', () => this.close());
    this.socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.method && !Object.hasOwn(message, 'id')) { this.emit('notification', message); return; }
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error('provider_rpc_error')); else item.resolve(message.result);
    });
    try {
      await new Promise((resolve, reject) => {
        const opened = () => { this.off('disconnected', failed); resolve(); };
        const failed = () => { this.socket.off('open', opened); reject(new Error('provider_unavailable')); };
        this.socket.once('open', opened); this.once('disconnected', failed);
      });
      this.init = await this.rpc('initialize', { clientInfo: { name: 'toolrig_availability', version: '0.1.0' } });
      this.socket.send(JSON.stringify({ method: 'initialized' }));
    } catch (error) { this.close(); throw error; }
  }
  rpc(method, params) {
    if (!['initialize', 'account/read', 'account/rateLimits/read'].includes(method)) {
      return Promise.reject(new Error('provider_method_not_allowed'));
    }
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('provider_unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => this.close(), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('provider_unavailable')); }
    this.pending.clear(); this.socket?.terminate(); this.emit('disconnected');
  }
}
