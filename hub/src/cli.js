import { readFileSync } from 'node:fs';
import { configuredService } from './config.js';
import { recoveryPlan, armWake } from './native.js';

const service = configuredService();
try {
  const [command, path] = process.argv.slice(2);
  let result;
  if (command === 'status') result = await service.status();
  else if (command === 'register' && path) {
    service.store.register(JSON.parse(readFileSync(path, 'utf8')));
    result = { registered: true };
  } else if (command === 'request' && path) result = await service.request(JSON.parse(readFileSync(path, 'utf8')));
  else if (command === 'pending') result = service.store.pending(service.home);
  else if (command === 'arm-wake') result = await armWake(service.store, service.home, service.seat);
  else if (command === 'recovery-plan') {
    const op = service.store.pending(service.home);
    result = op ? recoveryPlan(op) : { pending: false };
  } else throw new Error('usage: status | register <grant.json> | request <continuation.json> | pending | recovery-plan | arm-wake');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Provider and validation bodies can contain private inputs: print codes only.
  console.error(JSON.stringify({ error: error.message?.startsWith('usage:') ? error.message : 'availability_request_failed' }));
  process.exitCode = 1;
} finally { service.store.close(); }
