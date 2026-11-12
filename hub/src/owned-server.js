import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, lstatSync, rmSync, watch, readlinkSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { UnixCodexSession } from './unix-session.js';

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

// Custody of a task-owned public endpoint, not an attestation of a working seat.
// No API accepts an arbitrary existing socket or a user-written binding file.
export class OwnedAppServer {
  constructor(home, { binary = 'codex', timeoutMs = 35000, watchDirectory = watch, prefix = [], environment, cwd, configOverrides } = {}) {
    Object.assign(this, { home: realpathSync(home), binary, timeoutMs, watchDirectory });
    Object.assign(this, { prefix, environment, cwd, configOverrides });
    this.clients = new Set();
  }
  async start() {
    if (this.directory) throw new Error('server_already_started');
    if (process.platform === 'win32') throw new Error('unix_transport_required');
    const environment = this.environment ?? { ...process.env, CODEX_HOME: this.home };
    if (realpathSync(environment.CODEX_HOME) !== this.home) throw new Error('provider_home_mismatch');
    // Short path for macOS sockaddr_un. mkdtemp creates a private 0700 directory.
    this.directory = realpathSync(mkdtempSync('/tmp/toolrig-bind-'));
    this.directoryIdentity = lstatSync(this.directory);
    this.socket = join(this.directory, 'control.sock');
    const overrides = this.configOverrides ?? ['features.plugins=false', 'features.apps=false'];
    this.child = spawn(this.binary, [...this.prefix, ...overrides.flatMap(value => ['-c', value]),
      'app-server', '--listen', 'unix://' + this.socket], {
      env: environment, cwd: this.cwd, stdio: 'ignore', detached: true,
    });
    try {
      await this.waitForSocket();
      this.socketIdentity = lstatSync(this.socket);
      const physical = this.inspectEndpoint();
      this.physicalPath = physical.path;
      this.physicalIdentity = physical.identity;
      if (this.physicalPath !== this.socket) {
        try { this.lockIdentity = lstatSync(this.physicalPath + '.lock'); } catch { /* native cleanup may remove it */ }
      }
      this.assertCustody();
      return this;
    } catch (error) { await this.stop(); throw error; }
  }
  waitForSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let watcher;
      let timeout;
      let retry;
      const fail = () => finish(new Error('owned_app_server_unavailable'));
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(retry);
        watcher?.close();
        this.child.off('error', fail);
        this.child.off('exit', fail);
        if (error) reject(error); else resolve();
      };
      const check = () => {
        try {
          this.inspectEndpoint();
          finish();
        } catch (error) { if (error.code !== 'ENOENT') finish(new Error('unsafe_endpoint')); }
      };
      this.child.once('error', fail);
      this.child.once('exit', fail);
      watcher = this.watchDirectory(this.directory, check);
      watcher.once('error', fail);
      timeout = setTimeout(fail, this.timeoutMs);
      const readiness = () => {
        if (settled) return;
        check();
        // Some macOS filesystems do not report Unix socket creation to fs.watch.
        // This ends at the startup deadline/socket readiness, never polls quota.
        if (!settled) retry = setTimeout(readiness, 50);
      };
      readiness();
    });
  }
  inspectEndpoint() {
    const alias = lstatSync(this.socket);
    const uid = process.getuid();
    if (alias.uid !== uid) throw new Error('unsafe_endpoint');
    if (alias.isSocket()) return { path: this.socket, identity: alias };
    // Codex 0.166 publishes the requested public Unix path as an alias to a
    // protected SHA256-derived socket. Validate that exact source contract;
    // never resolve arbitrary symlinks or scan other daemon sockets.
    const root = join(realpathSync('/tmp'), 'codex-daemon-' + uid);
    const expected = join(root, createHash('sha256').update(this.socket).digest('hex'));
    if (!alias.isSymbolicLink() || readlinkSync(this.socket) !== expected) throw new Error('unsafe_endpoint');
    const directory = lstatSync(root);
    const physical = lstatSync(expected);
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700 ||
        !physical.isSocket() || physical.uid !== uid || (physical.mode & 0o077) !== 0) throw new Error('unsafe_endpoint');
    return { path: expected, identity: physical };
  }
  assertCustody() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) {
      throw new Error('owned_app_server_not_running');
    }
    const dir = lstatSync(this.directory);
    const socket = lstatSync(this.socket);
    let physical;
    try { physical = this.inspectEndpoint(); } catch { throw new Error('endpoint_custody_changed'); }
    if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || !sameFile(dir, this.directoryIdentity) ||
        !sameFile(socket, this.socketIdentity) || physical.path !== this.physicalPath ||
        !sameFile(physical.identity, this.physicalIdentity)) throw new Error('endpoint_custody_changed');
  }
  source({ inspectRuntime = false } = {}) {
    this.assertCustody();
    const owner = this;
    const client = new class extends UnixCodexSession {
      async connect() {
        owner.assertCustody();
        await super.connect();
        try {
          owner.assertCustody();
          if (realpathSync(this.init.codexHome) !== owner.home) throw new Error('provider_home_mismatch');
        } catch (error) { this.close(); throw error; }
      }
      async snapshot() {
        owner.assertCustody();
        const result = await super.snapshot();
        owner.assertCustody();
        return result;
      }
    }(this.home, this.physicalPath, { timeoutMs: this.timeoutMs, inspectRuntime });
    // This fact is deliberately insufficient for ProviderLimitListener native
    // authorization. It cannot be upgraded by a caller-supplied seat name.
    client.binding = Object.freeze({ kind: 'task-owned-app-server', nativeSeatBound: false,
      eventScope: 'thread-subscribed-connections', processId: this.child.pid });
    this.clients.add(client);
    return client;
  }
  async stop() {
    for (const client of this.clients) client.close();
    this.clients.clear();
    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      // Only this child's newly-created process group, never an existing daemon.
      const exit = once(child, 'exit').catch(() => {});
      let deadline;
      try {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
        await Promise.race([exit, new Promise(resolve => { deadline = setTimeout(resolve, 2000); })]);
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          await exit;
        }
      } finally { clearTimeout(deadline); }
    }
    if (this.directory) {
      // Native SIGTERM may leave its physical socket/lock. Only exact files
      // recorded from this owned launch may be removed after process exit.
      if (this.physicalPath && this.physicalPath !== this.socket) {
        for (const [path, identity] of [[this.physicalPath, this.physicalIdentity], [this.physicalPath + '.lock', this.lockIdentity]]) {
          if (!identity) continue;
          try { if (sameFile(lstatSync(path), identity)) unlinkSync(path); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      // Refuse to remove a replacement/unknown directory, even at our old path.
      try {
        if (sameFile(lstatSync(this.directory), this.directoryIdentity)) rmSync(this.directory, { recursive: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.child = null;
    this.cleanupReport = {
      ownProcessStopped: !child?.pid || child.exitCode !== null || child.signalCode !== null,
      taskDirectoryAbsent: !this.directory || !existsSync(this.directory),
      ownedPhysicalEndpointAbsent: !this.physicalPath || !existsSync(this.physicalPath),
    };
  }
}
