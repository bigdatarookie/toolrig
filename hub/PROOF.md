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

Initial event candidate npm test on Node24.22.1/macOS: 34 passed (24 original + ten event fixtures).
Fixtures include actual stdio protocol transport with a fake provider and native
queue runner; no live provider event or park is implied. Evidence and exact
limits are [EVENTS.md](EVENTS.md). Independent review accepted the correction
recorded below; all four exact-SHA macOS/Ubuntu CI checks passed. Native-seat
account/stream binding, production wake and useful continuation remain NOT RUN;
no full READY publication.

## Event review correction

Reviewer found that ordinaryUsageAllowed=false could authorize the event path
with missing current required quota details if another permitted account had a
valid reset. A two-account regression reproduced native fixture show/block calls
instead of no wake. Confirmation now requires each current required bucket to
have observed windows and every returned window/individual-limit percentage to
be known and in range. The added fixture covers missing bucket/window, unknown
or invalid percentage, missing additional required bucket and another account's
valid reset. It fails on e6b157c and passes after correction; all 35 tests passed
on Node24/macOS. Global quota policy/status and the live/production boundaries
remain unchanged. verification.qa accepted exact corrected candidate
bd041120d446349b9cf0b796322a38090d8d2d80; [PR #6](https://github.com/bigdatarookie/toolrig/pull/6)
merged at 2026-11-12T17:36:41Z as fb66090ed0f3c21aa286dce8121ebf036ead8fd9.
GitHub's PR endpoint independently confirmed merged=true and these exact SHAs.
The reviewer inspected the candidate and all four passing exact-SHA CI checks;
the author ran the 35-test suite, and the reviewer did not rerun it. This accepts
the bounded code/fixture increment, not a live provider/native-seat binding,
production wake, useful continuation or full availability READY claim.

## v0.3 binding investigation and implemented canary

User assignment qitem-toolrig-v03-availability-binding-20261113 supersedes the
old maintainer-discovery human wait; ordinary source/API research continued.
Installed OpenRig source explains per-seat --no-daemon isolation. Matching
official Codex rust-v0.166.0 source at 6ff1e1ca establishes embedded-session
transport and thread-scoped quota delivery. [BINDING.md](BINDING.md) links exact
source and gives the prepared dedicated-backend/native-TUI launch/relay design.

Actual public Unix canary succeeded at 2026-11-12T18:37:30.333Z / 2026-11-13
01:37:30 Asia/Bangkok: two independent read clients on one task-owned app-server
returned the same backend accountId. The native protected alias and WebSocket
transport were validated. It reported nativeSeatBound=false, no native thread
start, zero observed quota events and no production wake. Its own process,
task directory and recorded physical endpoint were confirmed cleaned. This is
a real transport/account-scope attempt, not existing native-seat binding or a
quota exhaustion test. Initial alias and raw-proxy failures changed the adapter
to the source-confirmed protocol; no arbitrary socket was attached.

Support used native-binding-plan at 2026-11-12T18:39:23Z and obtained its own
coordination-support seat, recorded embedded mode and concrete launch seam;
receipt qitem-20261112184011-18ba54ff. Home metadata remained explicitly distinct
from actual native account proof. Consumer source inspection caught eager
metadata DB initialization in the CLI; a failing filesystem regression proved
it, and lazy diagnostic dispatch now avoids opening/chmod/schema initialization.
The diagnostic also now returns explicit source and observation timestamps.

Support rechecked exact committed b9fdeca at 2026-11-12T18:47:04.825Z: correct
coordination-support identity/source/time and a task-owned nonexistent metadata
DB/parent both remained absent before and after the call. Receipt
qitem-20261112184751-07846b8f confirms the useful diagnostic without provider or
native-state access. This is diagnostic adoption, not native transport migration.

Author checks: 43 tests passed on Node24.22.1/macOS; npm audit zero vulnerabilities.
New checks cover default/caller-claimed/Promise binding refusal, binding revoked
before park, real WebSocket-over-Unix fixtures, protected alias custody/cleanup,
endpoint replacement refusal, own-seat-only lookup and no diagnostic DB writes.
The default event listener cannot reserve/arm a native wait without the runtime
owner's verifier; matching home/account cannot stand in for a native attachment.
Working read/limits/selection are not gated on that missing integration.

Remaining exact operation is an owner-controlled OpenRig opt-in launch/relay
source candidate, then a reviewed managed deployment/safe native-resume cutover.
No installed/running daemon patch, seat restart, account/auth/model/effort or
permission change occurred. Native seat binding, natural live quota event,
production wake, reset-to-useful-continuation and cohort preservation remain
NOT RUN/unproven. The canary did not start a thread or duplicate a working seat;
fork/artifact rebuild are not reported as native resume. Continued ownership is
the operator recovery parent qitem-toolrig-v03-recovery-operator-20261113, with
the v0.3 child retaining the exact engineer handoff. No full READY claim.

## v0.3 CI portability correction

macOS CI on b9fdeca timed out waiting for direct Unix socket creation while the
protected-alias case passed. A fixture suppressing filesystem notifications
reproduced that timeout. Startup readiness now has a bounded metadata check
alongside fs.watch and terminates at ready/failure/deadline; it does not poll
quota or install a scheduler. All 44 tests pass locally after correction. The
same committed-candidate Support diagnostic remains applicable: its code did
not change in this readiness correction. Latest exact-SHA CI must be assessed
by the assigned reviewer before merge; a failed earlier run is not reported green.

## Offline native launch/relay source increment after PR #9

Native hooks, dedicated backend launch, authenticated sole-TUI relay and revocable
internal verifier are implemented as an opt-in source candidate. No installed
adapter, daemon, account/home, existing seat or original conversation was changed.
Author local suite: 54/54; nine new source fixtures cover launch identity,
original resume, same-backend snapshot/event provenance, denied second owner,
drift revocation, generation lease and existing reserve/pre-park continuation.
The first fixture run exposed an incorrect undefined-vs-null assertion after
revocation; corrected the assertion to the implemented revoked state. No provider
inference/thread/turn or actual native queue park occurred. Exact baseline patch,
launch/deployment contract and residual native proofs: NATIVE-LAUNCH.md.
