# Tool Hub availability

Availability is a service module exposed through the official MCP SDK and the
same CLI implementation. It uses supported Codex app-server read RPCs. It does
not open provider credential/session/transcript databases, call a model, consume
reset credits, modify login state, or run a scheduling loop.

Node 24 is required (tested locally with 24.22.1); SDK 1.32.2 and Zod 4.6.7 are
locked in package-lock.json. Install and run from this directory:

```sh
npm ci --ignore-scripts
npm test
node src/cli.js status
node src/status-client.js
node src/cli.js native-binding-plan
```

The final command discovers and calls availability_status through an MCP client.
For another MCP client, launch node with the absolute path to src/mcp.js using
stdio transport. There is no unauthenticated HTTP listener. The child process
inherits trusted launch configuration:

| Variable | Meaning |
| --- | --- |
| CODEX_HOME | Configured provider home; defaults to the user's .codex |
| OPENRIG_SESSION_NAME | Consumer label inherited from native launch |
| TOOLRIG_PROJECT | Exact project grant for policy requests |
| TOOLRIG_MODEL | Existing model for exact grant lookup; never changed |
| TOOLRIG_AVAILABILITY_DB | Local operation/registry metadata file; defaults to ~/.local/state/toolrig/availability.sqlite |

Stdio authority is the launching OS user, not text supplied in tool arguments.
MCP callers cannot register accounts, choose another home, or change the bound
seat/project/model. These grants do not sandbox other processes under that same
OS user. A remote/cloud transport needs its own authenticated binding before it
can expose these operations.

`availability_status` reports the account returned by a **fresh app-server on
the configured home**. This does not prove an already-running Codex seat has
reloaded that account. AccountId is the backend's quota scope identifier;
workspaceName may be unavailable. No provider observation timestamp is returned
by this installed protocol, so providerObservedAt stays null. Client observation
times are explicit UTC, with an Asia/Bangkok rendering. Source usedPercent is
preserved; remainingPercent is exactly 100 minus usedPercent. These are quota
windows, not context-window or cumulative token usage.

## Documents MCP adapter

The same stdio Hub can optionally expose the existing Toolrig Documents CLI
and deterministic CSV reader. Set `TOOLRIG_DOCUMENTS_ROOT` to enable
`documents_extract_csv`; also set `TOOLRIG_DOCUMENTS_CLI` to register
`documents_inspect`, `documents_read`, `documents_render`, and
`documents_extract_tables`:

| Variable | Meaning |
| --- | --- |
| TOOLRIG_DOCUMENTS_CLI | Absolute path to the trusted `toolrig-documents` executable |
| TOOLRIG_DOCUMENTS_ROOT | Absolute directory containing documents the consumer may read |
| TOOLRIG_DOCUMENT_ARTIFACT_DIR | Optional absolute directory for task-owned output artifacts; defaults to a unique temporary directory |

Each call takes an absolute path under that root. The adapter resolves both
paths, rejects symlink/path escapes, invokes the CLI without a shell, and
returns its structured JSON result. Calls have a 75 second timeout and 1 MiB
output limit. Tools can create task-owned artifacts for rendered pages or
oversized results, but do not mutate source documents. Artifacts stay outside
the configured document root by default and use the configured output directory
when supplied.

Without a configured root the Hub does not advertise document tools. Stdio still
runs with the launching OS user's authority; a configured root is an adapter
boundary, not an OS sandbox against other processes running as that user.

`documents_extract_csv` returns exact string cell values and CSV record
locators. It never casts identifiers, dates, units, or numbers. A caller may
name one ticker column to receive a separate value with surrounding whitespace
trimmed; the original cell remains in `values` unchanged.

For optional local Qwen compaction on `documents_read`, configure
`TOOLRIG_QWEN_API_KEY` and `TOOLRIG_QWEN_MODEL` in the trusted Hub environment.
Optional endpoint overrides are `TOOLRIG_QWEN_API_URL` and
`TOOLRIG_QWEN_HEALTH_URL`; both must remain HTTP loopback URLs. Compaction is
opt-in per call and requires an explicit source eligibility attestation, a
question, locators, at least 8000 extracted `o200k_base` tokens, and a known
consumer window budget. Busy gateways, errors, invalid output, or an unknown
budget leave the extracted source untouched and report a direct-source reason.
The Qwen credential is sent only to the configured loopback endpoint and is
removed from the document CLI child environment.

