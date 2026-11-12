// Explicit opt-in source entry point. Imports have no launch effect.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NativeSeatRuntime } from './native-runtime.js';
import { configuredService } from './config.js';
export async function main(payload) {
  let service;
  const runtime = new NativeSeatRuntime(JSON.parse(Buffer.from(payload, 'base64url').toString()), {
    onAttached: async owner => {
      const s = owner.spec;
      if ((process.env.TOOLRIG_PROJECT && process.env.TOOLRIG_PROJECT !== s.project) ||
          (process.env.TOOLRIG_MODEL && process.env.TOOLRIG_MODEL !== s.model)) throw new Error('native_service_context_drift');
      service = configuredService({ project: s.project, model: s.model });
      if (service.home !== realpathSync(s.home) || service.seat !== s.seat || service.project !== s.project || service.model !== s.model) {
        throw new Error('native_service_configuration_mismatch');
      }
      await owner.listen(service, { seat: s.seat, qitem: s.qitem, conversationId: s.threadId, cwd: s.cwd,
        configRef: s.configRef, permissions: s.permissionsRef, model: s.model, effort: s.effort, affectedCohort: s.affectedCohort });
    },
  });
  const stop = () => { runtime.stop().catch(() => {}); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await runtime.start();
    await new Promise(resolve => { if (runtime.revoked) resolve(); else runtime.once('revoked', resolve); });
  } finally {
    await runtime.stop(); service?.store.close(); process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(() => { console.error('native_launch_failed; no automatic retry'); process.exitCode = 1; });
}
