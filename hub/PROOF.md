# Availability candidate evidence — 2026-11-12

Scope: canonical v0.2 baseline f8028e8; parent assignment
qitem-20261112161037-7c058ff82cad95df. This is implementation/consumer evidence,
not overall availability acceptance or live-switch proof.

## Author checks

Node 24.22.1 on macOS. Initial candidate npm test: 22 tests passed, including full MCP SDK discovery
and invocation, permitted policy 5/0, multi-window/bucket reset selection,
staleness/unknown/provider denial, secret-field exclusion, separate concurrent
processes joining one operation, persisted native continuation after restart,
native wake lost-response reconciliation, provider timeout/spawn failure, and
configured-home/consumer-context refusal. npm audit after pinning Zod 4.6.7:
zero vulnerabilities. The original exact candidate 517337a passed macOS/Linux
CI and independent review; PR #1 merged as 893ec3f on 2026-11-12. Linux runtime
verification is NOT RUN locally. Event-increment CI is recorded separately.

## Supported capability observations

Installed Codex 0.166.0 generated protocol and actual read-only stdio RPC
initialize, account/read(refreshToken=false), account/rateLimits/read(null).
The response contains accountId, ordinaryUsageAllowed and usedPercent/window
duration/resetsAt. Observation at 2026-11-12T16:18:39.691Z showed raw usedPercent=1,
remainingPercent=100-1=99, windowDurationMins=10080, reset UTC
2026-11-19T12:02:04Z. Provider observation timestamp was absent and stays null;
workspaceName was null. A second window was not represented. These are quota
observations, not token/context usage. No account selection or transition was
triggered by this observation.

account/rateLimits/updated exists in the generated notification schema and
describes sparse rolling updates. An actual live notification was NOT OBSERVED;
the sparse-notification fixture is not a live subscription claim.

OpenRig 0.7.7: provider status/accounts/bindings/signals/precheck/switch/moves;
seat restart --plan/--keep-conversation/--verify; queue block --wake-after;
watchdog register/list/show/status. Read-only provider status showed no bound
accounts/signals, usage_windows disabled. It was not enabled or changed. auth
list returned no saved profiles. macOS restart plan for the selected consumer
refused process settings observation because the observer uses Linux /proc.

## Independent real consumer effect

coordination-support@toolrig invoked MCP availability_status using the SDK
client, exit 0. Source and effect are in native receipt
qitem-20261112161932-cf64d7e7 (successor to qitem-20261112161850-b7fe48218d2c01ca).
Consumer observation 2026-11-12T16:19:07.682Z / 23:19:07 Asia/Bangkok:
usedPercent=1 -> remainingPercent=99, ordinaryUsageAllowed=true, accountId
returned, workspaceName=null, permittedAccountCount=0, no pending operation.
It obtained structured provider identity/quota/reset without login, restart,
account mutation, credential/native-file inspection or forced exhaustion.
The consumer independently confirms invocation, not tools/list discovery; the
author SDK integration test covers discovery. Status-client now lists tools
before calling, and the affected test remains passing.

Identity scope is a fresh app-server reading the configured shared home. The
already-running consumer seat's actual cached account remains UNATTESTED.

## Limits and metrics

Live cross-account canary: NOT RUN. Missing: second provided compatible account,
supported macOS seat isolation/retarget and native continuity attestation.
Live native wake/reset-to-useful-continuation: NOT RUN. The deterministic native
park path is fixture-tested, not armed against a production quota or made-up
exhaustion. Live native-seat event hookup and safe auth/restart execution remain
integration gaps. An event adapter now has the fixture evidence below;
cohort/conversation/qitem/config/model/effort/permissions
preservation through an actual account move is NOT PROVEN. No capacity agent,
cron, model change or manual native-file editing was introduced.

Reset-to-useful-continuation time and downtime are unmeasured, not zero. No new
human intervention was requested for the author/consumer calls. No exact quota
or token cost is attributed to them. Original review/merge is recorded above;
a working read-only consumer and fixtures do not close the full v0.2 outcome.

## Review correction

Independent reviewer requested changes on 99d1b25: at current 0/provider-blocked,
a permitted target with confirmed positive 1–5% was excluded, causing a wait on
an exhausted target instead. Two new focused tests reproduced wait/gap instead
of transition_required before the correction. Policy now allows that low target
when the current account is blocked, retains its warning/remaining percentage
in targetAvailability, and still rejects unknown/stale/denied targets. Updated
suite: 24 tests passed on Node24/macOS. The original live consumer path is
unchanged; its receipt is not replayed as account-switch proof.

## Event adapter increment

Assignment qitem-20261112171242-2278e2d38336c5a6, branch feat/availability-events,
base accepted merge 893ec3f. Public notification and snapshot schema inspected;
no naturally occurring notification or native stream was observed/attached.
Implemented event invalidation -> full read -> confirmed provider-blocked policy
-> existing operation/owned-qitem wake adapter. Connection/read failure requires
an explicit reconnect; no polling loop or production timer was installed.

npm test on Node24.22.1/macOS: 34 passed (24 original + ten event fixtures).
Fixtures include actual stdio protocol transport with a fake provider and native
queue runner; no live provider event or park is implied. Evidence and exact
limits are [EVENTS.md](EVENTS.md). Independent review and new exact-SHA CI are
pending for this increment. Native-seat account/stream binding, production wake
and useful continuation remain NOT RUN; no full READY publication.