## CI error digest

The Hub also exposes `ci_digest` over the same implementation as the CLI. It
reads a GitHub Actions run, its exact attempt and jobs, failed step names,
structured check annotations, and at most 512 KiB of a failed job log when the
annotation does not identify a specific error. It never reruns, cancels, edits,
or merges a workflow. Running jobs are refreshed on every call. An explicit
older attempt, a run associated with a different PR head, or a missing selected
job is reported as stale/partial rather than current success.

Run it from this directory:

```sh
node src/ci-digest-cli.js digest --repo owner/name --run 123456789 --attempt 1
node src/ci-digest-cli.js digest --repo owner/name --run 123456789 --pr 42 --json
```

The `ci_digest` MCP tool accepts `repository`, `run_id`, and optional `attempt`,
`job_id`, and `pull_request`. Set `GH_TOKEN` or `GITHUB_TOKEN` in the Hub's
trusted launch environment when the repository requires authentication; tokens
are never accepted as tool arguments or returned in the result. `TOOLRIG_GITHUB_API_URL`
is an optional HTTPS API base override for compatible GitHub installations.
The service does not make an unauthenticated HTTP listener.

Results distinguish queued, running, success, failure, canceled, skipped, and
unknown states. Unknown log formats remain `UNKNOWN` with the job URL for
expansion; the digest does not infer a cause from an exit code. Exact duplicate
findings are grouped with a count and bounded source references. Excerpts are
bounded and redact common token, private-key, password, and email patterns;
redaction is best effort, so consumers should continue treating logs as
untrusted input. Raw logs are never cached. Sanitized final findings may be
cached under `TOOLRIG_CI_CACHE_DIR` (defaults to `~/.cache/toolrig/ci-digest`)
with owner-only directory/file permissions. Cache identity includes repository,
run, attempt, head SHA, job, check run, and completion time.

Jobs and check annotations follow GitHub's `Link` pagination, with a maximum of
10 pages × 100 entries per endpoint. Pagination links must stay on the
configured API origin. If a page is omitted, malformed, repeats, or the API's
reported job count exceeds the returned pages, `partial` is true and the
coverage fields report that the attempt or annotations are incomplete. The
service never silently treats the first page as the whole run.

One digest call also caps all REST requests at 100 and all response bodies
(including logs) at 20 MiB total. When either budget is exhausted, further
failed-job diagnostics are marked `skipped_operation_budget`, coverage is
partial, and the result reports the consumed budget. These limits bound work
across the whole run, not just each endpoint or log individually. Cache format
version 2 invalidates findings written before annotation pagination was added.

Metrics report API call count, fetched response bytes, digest JSON bytes,
elapsed time, cache hits, and a rough output-token estimate (UTF-8 bytes ÷ 4,
not provider billing). This describes the digest result, not whole-rig model
usage or API bandwidth savings.

