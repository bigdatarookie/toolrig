import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const token = /^[a-f0-9]{48}$/;
const safe = s => s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0;
// Bounded immutable comparison cache only. No tasks, transitions or queue writes.
export class CursorCache {
  constructor(root, { ttlMs = 24 * 3600000, maxEntries = 128, clock = Date.now } = {}) {
    Object.assign(this, { root, ttlMs, maxEntries, clock });
  }
  directory(consumer) {
    const path = join(this.root, hash(consumer));
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077) !== 0) throw new Error('unsafe_cursor_directory');
    return path;
  }
  read(cursor, consumer, binding) {
    if (!token.test(cursor)) return { reason: 'missing_or_invalid_cursor' };
    try {
      const path = join(this.directory(consumer), cursor + '.json');
      const s = lstatSync(path);
      if (!safe(s) || s.size > 4 * 1024 * 1024) return { reason: 'cursor_invalid' };
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      if (entry.consumer !== consumer || entry.binding !== binding || !entry.selected?.tasks || !entry.selected?.seats ||
          !object(entry.selected.tasks) || !object(entry.selected.seats) || !object(entry.allTasks) ||
          entry.integrity !== hash(JSON.stringify({ selected: entry.selected, allTasks: entry.allTasks })) || typeof entry.createdAt !== 'number') return { reason: 'cursor_incompatible' };
      if (this.clock() < entry.createdAt || this.clock() - entry.createdAt >= this.ttlMs) return { reason: 'cursor_expired' };
      return { entry };
    } catch { return { reason: 'cursor_missing_or_unreadable' }; }
  }
  save(consumer, binding, selected, allTasks) {
    const directory = this.directory(consumer), cursor = randomBytes(24).toString('hex');
    const integrity = hash(JSON.stringify({ selected, allTasks }));
    const data = JSON.stringify({ consumer, binding, createdAt: this.clock(), selected, allTasks, integrity });
    if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new Error('cursor_projection_too_large');
    const part = join(directory, cursor + '.partial'), path = join(directory, cursor + '.json');
    writeFileSync(part, data, { mode: 0o600, flag: 'wx' }); renameSync(part, path);
    const files = readdirSync(directory).filter(n => /^[a-f0-9]{48}\.json$/.test(n)).map(name => {
      const file = join(directory, name), stat = lstatSync(file); return { file, stat };
    }).filter(f => f.file !== path && safe(f.stat)).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (let i = 0; i < files.length; i++) {
      const { file, stat } = files[i];
      if (i >= this.maxEntries - 1 || this.clock() - stat.mtimeMs > this.ttlMs) unlinkSync(file);
    }
    return cursor;
  }
}
