# Native state baseline and delta (v0.7)

This deterministic read-only tool compares bounded metadata projections from
supported `rig` JSON commands. It creates no queue, tracker, scheduler or native
state changes and calls no model. Availability is independent.

## Invocation

From an existing native OpenRig seat (Node24):

```
node /ABS/TOOLRIG/hub/src/state-cli.js --rig toolrig --project toolrig --filter active
node /ABS/TOOLRIG/hub/src/state-cli.js --rig toolrig --project toolrig --filter active --cursor OPAQUE
```

Add `--seat tools-hub@toolrig` for one destination; `--filter all` retains terminal
records in the baseline. Explicit project matches a native `project:<value>`
tag OR `targetRepo`. It is not a guessed working-directory/project membership.
Seats are rig context, not asserted project membership. Optional seat narrows
both returned seats and assigned tasks. Immediate parent is native handedOffFrom;
higher chain is not read. Summary is native metadata, bounded to200 characters
with an explicit truncation marker; no inferred next action.

The same engine is SDK tool `state_snapshot` in the existing stdio Hub:
`{rig,project,filter:{states:'active'|'all',seat?},cursor?}`. Identity comes from
native whoami in the server's own seat environment, never an MCP consumer label.
Use one stdio process per native consumer. Shared multi-consumer transport is not
claimed. State discovery/calls do not initialize the Availability store.

## Scope, sources and failure semantics

The native queue-list CLI has no explicit --rig. This version verifies requested
rig against native whoami and rejects other rigs. It never changes identity env
or silently widens to --all-rigs. Do not impersonate a different seat to use it.
Commands are fixed argv (no shell): whoami, --version, ps --nodes --rig ...
--no-cleanup with metadata fields, queue list --all --limit1000 --json (plus
--destination for a seat filter). No bodies, full queue records, transcripts,
provider credentials/native DBs, captures, mutation commands or transition logs.
Returned source commands/UTC timestamps support expansion; queue show and seat
status are explicit separate consumer actions, not executed by this tool.

Baseline includes observedAt/sources/coverage and an opaque cursor. Subsequent
same-scope reads produce added/changed/removed field differences; unchanged
returns ONLY changed=false, observedAt, coverage and cursor. Source/cost/status
envelopes remain on baseline, delta and partial paths; transport exit0 and MCP
success do not require a status field on the compact unchanged response. Removed means absent from
the selected projection, NEVER confirmed native deletion. Active-filter departures
and newly observed terminal/handoff/source-tagged human-gate records also appear
in critical. Human intent or a tag alone is not proof of a real human destination;
that uncertainty is labelled. Cancel/fail/complete/handoff/stop remain visible.

Native reads are independent, non-atomic. Intermediate states between calls can
be unobserved; current-state comparison is not a complete event history. A source
record's old updatedAt is not proof a fresh source read is stale. Server snapshot
age has no exposed atomic/asOf token and is UNKNOWN; activity staleness/unknown is
explicit. Blocker owner is joined only when the blocker is in returned native
metadata; blocker start/age are UNKNOWN because compact list omits transitions.
Seat-filtered reads may lack an external blocker's owner. No guess from creation
age or a typed blocker string is returned as an owner/time fact.

Malformed/unavailable sources, incompatible schema or truncation/cap produce
status=partial, changed=null, no delta or cursor advancement. Known partial
baseline remains inspectable; prior cursor remains usable. A cache failure also
cannot claim unchanged. Missing/expired/incompatible/corrupt cursor produces
reset_required and a fresh baseline on a complete read. CLI exit0=ok,2=partial,
1=invalid request/identity/scope failure. Raw stderr/payload errors are not echoed.

## Cursor cache

Immutable random handles are bound to native consumer, exact rig/project/filter,
projection schema and native source version. They grant no authority. Private
per-consumer comparison files live below ~/.cache/toolrig/state-v1, optional
trusted launch setting TOOLRIG_STATE_CACHE_DIR. Default TTL24h; at most128 files
per consumer, at most4MiB per projection. Atomic publication, integrity check,
owner/mode validation and refusal of symlink cursor files guard corruption and
cross-consumer mixing. Eviction/loss causes reset, not loss of native work.
This cache can be discarded; it is never a source of task status or permissions.

## Acceptance and measurement

Author fixtures cover baseline/unchanged, task/activity/blocker/owner changes,
terminal/filter removals, critical final states, parent refs, isolated consumers,
TTL/version/filter/lost/corrupt cursors, partial/invalid/capped sources and SDK
roundtrip without Availability DB creation. Real source-stage proof uses this
assignment's ordinary review handoff/park; no fake task is created for a delta.
Source acceptance and actual Support consumer adoption are separate outcomes.

Measurement records response bytes and explicitly labelled estimates, source
calls/elapsed and correctness on matching scope/state. Four native calls per
CLI invocation are a real cost; this can be worse than a small queue read.
Response reduction is not measured whole-prompt/provider billing savings.
Provider usage, setup/author/reviewer/Support model cost and amortization remain
UNKNOWN unless independently measured. Native activity output can dominate a
narrow work query. Prefer the existing consumer workflow if this is a net loss.
