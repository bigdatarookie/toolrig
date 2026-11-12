# Availability implementation

## Current state

tools.hub owns event-integration child qitem-20261112171242-2278e2d38336c5a6;
coordination.lead holds full outcome qitem-20261112163602-58e42970. Original PR #1
was independently accepted and merged as 893ec3f. Event adapter code/fixtures
now pass 34 tests; next boundary is independent verification.qa review of this
increment. Actual native stream binding/live transition/useful continuation
remain unproven for the exact limits in PROOF.md and EVENTS.md.

## Outcomes

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
