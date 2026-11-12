# Toolrig OpenBao

This is a one-node OpenBao service for Toolrig. It uses the official `openbao/openbao:2.7.2` image pinned by its multi-platform OCI digest. OpenBao is licensed under MPL-2.0. Source and release: [OpenBao v2.7.2](https://github.com/openbao/openbao/releases/tag/v2.7.2); [official installation guide](https://openbao.org/docs/install/).

## Runtime shape

- One Compose service, integrated Raft storage in a Docker named volume, and no dev mode.
- Host API port is bound to `127.0.0.1` only. TLS is disabled inside the container network; this endpoint is for the local host and must not be published on a LAN or routed through an unauthenticated proxy.
- Root filesystem is read-only, all Linux capabilities are dropped, and the process has no-new-privileges. Compose owns restart; `down` preserves the named data volume. OpenBao 2.7.2 removed the `disable_mlock` option, so this deployment does not set it.
- Raft snapshot restore streams to the OpenBao API. OpenBao's server-side temporary snapshot file uses `TMPDIR=/openbao/file` on the durable Docker volume, not the 16 MiB container `/tmp` tmpfs; the file API cleanup removes it after the operation.
- The same pinned image has an opt-in test profile for a disposable OpenBao Agent consumer. It is not part of the running backend.

The base Compose file resolves all state outside the repository. By default, OpenBao's Raft data is a Docker named volume; snapshots are written to `~/.openrig/services/toolrig/openbao/backups`. Bootstrap material is outside the backend and repository at `~/.openrig/recovery/toolrig/openbao/bootstrap.json`.

## Bootstrap and recovery

`bin/openbao up` starts an uninitialized, sealed service. `bin/openbao init` initializes it once with a one-share/one-threshold Shamir seal and writes the returned unseal share plus initial root token to the external recovery file with mode `0600`; parent recovery directories are mode `0700`. The command never prints the material. Keep this file under the host account owner and do not copy it into the repository, model context, command arguments, or ordinary logs.

After a container or host restart, OpenBao starts sealed. Run `bin/openbao unseal`; the script streams the key from the protected file to the local unseal API and prints only initialization/seal status. This is a manual restart step. No cloud KMS, purchased service, or static key plug-in was available or introduced, and no circular secret in OpenBao storage is used. The same-user boundary is not OS isolation: another process running as this host user can access files the user owns. Do not grant application/agent consumers this recovery directory. A multi-custodian or unattended auto-unseal arrangement remains a separate custody decision if the service moves beyond this local owner boundary.

`bin/openbao backup` writes a Raft snapshot to the owner-only backup directory and prints only its path. `bin/openbao restore FILE` restores to the active instance using OpenBao's normal seal-consistency checks. Verify the target, snapshot provenance and rollback plan before using it. The integration test exercises restore only in a disposable project and volume.

The initial root token is needed for administrative bootstrap and snapshot operations. It is stored only in the owner-only recovery file by this local setup; it is not mounted in consumer containers or supplied to the Agent. Replace this with short-lived scoped operator credentials and a separately controlled recovery ceremony before using the service for production credentials.

## Commands

```sh
services/openbao/bin/openbao config
services/openbao/bin/openbao up
services/openbao/bin/openbao init
services/openbao/bin/openbao unseal
services/openbao/bin/openbao status
services/openbao/bin/openbao backup
services/openbao/bin/openbao test
```

`bin/openbao down` stops this Compose project but preserves data; it accepts no extra arguments, so Compose volume-deletion flags cannot be forwarded. The integration test uses its own unique Compose project and temp directories, restores only that disposable Raft snapshot, then removes only its own container, volume, and generated files.

## Stable reference and policy boundary

Secret paths use the KV-v2 form `secret/data/projects/<project>/<service>/<name>`. A consumer policy names an exact path and only the operations it needs. Stable paths survive value rotation; the consumer token and secret ID remain independently revocable. The included Agent template is deliberately restricted to one synthetic test path, `secret/data/toolrig/testing/consumer`; it is not a reusable production grant. Project references and grants must be provisioned only after that project owner names the resource and allowed operation.

The consumer test runs an actual child process under OpenBao Agent process-supervisor mode. It gets a short-lived AppRole identity scoped to the synthetic path, hashes the injected value, and reports only a fixed success marker. A distinct token is denied and another scoped token is revoked and verified denied. The test logs are checked against the synthetic value before cleanup.

## Portability and boundaries

Requires Docker Compose v2, `bash`, `curl`, `jq`, `openssl`, and `python3` on the host. The tests use `sha256sum` on Linux or `shasum` on macOS. The service image is multi-platform for Linux amd64 and arm64; the Compose path is compatible with Docker Desktop on macOS and Docker Engine/Compose on Linux. The live deployment and restart evidence must still be reported per host; testing on one platform does not prove the other.

OpenBao and this path do not create OS isolation for agents sharing the same local user. They do not migrate existing Polar or OpenTour files, rotate project credentials, or authorize any consumer beyond the temporary synthetic test identity.