Real read-only consumer evidence, 2026-11-13: `bigdatarookie/toolrig` run
`43283369853`, attempt 1, head
`b9fdeca54374761bb5593012cdde94ef74163ac9`,
[run link](https://github.com/bigdatarookie/toolrig/actions/runs/43283369853).
The digest returned failure, kept the successful Ubuntu and failed macOS jobs,
identified failed step `Run npm test` and its structured annotation, and marked
job logs `permission_denied`; it did not invent a test cause. Without changing
credentials, a same-run raw REST baseline fetched four endpoint bodies totaling
18,322 bytes, while the current JSON digest is 2,362 bytes (87.11% fewer consumer-facing
bytes than those raw bodies); both paths made four calls. This is a payload
comparison, not a network-call or full-log token-savings claim. The inaccessible
raw log means the actual failing test detail and any comparison against full-log
input remain unmeasured. Invocation used:

```sh
env GH_TOKEN= GITHUB_TOKEN= node src/ci-digest-cli.js digest --repo bigdatarookie/toolrig --run 43283369853 --attempt 1 --json
```

## Permitted pool and policy

The registry starts empty. Observing an account does not grant permission to
switch to it. Only a local authorized operator registers provided account
metadata using `node src/cli.js register grant.json`:

```json
{
  "accountId": "backend-account-id",
  "authorized": true,
  "authState": "ready",
  "authRef": "saved-native-profile-name",
  "grants": [{
    "project": "project-id",
    "model": "existing-model-id",
    "requiredBuckets": ["codex"]
  }]
}
```

AuthRef names existing native authorization; it contains no credential bytes.
Registration does not validate live login or create an account. Required quota
buckets must come from established model applicability, never guessed from a
home path or a display name. Status omits email, balance, reset-credit IDs and
upsell/error bodies. Registry schemas reject extra keys; do not place any secret
in metadata fields. Account snapshots are keyed by backend accountId, so two
homes do not create two quotas. Freshness expires after 120 seconds.

At more than 5% remaining, continue. At <=5%, select an explicitly authorized,
compatible, observed available alternative; with no alternative, continue to 0.
At 0, use an available alternative, otherwise select the earliest **maximum
reset of every exhausted required window** across permitted targets. Unknown,
stale, denied, unprovided or past-reset data never implies available capacity or
a fabricated reset. Elapsed resets require another read; spend/workspace denial
does not borrow an unrelated quota window's reset.

When the current account is exhausted/provider-blocked, confirmed positive 1–5%
on a permitted target is usable before waiting for a reset. The decision retains
that target's low-quota state and remaining percentage in targetAvailability.

For policy requests, call availability_request with a continuation object, or
use `node src/cli.js request continuation.json`:

```json
{
  "seat": "member@rig",
  "qitem": "existing-native-qitem",
  "conversationId": "supported-native-conversation-id",
  "cwd": "/existing/workspace",
  "configRef": "existing-config-reference",
  "permissions": "existing-native-policy",
  "model": "existing-model-id",
  "effort": "existing-effort",
  "affectedCohort": ["member@rig", "other-shared-home-consumer@rig"]
}
```

Continuation references are supplied by the native owner; this module does not
attest them by reading native files. Use native runtime metadata before any
transition. Concurrent requests for the same canonical home join one operation
ID and retain each waiter's native continuation. SQLite transactions/unique
index preserve this across processes and Hub restarts. There are no replacement
tasks, execution ownership records, accounts or agent seats in this database.

## Native recovery boundary

`pending` and `recovery-plan` return saved operation state and supported native
command arguments. `arm-wake` parks the existing native qitem with queue block
and its atomic --wake-after timer. It requires the configured seat to own that
qitem and a future confirmed reset. The operation remains pending after wake.
An indeterminate park response is reconciled with the native queue rather than
blindly retried; simultaneous callers claim the wake atomically. Run another
status/policy observation after wake, then native precheck, supported transition
and verification before releasing any availability blocker. Never retry a
business operation whose effect is unknown.

This candidate **does not execute auth changes, retarget/restart or cohort
transitions**. Native precheck/verification are available as integration helpers;
execution is disabled until supported isolation and the provided pool are proven.
An opt-in public app-server notification adapter is described in [EVENTS.md](EVENTS.md).
It refetches a full snapshot and routes only confirmed blocked state through the
existing native wake adapter. It is not installed on a running native seat, and
its fixture proof is not live event-to-resume proof. Sparse notifications never
overwrite nullable account metadata; status always fetches a full snapshot.

[BINDING.md](BINDING.md) records the implemented v0.3 binding investigation,
working public Unix transport canary and exact owner-side native launch design.
Event routing now also requires a runtime-owner binding verifier, false by
default: an independent app-server cannot authorize a native park as though it
were the running seat. This does not gate configured-home reads or selection.

OpenRig 0.7.7 documents Codex provider switch as Linux-only. On the observed
macOS host, seat restart --keep-conversation --plan refused because cwd/home
inspection uses /proc. No saved alternate profile was listed. Live cross-account
canary, native wake/reset-to-useful-continuation and cohort preservation are
**NOT RUN**; no active neighbor was restarted. A future integration must prove
the actual account, same conversation/qitem/config/model/effort/permissions and
a subsequent useful tool turn; starting a process or reaching a reset is not
that proof.

Installed protocol reference: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
Generate the exact local protocol with codex app-server generate-json-schema;
GetAccountRateLimitsResponse and AccountRateLimitsUpdatedNotification distinguish
full snapshots from sparse rolling updates. Do not assume older Codex versions
have the observed fields.
