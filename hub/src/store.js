import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const name = z.string().min(1).max(500);
export const registryEntry = z.strictObject({
  accountId: name, authorized: z.boolean(), authRef: name.nullable(),
  authState: z.enum(['ready', 'unknown', 'invalid']),
  grants: z.array(z.strictObject({ project: name, model: name, requiredBuckets: z.array(name).min(1) })),
});
export const continuation = z.strictObject({
  seat: name, qitem: name, conversationId: name, cwd: name,
  configRef: name, permissions: name, model: name, effort: name,
  affectedCohort: z.array(name).min(1),
});

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS registry (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, home TEXT NOT NULL,
        active INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_transition_per_home ON operations(home) WHERE active=1;`);
  }
  close() { this.db.close(); }
  register(entry) {
    const safe = registryEntry.parse(entry);
    this.db.prepare('INSERT OR REPLACE INTO registry VALUES (?,?)').run(safe.accountId, JSON.stringify(safe));
  }
  entries() { return this.db.prepare('SELECT value FROM registry ORDER BY id').all().map(r => JSON.parse(r.value)); }
  observe(snapshot) {
    if (!snapshot.accountId) return;
    this.db.prepare(`INSERT INTO snapshots VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value
      WHERE json_extract(excluded.value,'$.observedAt') >= json_extract(snapshots.value,'$.observedAt')`)
      .run(snapshot.accountId, JSON.stringify(snapshot));
  }
  snapshots() { return Object.fromEntries(this.db.prepare('SELECT id,value FROM snapshots').all().map(r => [r.id, JSON.parse(r.value)])); }
  pending(home) {
    const row = this.db.prepare('SELECT value FROM operations WHERE home=? AND active=1').get(home);
    return row ? JSON.parse(row.value) : null;
  }
  markWake(id, state) {
    this.db.prepare(`UPDATE operations SET value=json_set(value,'$.wake',?) WHERE id=? AND active=1`).run(state, id);
  }
  claimWake(id) {
    return this.db.prepare(`UPDATE operations SET value=json_set(value,'$.wake','arming')
      WHERE id=? AND active=1 AND json_extract(value,'$.wake') IS NULL`).run(id).changes === 1;
  }
  reserve(home, decision, context, now = Date.now()) {
    continuation.parse(context);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.pending(home);
      if (previous) {
        if (!previous.waiters.some(c => c.seat === context.seat && c.qitem === context.qitem)) previous.waiters.push(context);
        this.db.prepare('UPDATE operations SET value=? WHERE id=?').run(JSON.stringify(previous), previous.id);
        this.db.exec('COMMIT'); return { ...previous, joined: true };
      }
      const op = { id: randomUUID(), home, decision, continuation: context,
        waiters: [context], createdAt: new Date(now).toISOString(), state: 'pending', wake: null };
      this.db.prepare('INSERT INTO operations VALUES (?,?,1,?)').run(op.id, home, JSON.stringify(op));
      this.db.exec('COMMIT');
      return op;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(id, evidence) {
    const row = this.db.prepare('SELECT value FROM operations WHERE id=? AND active=1').get(id);
    if (!row) throw new Error('operation_not_pending');
    const op = JSON.parse(row.value);
    if (evidence.accountId !== op.decision.target || evidence.nativeVerdict !== 'moved' ||
        !evidence.usefulToolTurn || !Number.isFinite(Date.parse(evidence.observedAt)) ||
        Date.parse(evidence.observedAt) <= Date.parse(op.createdAt)) {
      throw new Error('continuation_not_verified');
    }
    const complete = { ...op, state: 'completed', evidence };
    this.db.prepare('UPDATE operations SET active=0,value=? WHERE id=?').run(JSON.stringify(complete), id);
    return complete;
  }
}
