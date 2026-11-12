# Native binding: implemented attempt and next runtime seam

This v0.3 increment replaces the former maintainer-discovery wait with a concrete
read-only investigation, a working public transport canary and a prepared native
launch design. It does not move an existing seat or label a second app-server as
that seat. Ordinary status/limits/selection remain usable independently.

## Verified cause

Installed OpenRig 0.7.7's CodexRuntimeAdapter deliberately adds --no-daemon so
each seat's tool process tree keeps its own identity. Its codex-daemon-support
module documents the cross-seat identity error that a shared machine daemon
would reintroduce. Public seat status reports daemonOptOut=true for the observed
Toolrig seats. A recorded launch mode is not an attestation of a current account.

The matching official Codex rust-v0.166.0 source tag resolves to commit
6ff1e1ca3b30fc8b914720681fcf5fe62e95f856:

- [Embedded sessions have no remote connection](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/tui/src/app_server_connection.rs#L17).
- [--no-daemon excludes the shared daemon](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/tui/src/daemon_startup.rs#L68).
- [Quota events use ThreadScopedOutgoingMessageSender](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server/src/bespoke_event_handling.rs#L1619),
  which [sends only to its subscribed connections](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server/src/outgoing_message.rs#L213).
- The public Unix listener [accepts WebSocket frames and publishes a protected
  rendezvous alias](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-transport/src/transport/unix_socket.rs#L71).

Thus discovering some socket or observing the same account from a fresh process
cannot recover an embedded seat's event connection. A second read client on a
shared backend also is not automatically subscribed to the seat's thread.

## Callable implementation

```sh
node src/cli.js native-binding-plan
CODEX_HOME=<provided-existing-home> node src/binding-canary.js
```

The plan queries rig whoami and then rig seat status for **that returned seat**.
It includes source and client observation time, labels launch metadata as
recorded, leaves nativeAccountId=null and nativeAttachmentVerified=false, and
returns a concrete dedicated-server/native-resume integration plan. It does not
initialize/chmod a Hub metadata DB. Support's real use found the earlier eager
store initialization; a failing filesystem regression reproduced it and lazy
dispatch corrected it. Its output is useful own-seat diagnosis, not account
attestation.

OwnedAppServer creates one private task directory and one native public Unix
listener, with plugins/apps disabled only for that child. UnixCodexSession uses
WebSocket-over-UDS (ws 8.22.2), not raw NDJSON or a private protocol. The first
canary attempt refused the native alias; source inspection established the exact
protected alias contract. A raw proxy attempt then timed out because proxy
copies bytes without a WebSocket handshake. The corrected adapter implements
the public handshake and worked against the installed binary.

The canary accepts no arbitrary socket. It checks its own child, private parent,
recorded inode/owner identities and either the direct owned socket or Codex's
exact advertised-path SHA256 alias under the private per-UID native directory.
It never scans that directory for other processes. Attachment checks run before
and after initialize and snapshots. Cleanup stops only its newly-created process
group and removes only its recorded endpoint/lock identities and task directory;
the shared native socket directory is retained. Same-OS-user logical custody is
not a sandbox against YOLO processes under that user.

Startup uses a bounded readiness check as well as filesystem events: macOS CI
did not emit direct Unix-socket creation notifications, although alias creation
was observed. A fixture suppressing fs.watch notifications reproduced the
timeout, then passed with the bounded check. It stops on readiness/failure or
the startup deadline and does not poll quota or install a scheduler.

At 2026-11-12T18:37:30.333Z / 2026-11-13 01:37:30 Asia/Bangkok, two clients on
one owned app-server both returned the same backend accountId via full public
reads. No thread/start, thread/resume, turn, account switch or production wake
was invoked. Observed quota-event count was zero. The final canary confirmed its
own process stopped, task directory absent and owned physical endpoint absent.
It explicitly reported nativeSeatBound=false. Account identity and machine paths
belong to local observation output, not this shipped document. Normal Codex
startup/cache/token refresh remains Codex-owned; no credential/native state was
manually inspected, copied or edited.

ProviderLimitListener now requires an internal runtime-owner verifyNativeBinding
callback before reserving a native event wait and again immediately before park.
It defaults to false; caller-supplied binding labels, matching home/account and
an unresolved Promise cannot authorize a park. CLI/MCP arguments cannot supply
this verifier. Fixtures inject an explicit synthetic owner to exercise event
mechanics; that is not a production binding receipt. Default independent
app-server observations remain diagnostic and cannot impersonate a working seat.

## Prepared seat-to-account-to-event attachment design

| Hop | Concrete implementation required |
| --- | --- |
| Seat -> backend | OpenRig owns one dedicated app-server for that seat's launch generation, started under its exact seat environment/cwd/home and verified model/effort/config/permissions. Retain the existing seven seats; do not use a machine-wide backend. |
| Native TUI -> backend | Launch the real Codex TUI with the supported --remote unix:// endpoint, using native resume of the original conversation at a safe boundary. Never run a second native controller on the active conversation as a read probe. |
| Backend -> actual account | Read account/read and account/rateLimits/read from this owning backend's AuthManager, validating backend accountId rather than inferring it from home or credential labels. |
| Thread -> events | Relay quota notifications from the TUI's already-subscribed owning connection. Do not call thread/resume merely to make an observer subscribe: that is a native lifecycle operation, not a read-only subscription. |
| Attachment -> permission | The runtime owner validates live seat/generation, backend PID/socket identity, original thread and authorized consumer, then supplies/revokes the internal binding verifier. A JSON label alone is not authority. |

The exact OpenRig source seam is CodexRuntimeAdapter.prepareLaunch/seatCommand
(and resumeCore), with per-seat backend lifecycle and an authenticated native
attachment read model. The first offline change can be an opt-in adapter
dependency returning a dedicated endpoint plus owner-bound receipt; existing
embedded launches remain the default. The public TUI flag and tested Unix client
are already available. Account payload fields do not need to be invented.

An owner-side relay forwards the native TUI's public RPC traffic unchanged and
copies only quota invalidations to the Hub; Codex remains the execution engine.
The Hub obtains its full snapshot over the separate read-only connection to the
**same backend**. No second scheduler/tracker or observer thread takeover is
needed. This relay/owner launch coupling is the next implementation, not a
claim that the canary already supplied it.

## Exact remaining authority and continuation

The installed launch path cannot expose an existing embedded connection through
a socket. Turning this prepared variant into actual tools.hub binding requires
a reviewed OpenRig runtime-adapter source candidate and a controlled managed
package/launch deployment. This task did not patch the installed/running daemon
or restart/migrate any current seat. The named deployment operation is: opt one
Toolrig seat into dedicated-backend native resume at a verified safe boundary,
after checking original conversation/settings and shared-home consumers. That
is an operator runtime deployment decision, not a request for a maintainer to
authorize ordinary source research.

Continue with the offline opt-in launch/relay candidate, independently of other
tool consumers. Before live cutover, verify native resume preservation of the
same conversation/qitem/config/model/effort/permissions and a useful next turn.
Fork and artifact rebuild have different continuity outcomes and must be labeled
as such. A further account-switch canary still requires a provided compatible
account; none is invented here. Live seat binding/events, production wake,
account transition, reset-to-useful-continuation and cohort preservation remain
NOT RUN/unproven. This is not full availability READY.
