# Availability implementation

## Current state

Native assignment qitem-toolrig-v03-availability-binding-20261113 tracks the
v0.3 continuation; use rig queue show for its current owner/state. The obsolete
maintainer-discovery human wait was superseded by the user-authorized engineering
task. The operator recovery parent is qitem-toolrig-v03-recovery-operator-20261113;
coordination.lead retains the broader qitem-20261112163602-58e42970 outcome.

Working functions include configured-home status/limits, permitted policy,
own-seat binding diagnosis, and a canary-tested public Unix account transport.
The default unbound event source cannot impersonate a native seat to park work.
The concrete next integration is owner-side dedicated per-seat backend/native
TUI launch plus owning-thread event relay, described in BINDING.md. Current
embedded seats were not migrated; actual native binding/live transition/useful
continuation remain unproven. Full availability READY is not established.

## Outcomes

- v0.3: investigated installed/matching upstream source, implemented public Unix
  endpoint custody/client canary and a metadata-only own-seat diagnostic; a real
  two-client account read and scoped cleanup passed. 43 author tests pass.
- Support used the diagnostic and exposed eager metadata-store initialization;
  reproduced and fixed it without waiting for an adoption ACK.
- PR #1 and PR #6 code increments were independently accepted and merged as
  893ec3f and fb66090; PR #7 reconciled acceptance evidence as 83e89a7.

- Fixed independent review's incomplete-current-quota gap: explicit denial plus
  an alternate account's reset cannot arm when current required bucket/window
  percentages are missing or invalid. Two-account regression failed before fix
  with actual fixture queue show/block calls, and passes after correction.

- Added public notification invalidation/full snapshot adapter with guarded,
  idempotent owned-qitem wake integration and explicit reconnect. No production
  listener/timer or native private hook installed; [EVENTS.md](EVENTS.md).

- Independent review found low positive target quota wrongly excluded at current
  0/provider-blocked. Reproduced with focused failing tests, corrected the
  target predicate, and retained target low-quota warning in the decision.

- Implemented shared CLI/MCP read service, explicit permitted account registry,
  quota policy, atomic shared-home operation/continuation persistence and native
  queue wake adapter without an additional scheduler.
- Author checks and real Support consumer receipt: [PROOF.md](PROOF.md).
- Exact canonical v0.2 commit f8028e8 included before implementation edits.
