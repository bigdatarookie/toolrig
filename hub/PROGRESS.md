# Availability implementation

## Current state

2026-11-12: tools.hub owns qitem-20261112161037-7c058ff82cad95df.
Read-only MCP consumer succeeded; native transition/event-to-resume and live
canary remain unproven for the exact gaps in PROOF.md. Next boundary: independent
verification.qa review of the candidate, with its normal merge authority.

## Outcomes

- Implemented shared CLI/MCP read service, explicit permitted account registry,
  quota policy, atomic shared-home operation/continuation persistence and native
  queue wake adapter without an additional scheduler.
- Author checks and real Support consumer receipt: [PROOF.md](PROOF.md).
- Exact canonical v0.2 commit f8028e8 included before implementation edits.
