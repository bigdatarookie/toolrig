import { readFileSync } from 'node:fs';
import { configuredService } from './config.js';
import { ProviderLimitListener } from './events.js';

// Explicit native-owner invocation only. Not installed/started by Hub status or
// MCP calls, and not a global observer of other seats' app-server connections.
const service = configuredService();
let listener;
try {
  const path = process.argv[2];
  if (!path) throw new Error('continuation_required');
  listener = new ProviderLimitListener(service, JSON.parse(readFileSync(path, 'utf8')));
  listener.on('result', result => console.log(JSON.stringify(result)));
  listener.on('diagnostic', result => console.error(JSON.stringify(result)));
  process.once('SIGTERM', () => listener.stop());
  process.once('SIGINT', () => listener.stop());
  await listener.start();
  await listener.finished;
  if (listener.failure) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ error: 'provider_event_listener_unavailable' }));
  process.exitCode = 1;
} finally { listener?.stop(); await listener?.idle(); service.store.close(); }
