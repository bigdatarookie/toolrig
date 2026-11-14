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
tag OR `targetRepo`. Native legacy `tags:null` means no tags; only explicit
`targetRepo` can then match the project. Missing/malformed tags remain invalid. It is not a guessed working-directory/project membership.
Seats are rig context, not asserted project membership. Optional seat narrows
both returned seats and assigned tasks. Immediate parent is native handedOffFrom;
higher chain is not read. Summary is native metadata, bounded to200 characters
with an explicit truncation marker; no inferred next action.

For own/parent obligations without project tags, use explicit owner scope and
optionally exact IDs. Repeat --owner and --id; these are selectors, never an
identity override:

```
node /ABS/TOOLRIG/hub/src/state-cli.js --rig toolrig --project toolrig --filter all \
  --owner coordination-lead@toolrig --owner operator-agent@kernel \
  --id qitem-toolrig-v09-d-inventory-lead-20261114 \
  --id qitem-toolrig-package-d-global-20261114
```

Explicit owners select assigned tasks independently of project tags/targetRepo;
project is then context, not asserted membership. IDs narrow that owner union;
unrelated tasks are excluded. At most8 owners and32 IDs; duplicates/malformed
selectors, IDs without owners, and combining --seat with --owner are rejected.
With no IDs, all matching owner tasks remain subject to the states filter. IDs
also obey that states filter; use all to inspect terminal parents. Immediate
parent references are not discovered by parsing bodies. Supply known parent IDs
and their native owners explicitly. Legacy project-only and --seat behavior
remain unchanged. Null tags (and absent tags in explicit-owner mode) do not hide
owned work; malformed non-null tag types still fail closed.

The same engine is SDK tool `state_snapshot` in the existing stdio Hub:
`{rig,project,filter:{states:'active'|'all',seat?,owners?:string[],ids?:string[]},cursor?}`. Identity comes from
native whoami in the server's own seat environment, never an MCP consumer label.
Use one stdio process per native consumer. Shared multi-consumer transport is not
claimed. State discovery/calls do not initialize the Availability store.

## Scope, sources and failure semantics

The native queue-list CLI has no explicit --rig. This version verifies requested
rig against native whoami and rejects other rigs. It never changes identity env
or silently widens to --all-rigs. Explicit-owner mode uses one supported body-free
queue list --destination read per named owner. Native CLI explicit destinations
disable the implicit current-rig list filter, so a named kernel parent can be read
without a rig dump; this remains local-daemon metadata, not remote-host fanout.
Seat/activity metadata stays limited to the actual consumer rig: external-owner
seat state is unobserved, never inferred stopped. Do not impersonate a different seat to use it.
Commands are fixed argv (no shell): whoami, --version, ps --nodes --rig ...
--no-cleanup with metadata fields, queue list --all --limit1000 --json (plus
--destination for a seat filter or each explicit owner). No bodies, full queue records, transcripts,
provider credentials/native DBs, captures, mutation commands or transition logs.
Each owner read is capped at1000 current records. Missing requested IDs, any cap,
unavailable source, inconsistent owner result or schema failure returns partial,
changed=null and no new cursor; absence never proves closure/deletion. Coverage
reports observed/missing requested IDs and the exact selection rule. ID filtering
happens after bounded owner metadata reads, not through a new native query engine.
Owner/ID sets are sorted for cursor binding; changing between project and explicit
owner modes resets the comparison.
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
1=invalid request/identity/scope failure. Raw stderr/payload errors are not echoed. Queue validation reports a fixed
field-class error code (such as queue_invalid_tags or queue_not_body_free),
never an offending ID, value, summary or body.

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
calls/elapsed and correctness on matching scope/state. Default/project invocation uses four native calls; explicit-owner mode uses
three plus the number of named owners. These native reads are a real cost; this can be worse than a small queue read.
Response reduction is not measured whole-prompt/provider billing savings.
Provider usage, setup/author/reviewer/Support model cost and amortization remain
UNKNOWN unless independently measured. Native activity output can dominate a
narrow work query. Prefer the existing consumer workflow if this is a net loss.

## Managed standalone CLI install and rollback

The selected managed target is `/Users/garry/.local/share/toolrig/state-v07`.
Infrastructure owns deployment. The installer is source code, not an automatic
refresh or an OpenRig runtime plugin. Existing direct source calls remain valid.
Node24, Git and npm are required; npm needs the pinned zod package in its cache
or registry access. No global PATH, profile, home, permissions, daemon or seat
settings are edited. This install provides the CLI only; it does not register MCP.

From the independently accepted installer checkout:

```
node scripts/toolrig-state-install.mjs install \
  --root /Users/garry/.local/share/toolrig/state-v07 \
  --source /Users/garry/Documents/git/toolrig-state-obligation-scope-v09 \
  --revision a8f47e9ffdd5404dabd93c41e313129f8e6529a4
node scripts/toolrig-state-install.mjs status --root /Users/garry/.local/share/toolrig/state-v07
/Users/garry/.local/share/toolrig/state-v07/bin/toolrig-state --help
```

The exact full trusted/reviewed Git commit is the payload pin; source files are
read with Git, not copied from potentially dirty working files. Six State source
files are preserved byte-for-byte. Only the CLI dependency closure (zod) is
installed from the source lock's exact version, registry URL and integrity,
using `npm ci --ignore-scripts --omit=dev`. No other Hub dependencies/services are
installed. An artifact entrypoint supplies local help and validates owner/ID
schema without querying State, invoking `rig`, or creating a cursor.

Layout: `artifacts/<full-source-sha>/install.json` records exact pin, source and
all payload/dependency hashes, Node requirement/executable and install time.
`bin/toolrig-state` is the stable launcher; `current` is a relative symlink to
one complete verified artifact. Successful install/update checks help and all
hashes before a same-directory atomic symlink rename selects the artifact.
`status` checks the selection, complete file inventory, source/dependency hashes,
launcher and local owner/ID help. The manifest is in the selected artifact, so
manifest and current selection cannot disagree through a separate write.
The root and its ancestors must be real directories (on macOS use `/private/tmp`
rather than the `/tmp` alias for temporary roots). Unknown files, symlinks and
inconsistent existing artifacts fail closed. A writer lock prevents concurrent
updates. A stale lock after a killed process is an explicit recovery condition;
inspect custody before removing it. Pre-commit failures keep the previous target;
a killed process may leave an unselected stage or valid artifact, never a partly
copied current artifact. No automatic garbage collection is provided.

The install result returns `previous` and an explicit rollback revision. Restore
that prior managed revision with:

```
node scripts/toolrig-state-install.mjs rollback --root /Users/garry/.local/share/toolrig/state-v07 --revision FULL_PREVIOUS_SHA
```

Rollback verifies the retained artifact and atomically selects it; it never
fetches, rebuilds or deletes artifacts. The historical `a704eaf09c51` and
`b7b13d784a7b` standalone directories are preserved and remain callable directly;
they are not implicitly adopted as managed artifacts. Initial install has no
previous managed selection. A corrupt active artifact blocks update/status; rollback can still restore a
verified retained target without trusting the corrupt active payload. Corrupt
artifacts are not silently repaired.
The launcher pins the installer's absolute Node24 executable. A different Node
path is an explicit launcher migration, not an unannounced overwrite.

Installer tests use isolated temporary roots and Git fixtures, package failure,
update/rollback and source/dependency tampering; no native State query is needed.
Installation/readback is distinct from natural same-scope cursor use, steady
adoption and paired savings, which require their existing consumer evidence.
