# Toolrig temporary Docker containers

`scripts/toolrig_docker_temp_cleanup.py` inventories only containers carrying
the `io.toolrig.temporary` label. Running it without a command, or with
`inventory`, is a read-only dry run. It never runs `docker system/container
prune` and never targets images, volumes, networks, or Compose projects.

## Label containers when they are created

Use the JSON labels from the helper while constructing the original
`docker create`/`docker run` command. Labels are immutable container metadata;
do not retrofit them onto existing containers and then treat them as proof of
ownership.

```sh
python3 scripts/toolrig_docker_temp_cleanup.py labels \
  --task-qitem qitem-EXAMPLEID \
  --expires-at 2026-12-01T00:00:00Z
```

The command derives `io.toolrig.owner` from the live `rig whoami` identity and
prints the complete label map as JSON. A creating adapter can parse the map
and append one `--label key=value` pair per entry to its Docker create command.
The owner must be a Toolrig seat and the task must be the qitem that owns the
container. Set expiry according to the task's declared retention; the helper
does not invent a retention period.

## Inventory

```sh
python3 scripts/toolrig_docker_temp_cleanup.py
python3 scripts/toolrig_docker_temp_cleanup.py inventory
```

The JSON receipt contains safe identity labels, exact container ID/name,
before state and Docker writable-layer bytes, a `preserve` or `eligible`
decision, and reason codes. Unknown or invalid identity, wrong project,
unexpired retention, nonterminal/mismatched task, running/restarting
container, or missing attestation means `preserve`. Docker command output,
container env/command, arbitrary labels and mount source paths are not emitted.

## Exact-target removal

First inspect a single target without action:

```sh
python3 scripts/toolrig_docker_temp_cleanup.py remove --target toolrig-task-123
```

Removal requires the current caller to be the recorded owner, the owning
qitem to be terminal, all policy checks to pass, and three explicit
attestations. Repeat the exact target in `--confirm-target`:

```sh
python3 scripts/toolrig_docker_temp_cleanup.py remove \
  --target toolrig-task-123 \
  --execute \
  --confirm-target toolrig-task-123 \
  --attest-no-live-consumers \
  --attest-rollback-complete \
  --attest-evidence-preserved
```

The helper re-inspects the target and task immediately before removing the
container by its full ID. Removal is non-forced and only stopped containers
are eligible. The receipt records the observed after-state; writable-layer
bytes are `null` after the container is absent because Docker can no longer
report that layer size. If a command fails or times out, reconcile target
presence before deciding whether any retry is safe.

The attestations are explicit caller assertions, not automatic discovery of
consumers or rollback/evidence dependencies. Only use them after checking the
owning task and its actual consumer/evidence state. Existing OpenBao, OpenTour
CRM, Polar, t2s and all non-Toolrig resources must remain preserved.
