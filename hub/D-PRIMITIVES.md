# D primitives 0.2.0 — source candidate

This package adds bounded task trace, compact native receipts, same-operation
reconciliation and an opt-in machine-event coordinator. State/delta and CI digest
remain their accepted implementations. No service, model, account, home or running
seat is changed by importing this package. Node 24 and locked dependencies apply.

## Source/install boundary

Private local ESM package `@toolrig/hub`; `npm ci --ignore-scripts` in `hub`, then
`npm pack --ignore-scripts`. Install the pinned tarball in the managed runtime's
isolated source/build dependency composition; no registry publication is needed.
Exports: `@toolrig/hub/machine`, `/native-queue`, `/receipts`, `/task-trace`,
`/state`, `/native-runtime`, `/native-hooks`. The D exports do not import private
Availability configuration or initialize its database. Installation in a temporary
package smoke test does not install or activate OpenRig.

`toolrig-d trace --qitem ID [--query literal]` reads the actual owner's native task.
`toolrig-d consume --qitem ID --event-id EVENT [--facts-file JSON]` checkpoints a
machine-work obligation; facts are an array of `{value,sourceRef}` from its refs.
`toolrig-d recall --qitem ID` restores event, intent, refs and sourced checkpoints.
`toolrig-d return --qitem ID --outcome-file JSON` returns `{conclusion:"..."}` via
native handoff; on return-work it completes that subtask only, preserving the
original parent. No recursive machine acknowledgement is created. Input JSON must be a regular
non-symlink file no larger than 4096 bytes: open nonblocking, check descriptor type
and size before reading, then read at most 4097 bytes to detect growth. Invalid
UTF8 and oversized/special inputs are rejected before any native queue operation. Exit 2 means
unknown: reconcile the SAME native ID, never replay with a new ID.
The MCP SDK server exposes `task_trace`, `machine_consume`, `machine_recall`,
`machine_return` with the same actual-owner semantics. These are not actor spoofing
or runtime connection injection APIs.

## Composition contract

`createMachineDelivery({queue,channel,payloadReader})` exposes `deliver(qitemId)`
and read-only `reconcile(sameId)`. `enqueueMachineEvent(queue,event)` creates a
stable native ID from producer/owner/eventId, checks the actual producer's parent
project, and retains only typed metadata/digest/source refs. Raw payload stays in
its authorized source. Human intent/decisions must not be classified as transient
machine events. Source selection is not permission to erase earned memory.

Queue is a trusted immutable actor-bound port over the existing native queue:
`identity`, `find` (null ONLY for definitive not-found), `read`, `journal`, `create`,
`claim`, `note`, `handoff`, `complete`, `children`. `NativeQueue` implements these
through supported CLI JSON verbs under the real seat environment without identity
overrides, shell execution or a parallel ledger. The daemon must bind its existing
QueueRepository authority per actual destination, not reuse arbitrary MCP JSON.
Native claim is the CAS; the coordinator checks pending/unblocked again before
RPC. Runtime preserves its own live stop/busy/generation fence immediately at send.
All event handoff children explicitly carry `project:...` and `machine:d-v1` tags.
Untagged ordinary wakes return `outcome:not_applicable` BEFORE parsing their body;
malformed tagged rows return `outcome:unknown` without writes or RPC. The tag is
only a routing selector. Before any payload/channel access, delivery authenticates
its deterministic native root ID, native sourceSession/producer, retained source
task owner/project and every native handoff edge (maximum four protocol stages).
A manually created row is acceptable only when its native producer and complete
provenance are equivalent to the guarded helper; tag/body alone never confer
permission. Human intent/detail/questions/answers/decisions on the source or event
are rejected, not converted to transient input. Consume/recall/return validate the
same provenance; wrong/missing/cyclic lineage fails closed.

Channel is an internal owner capability, not `{verified:true}`. It implements:

- `assertCurrent(seat)` -> `{seat,nodeId,generation,threadId}` from current owned
  endpoint/process/TUI attachment and native lifecycle; mismatch refuses delivery.
- `send({operationId,eventId,obligationId,binding,toolOutput})` performs ONE supported
  `turn/start {threadId,input:[],toolOutput}` on the actual owned Codex backend.
  Hub supplies `{name:'openrig_events',output:ENCODED_EVENT,retain:false}`. No thread
  creation/resume/fork or model/effort/home/permissions override is needed.
