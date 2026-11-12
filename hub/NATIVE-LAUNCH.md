# Opt-in native launch/relay source candidate

This is an offline implementation increment after PR #9, not an installed
runtime and not Availability READY. It preserves the earlier failed raw-proxy,
symlink, filesystem-watch and metadata-store findings in BINDING.md/PROOF.md.
No existing seat, account, home, model, effort or permission was changed.

## Source contract

`src/native-hooks.js` supplies optional CodexRuntimeAdapter preparation, resume
and seat-command hooks. Without injection or with `enabledFor(nodeId) === false`,
launch remains embedded. Opt-in supports native **resume only**. Fresh/fork and
custom `-p` config profiles are rejected. Unknown config overrides fail closed.

`integration/codex-runtime-adapter.patch` is an unapplied source artifact against
the exact installed OpenRig 0.7.7 compiled adapter identified by baseline.json.
It adds the optional dependency and wraps both successful prepare paths, then
branches resumeCore/seatCommand only for a prepared native spec. It is not an
installer or permission to modify an installed package. Infrastructure must
port these small seams to its managed OpenRig source/build, preserving its
existing readiness/native-resume proof and disabled behavior.

Infrastructure supplies `NativeLaunchHooks` through the adapter's optional deps:

```js
new NativeLaunchHooks({
  enabledFor: nodeId => selectedNativeResumeNodeIds.has(nodeId),
  captureOriginal: trustedRuntimeOwner.captureOriginal,
  resolveCodexEntry: trustedRuntimeOwner.resolveAbsoluteCodexEntry,
  runtimeRoot: privateManagedRuntimeRoot,
});
```

`captureOriginal` is an internal owner observation, never MCP/CLI JSON authority.
Its result must satisfy `launchSpec` in native-plan.js: original thread/qitem,
exact cwd/raw CODEX_HOME/model/effort/provider/account, config/permission refs,
affected cohort, original runtime workspace roots, approval/reviewer/sandbox,
active permission profile/service tier, and SHA256 of canonical effective
`config/read.config`. No raw config, provider credential or environment is
serialized. `codexEntry` is the resolved absolute executable and optional Node
wrapper prefix from the existing daemon resolver. Original-owner shutdown and
safe-boundary authorization remain deployment responsibilities, not inferred
from absence of a file. Unknown original settings must stop the attempt.

Preparation is pure. The supervisor command contains metadata only, runs inside
the existing SeatLaunchEnvironment identity/generation/PATH wrapper, and inherits
provider credentials in the pane. It omits the writer's `codexCwd` rewrite because
that path only accepts a command starting with `codex `; absolute Codex executable
resolution was already captured. The supervisor verifies its exact identity,
generation, cwd and home before launching anything. Existing accountHome handling
still goes through the seat writer. Do not run the supervisor from daemon env.

`NativeSeatRuntime` claims one private per-node generation lease with exclusive
creation, starts one owned public app-server in the inherited environment, then
starts the real native TUI with `--no-daemon --remote ws://127.0.0.1:<port>
--remote-auth-token-env TOOLRIG_NATIVE_REMOTE_TOKEN resume <original-thread>`.
The backend retains plugins/apps and receives explicit preserved setting
overrides. Its initial same-backend account/config read must match before TUI
launch. The WS capability token goes only into the TUI's environment; it is never
in argv, lease, receipt or logs. This uses public Codex transports; Unix remains
the private backend transport. It does not require the TUI to subscribe a second
observer thread. The native owner and same-uid host are trusted; this is not an
OS sandbox against malicious same-user processes.

The relay accepts one capability-authenticated TUI connection, forwards public
native RPCs, rejects new/fork/other-thread execution and settings/account
mutation, and holds the original resume success until thread/model/effort/cwd/
permissions and same-backend account/effective config/loaded-thread reads match.
Nullable default fields used by Codex 0.166 are accepted. The explicit supported
RPC set intentionally fails closed for future unsupported TUI operations; it
is not a complete replacement for Codex's protocol or execution engine.

Only quota invalidations on that owning connection reach Availability. Full
snapshots use a read-only client on **the same owned backend/AuthManager**.
Receipt metadata binds owned launcher PID/socket/thread/generation/account
(the Node wrapper PID is labelled as launcher, not the Rust child PID), but authorization
also requires internal live source identity, owner connection, backend custody,
current lease and complete matching continuation. A JSON copy grants nothing.
Generation, transport, account/config or thread-settings drift revokes the
receipt. Existing ProviderLimitListener rechecks before reserve and park.
`runtime.listen(service, context)` composes that listener without a new queue or
controller. The supervisor entrypoint uses configuredService and uses the trusted preserved project/model and checks any
existing TOOLRIG_PROJECT/TOOLRIG_MODEL plus seat/home against that spec; it
does not manufacture grants, another account, or permission to switch accounts.

Stop terminates only the owned TUI/backend. Unconfirmed TUI termination retains
the generation lease and reports a concrete cleanup failure instead of starting
a duplicate generation. Unknown/replaced lease files are never deleted. There
is no reconnect loop, quota poll, automatic native replay, reset controller or
private provider DB/transcript access.

## Validation and deployment boundary

Author fixtures exercise real local WS/Unix relay transport with a synthetic
backend and TUI process handle, including original resume, second-client denial,
source identity, setting/account/config/generation drift and existing durable
reservation plus pre-park revalidation. Existing suite covers actual task-owned
child process/Unix alias cleanup and default status/MCP/policy/selection behavior.
The fixtures perform no provider thread/turn or real qitem park. These are source
proofs; they do not attest a production native TUI or useful continuation.

Independent QA reviews exact head and macOS/Ubuntu CI. After source acceptance,
Infrastructure owns the single downstream deployment attempt:

1. Build/package the optional adapter seams from this exact candidate in a
   recoverable managed source checkout. Keep disabled default. Verify native
   CLI version/flags and original-owner observation contract. Do not hot-patch
   running dist files or edit private provider state.
2. Select one authorized safe boundary, record original seat/thread/qitem,
   cwd/home/env/config/model/effort/permission/cohort and rollback launch. Confirm
   the old owner stopped; never overlap native owners for the original thread.
3. Launch through the existing writer and opt-in dependency. Check original
   native resume, receipt, owning connection relay and same-backend snapshots.
   Prove a useful next native turn and unchanged cohort. No account migration
   is authorized by this source increment.
4. At any mismatch stop owned generation, reconcile unknown effects, preserve
   the lease when stop is unconfirmed. Disable opt-in and use the original
   supported resume command only after confirming the failed generation stopped.
5. Return native effect, exact limitations and rollback outcome through the
   operator recovery parent and retained lead parent. Full readiness publication
   requires real callable consumer proof, not just merge or a fixture receipt.

Deployment, live continuity, real owner quota notification, production park,
account transition, reset-to-useful-work and cohort preservation are NOT RUN.
