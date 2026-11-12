# Provider-limit event integration

ProviderLimitListener in src/events.js accepts account/rateLimits/updated over
the public app-server JSON-RPC stream. The default source is CodexSession, shared
with the existing short-lived CodexReader. Only initialize, account/read and
account/rateLimits/read are permitted outbound RPCs. Status/MCP output and the
short reader's overall 35-second deadline remain unchanged. No listener is
started by status or MCP requests.

The installed Codex 0.166.0 schema describes this notification as a sparse
rolling update with nullable metadata. The
[official public API](https://learn.chatgpt.com/docs/app-server) documents it as
a notification and account/rateLimits/read as the full read. Neither the local
notification schema nor the returned snapshot provides a notification sequence
or provider observation timestamp. Payload ordering therefore cannot establish
recovery.

## Event handling

Every matching notification is an invalidation. Its quota/account/reset values
are ignored, including fields that look like headroom or exhaustion. The adapter
immediately requests account/read and account/rateLimits/read over that public
connection, then applies existing home validation, normalization and freshness.
Same-tick repeats coalesce. A notification arriving during a full read invalidates
that response for action and requests a fresh read. A drain has at most two full
reads; continuous notification/read feedback fails closed until a subsequent
external event or explicit reconnect, instead of becoming a polling loop.

Only an explicit ordinaryUsageAllowed=false, known backend account identity and
applicable project/model grant can establish a provider block. A confirmed reset
of all exhausted required windows must produce the existing wait decision before
any native wake call. Missing/unknown/stale, nonblocked, unsupported and resetless
results cannot arm. An available alternative produces pending native precheck,
with no auth/retarget/restart execution or reset timer.

Before event routing, every current required bucket must contain an observed
window, and all observed window/individual-limit percentages must be known and
within 0–100. An explicit provider denial alone cannot substitute for missing
current quota details, even if another account has a confirmed reset.

The existing operation retains native continuation/cohort references. Repeated
events and multiple listeners join its ID. A saved decision with a different
target/reset is retained for revalidation, not silently overwritten or armed.
Before a native park, the adapter rechecks connection generation, invalidations,
fresh provider block, latest policy/registry decision and exact target/reset.
The native adapter verifies the existing qitem owner, atomically claims the wake
and reconciles lost responses. No business task is retried. A later nonblocked
snapshot does not clear a previously recorded blocker or claim useful recovery.

The v0.3 native-binding boundary additionally requires the runtime owner's
internal verifier before creating a native event wait and before park. It is
false by default; an independent connection, matching home/account or a supplied
binding label does not attest a native seat. The default entrypoint remains
diagnostic until the owner supplies a verified native attachment. See
[BINDING.md](BINDING.md) for the tested public Unix alternative and exact next
OpenRig launch/relay implementation.

RPC failure or transport loss stops the connection and reports a code-only
diagnostic. Explicit reconnect creates a new source generation, ignores old
notifications/in-flight responses and waits for a new invalidation. There is no
automatic reconnect timer, cron, scheduler, new task or native private-file hook.
The CLI exits nonzero on unexpected transport/full-read failure. Per-RPC deadlines
are network timeouts, not quota observation timers.

## Native-owner integration seam

An explicit native-owner entrypoint exists:

```sh
node src/listen-events.js continuation.json
```

It uses the same trusted CODEX_HOME, OPENRIG_SESSION_NAME, TOOLRIG_PROJECT,
TOOLRIG_MODEL and metadata store as the existing service. Continuation schema is
the one in README.md. This entrypoint can call the native queue wake adapter only
for its existing owned qitem; deployment must supply real native continuation
references and an authorized registry. This increment did not invoke it against
a live provider or create production timers.

The class also accepts createSource for an owner-provided public transport
binding (notification/disconnected events plus connect/snapshot/close), so it can
sit at the native runtime's public stream boundary without a second execution
engine. Reconnect is explicit. This is the smallest implemented seam; no private
socket or native session database is read.

The default source opens its own app-server. It does **not** attach to a running
Codex CLI seat or prove account-limit event broadcasts across processes sharing
a home. Installed proxy help advertises a public app-server control-socket
transport, but that alone does not establish the active seat's socket, account,
event scope or permission to attach. No daemon was started, restarted, enabled or
attached by this work. Actual native-seat stream binding is still required;
a separate observer process is not presented as a working cohort event feed.

## Verification boundary

35 author tests pass on Node24/macOS, including eleven new event fixtures: sparse
and out-of-order data, duplicate/coalesced events, missing identity/permission/
window/reset/grant, stale/nonblocked reads, in-flight invalidation, bounded churn,
read failure with explicit reconnect, disconnect generation, revalidation before
park, unknown-effect reconciliation, two-listener idempotency, incomplete current
quota with another account's valid reset, and a real stdio
fixture process exercising the public JSON-RPC transport. Existing MCP discovery,
status/read, quota policy, native wake and persistence tests still pass.

Naturally occurring live notifications, live native-seat binding, production wake,
reset-to-useful-continuation, running-seat identity, account transitions/restarts
and cohort preservation are **NOT RUN / unproven**. No forced exhaustion,
account/auth/model/effort/permission change, private credential/native-state read,
neighbor restart or new scheduler occurred. This is code/fixture evidence for one
increment, not full v0.2 READY. Reset-to-useful-continuation timing remains
unmeasured, not zero.
