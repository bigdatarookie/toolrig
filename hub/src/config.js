import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { CodexReader } from './codex.js';
import { AvailabilityService } from './service.js';

// Trusted launch configuration, never caller-supplied MCP arguments. Stdio
// inherits the OS user's authority; it is not an OS sandbox for YOLO neighbors.
export function configuredService() {
  const home = resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'));
  const store = new Store(process.env.TOOLRIG_AVAILABILITY_DB ?? resolve(homedir(), '.local/state/toolrig/availability.sqlite'));
  return new AvailabilityService({ reader: new CodexReader(home), store, home,
    seat: process.env.OPENRIG_SESSION_NAME ?? 'local-cli',
    project: process.env.TOOLRIG_PROJECT ?? null, model: process.env.TOOLRIG_MODEL ?? null });
}