- Accepted receipt: `{status:'accepted',transport:'toolOutput',retain:false,binding,
  requestId,turnId}`. This proves turn acceptance, not consumption or completion.
- `reconcile({operationId,eventId,obligationId,binding})` reads the same owner
  receipt as accepted/unknown/not_sent; lost receipt/connection is UNKNOWN.

The native dispatcher wrapper maps Hub `outcome:not_applicable` to its own
`status:not_applicable` and keeps ordinary text wakes. Map fresh `wake_accepted`
with requestId/turnId to accepted; prior accepted native/runtime receipts may prove
that same turn without resending. Consumed/returned work must not trigger another
wake. Unknowns or thrown effects map unknown with NO text fallback. Only explicit
pre-write `machineTransport:NOT_IMPLEMENTED` or `unavailable` permits the existing
compact fallback, labelled distinctly. Do not send machine plus text for one event.
The wrapper/result enum belongs to the runtime source owner, not a second Hub
transport. Native queue/wake/backstop continues to own scheduling.

A native consumer-work child is created without nudge before RPC. Consume records
bounded sourced facts in the native transition journal. After context loss, recall
uses that durable record rather than replaying the event. Return creates a native
successor for the original producer; that successor can traverse the same typed
transport, then its consumed return-work completes without an acknowledgement loop.
On timeout/ambiguous create, claim, handoff or RPC, inspect the same IDs/lineage;
never automatically create a replacement operation or repeat a model turn.

The backend supervisor remains seat-owned. The daemon may hold a generation-fenced
client to that SAME backend's public Unix endpoint only after verified runtime
custody and original-thread attachment. No existing cross-process JS reference is
assumed. No new app-server, IPC bus, execution engine or private transcript/SQLite
integration is supplied here. Infrastructure owns missing source endpoint plumbing,
queue wake injection, reproducible build/install and any later authorized rollout.
Lost registry or daemon restart is unavailable until supported revalidation.

## Bounded reading and receipts

`taskTrace` reads only an addressed owned native task/journal, returning limited
lineage and up to eight sourced decision notes within 4096 UTF8 bytes; the full
chain and parent mission remain native. Explicit `readTaskRefs` supports addressed
text file line ranges inside configured real roots: whole original lines, fatal
invalid UTF8, maximum 4096 total bytes, no silent numeric/unit/UNKNOWN rewriting.
Unsupported refs remain locators and partial coverage remains explicit. It does
not scan transcripts, index a new memory store, delete history or call an LLM.
Residual unstructured text at the 8000-token policy threshold belongs to the
separate Automation Qwen route; this bounded reader never reaches that threshold.
`compactReceipt` projects exact native changes and a source command.
`writeThenReconcile` attempts one write and one addressed reconciliation only.

## Verification boundary and affected E2E matrix

Author fixtures cover concurrent native CAS, normal and typed-return lifecycle,
loss of local objects/recall, unknown transport effects, idempotency, actor/scope/
generation/block fences, ordinary wake compatibility, exact source fields,
UTF8/budget guards, native CLI arguments/temp cleanup and real SDK MCP calls.
Loss of local fixture objects is synthetic compaction, NOT provider compaction.

The one affected independent reviewer should freeze/check this matrix once and
return consolidated PASS/FAIL/NOT RUN, then retest only any corrected finding:

| Group | Source-candidate evidence | Actual runtime status |
| --- | --- | --- |
| package/import + CLI + SDK discovery/call | locked package and synthetic tests | installation NOT RUN |
| native queue contract / ordinary fallback / D selector | fixed-argv fixtures, canonical tag gate | native dispatch NOT RUN |
| typed wake / concurrency / owner + stop fences | synthetic owner channel and CAS | real owned channel NOT RUN |
| consume / durable facts / recall / typed native return | native-port fixtures, no replay/recursive ACK | production lifecycle NOT RUN |
| provider compaction and retained intent/earned memory | synthetic loss only | provider compaction NOT RUN |
| kernel / other rigs / hosted / local Qwen | source contract only | all NOT RUN |
| state / CI regression | existing tests reused | no new consumer wave |

No adoption, token/billing savings or production readiness is claimed by source
merge or package smoke. Preserve stopped Polar, current Alfarig SWE tools and all
existing owner environments. A real otherwise-needed operation must establish the
production effect after accepted source composition and authorized installation.
