import { OwnedAppServer } from './owned-server.js';
import { normalize } from './policy.js';

// No native thread resume/start/turn, no live seat attachment, no account switch.
if (!process.env.CODEX_HOME) throw new Error('explicit_existing_codex_home_required');
const runtime = new OwnedAppServer(process.env.CODEX_HOME);
let stage = 'launch';
let result;
try {
  await runtime.start();
  const ownerClient = runtime.source();
  const observerClient = runtime.source();
  let quotaEvents = 0;
  for (const client of [ownerClient, observerClient]) client.on('notification', message => {
    if (message.method === 'account/rateLimits/updated') ++quotaEvents;
  });
  stage = 'owner_client_initialize';
  await ownerClient.connect();
  stage = 'observer_client_initialize';
  await observerClient.connect();
  stage = 'account_snapshot';
  const first = normalize(await ownerClient.snapshot());
  const second = normalize(await observerClient.snapshot());
  if (!first.accountId || first.accountId !== second.accountId) throw new Error('account_scope_unconfirmed');
  result = { kind: 'task-owned-public-transport-canary', accountId: first.accountId,
    source: first.source, observedAt: first.observedAt, observedAtBangkok: first.observedAtBangkok,
    sameServerAccountAcrossClients: true, home: first.home, nativeSeatBound: false,
    privateEndpointCustody: true, nativeThreadStarted: false, naturallyObservedQuotaEvent: quotaEvents > 0,
    quotaEventCount: quotaEvents,
    eventScope: 'thread-subscribed-connections; not proven by account read',
    noProductionWake: true };
} catch (error) {
  const safeCodes = ['owned_app_server_unavailable', 'unsafe_endpoint', 'endpoint_custody_changed',
    'owned_app_server_not_running', 'provider_unavailable', 'provider_rpc_error', 'provider_home_mismatch', 'account_scope_unconfirmed'];
  console.error(JSON.stringify({ error: 'binding_canary_failed', stage,
    code: safeCodes.includes(error.message) ? error.message : 'local_transport_error',
    endpoint: runtime.endpointDiagnostic ?? null, nativeSeatBound: false }));
  process.exitCode = 1;
} finally { await runtime.stop(); }
if (result) console.log(JSON.stringify({ ...result, cleanup: runtime.cleanupReport }, null, 2));
