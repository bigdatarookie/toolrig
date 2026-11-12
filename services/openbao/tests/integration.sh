#!/usr/bin/env bash
set -euo pipefail
umask 077

OPENBAO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_ID="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/toolrig-openbao-test.XXXXXX")"
PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"

export TOOLRIG_OPENBAO_PROJECT="toolrig-openbao-test-${RUN_ID}"
export TOOLRIG_OPENBAO_PORT="$PORT"
export TOOLRIG_OPENBAO_STATE_DIR="$TMP_ROOT/state"
export TOOLRIG_OPENBAO_RECOVERY_DIR="$TMP_ROOT/recovery"
export TOOLRIG_OPENBAO_BACKUP_DIR="$TMP_ROOT/backups"

source "$OPENBAO_ROOT/bin/common.sh"
CONSUMER_NAME="toolrig-openbao-consumer-${RUN_ID}"
CONSUMER_CREDENTIALS="$TMP_ROOT/consumer-credentials"
SECRET_FILE="$TMP_ROOT/synthetic-secret"
LARGE_VALUE_FILE="$TMP_ROOT/synthetic-large-value"
LARGE_PAYLOAD_FILE="$TMP_ROOT/synthetic-large-payload.json"
LARGE_RAW_FILE="$TMP_ROOT/synthetic-large-random"
EXPECTED_SHA256_FILE="$TMP_ROOT/expected-sha256"
EXPECTED_LARGE_SHA256_FILE="$TMP_ROOT/expected-large-sha256"
BACKUP_FILE=""

cleanup() {
  docker stop "$CONSUMER_NAME" >/dev/null 2>&1 || true
  docker rm -f "$CONSUMER_NAME" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'OpenBao integration test failed: %s\n' "$1" >&2
  exit 1
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

test_root_curl() {
  local token
  token="$(jq -er '.root_token | select(type == "string" and length > 0)' "$OPENBAO_BOOTSTRAP_FILE")"
  printf 'header = "X-Vault-Token: %s"\n' "$token" |
    curl --disable --config - --silent --show-error "$@"
  unset token
}

wait_for_api() {
  local i
  for i in $(seq 1 40); do
    if curl --silent --output /dev/null "$OPENBAO_ADDR/v1/sys/health"; then
      return 0
    fi
    sleep 1
  done
  fail 'OpenBao API did not become reachable'
}

run_with_root() {
  "$OPENBAO_ROOT/bin/openbao" "$@"
}

compose up -d openbao >/dev/null
for volume_flag in -v --volumes; do
  if "$OPENBAO_ROOT/bin/openbao" down "$volume_flag" >/dev/null 2>&1; then
    fail "down accepted destructive Compose flag: $volume_flag"
  fi
done
container="$(compose ps -q openbao)"
[[ -n "$container" ]] || fail 'a rejected down flag stopped the isolated service'
docker volume inspect "${TOOLRIG_OPENBAO_PROJECT}_data" >/dev/null || fail 'a rejected down flag removed the isolated Raft volume'
wait_for_api
run_with_root init >/dev/null
run_with_root unseal >/dev/null

# Create and prove a synthetic-only secret without placing its value in argv or output.
openssl rand -hex 32 >"$SECRET_FILE"
chmod 600 "$SECRET_FILE"
sha256 <"$SECRET_FILE" >"$EXPECTED_SHA256_FILE"
EXPECTED_SHA256="$(cat "$EXPECTED_SHA256_FILE")"
root_bao secrets enable -path=secret kv-v2 >/dev/null
container="$(compose ps -q openbao)"
docker exec -i --user 100:1000 "$container" /bin/sh -c \
  'umask 077; cat > /tmp/synthetic-secret && chmod 400 /tmp/synthetic-secret' \
  <"$SECRET_FILE"
root_bao kv put secret/toolrig/testing/consumer value=@/tmp/synthetic-secret >/dev/null
docker exec --user 100:1000 "$container" rm -f /tmp/synthetic-secret
read_hash="$(root_bao kv get -format=json secret/toolrig/testing/consumer | jq -j '.data.data.value' | sha256)"
if [[ "$read_hash" != "$EXPECTED_SHA256" ]]; then
  source_bytes="$(wc -c <"$SECRET_FILE" | tr -d ' ')"
  stored_chars="$(root_bao kv get -format=json secret/toolrig/testing/consumer | jq -r '.data.data.value | length')"
  printf 'secret metadata: source-bytes=%s stored-characters=%s\n' "$source_bytes" "$stored_chars" >&2
  fail 'synthetic secret read-back hash differed'
fi

# Add many small random test-only records so their aggregate snapshot exceeds container /tmp.
LARGE_ENTRY_COUNT=40
for large_index in $(seq 1 "$LARGE_ENTRY_COUNT"); do
  openssl rand -out "$LARGE_RAW_FILE" $((384 * 1024))
  LARGE_RAW_FILE="$LARGE_RAW_FILE" LARGE_VALUE_FILE="$LARGE_VALUE_FILE" LARGE_PAYLOAD_FILE="$LARGE_PAYLOAD_FILE" python3 - <<'PY'
import base64
import json
import os
from pathlib import Path

raw = Path(os.environ["LARGE_RAW_FILE"]).read_bytes()
value = base64.b64encode(raw).decode("ascii")
Path(os.environ["LARGE_VALUE_FILE"]).write_text(value)
Path(os.environ["LARGE_PAYLOAD_FILE"]).write_text(json.dumps({"data": {"value": value}}))
PY
  chmod 600 "$LARGE_VALUE_FILE" "$LARGE_PAYLOAD_FILE"
  if [[ "$large_index" == 1 ]]; then
    sha256 <"$LARGE_VALUE_FILE" >"$EXPECTED_LARGE_SHA256_FILE"
  fi
  test_root_curl --fail --request POST --header 'Content-Type: application/json' \
    --data-binary "@$LARGE_PAYLOAD_FILE" \
    "$OPENBAO_ADDR/v1/secret/data/toolrig/testing/large/item-$large_index" >/dev/null
done

# Backup and restore are exercised only against this disposable project and volume.
BACKUP_FILE="$(run_with_root backup)"
backup_size="$(wc -c <"$BACKUP_FILE" | tr -d ' ')"
[[ "$backup_size" -gt $((16 * 1024 * 1024)) ]] || fail 'large synthetic test did not produce a snapshot over 16 MiB'
root_bao kv delete secret/toolrig/testing/consumer >/dev/null
for large_index in $(seq 1 "$LARGE_ENTRY_COUNT"); do
  root_bao kv delete "secret/toolrig/testing/large/item-$large_index" >/dev/null
done
deleted_json="$(root_bao kv get -format=json secret/toolrig/testing/consumer 2>/dev/null || true)"
deleted_value_present="$(printf '%s' "$deleted_json" | jq -r 'if .data? then (.data.data.value? != null) else false end' 2>/dev/null || printf 'unknown')"
[[ "$deleted_value_present" == false ]] || fail 'deleted secret remained readable or the read response was not parseable'
status_json="$(docker exec "$container" bao status -format=json 2>/dev/null || true)"
printf '%s' "$status_json" | jq -e '.initialized == true and .sealed == false' >/dev/null || fail 'OpenBao became unavailable during restore drill'
run_with_root restore "$BACKUP_FILE" >/dev/null
restored_hash="$(root_bao kv get -format=json secret/toolrig/testing/consumer | jq -j '.data.data.value' | sha256)"
[[ "$restored_hash" == "$EXPECTED_SHA256" ]] || fail 'isolated snapshot restore did not recover the test secret'
restored_large_count="$(root_bao kv list -format=json secret/toolrig/testing/large | jq 'length')"
[[ "$restored_large_count" == "$LARGE_ENTRY_COUNT" ]] || fail 'isolated snapshot restore did not recover all large synthetic records'
restored_large_hash="$(root_bao kv get -format=json secret/toolrig/testing/large/item-1 | jq -j '.data.data.value' | sha256)"
EXPECTED_LARGE_SHA256="$(cat "$EXPECTED_LARGE_SHA256_FILE")"
[[ "$restored_large_hash" == "$EXPECTED_LARGE_SHA256" ]] || fail 'isolated snapshot restore did not recover the large synthetic test secret'

# A distinct identity has no policy for the test path and must be denied.
denied_token="$(root_bao token create -policy=default -ttl=2m -field=token)"
if BAO_TOKEN="$denied_token" compose exec -T -e BAO_TOKEN openbao bao kv get secret/toolrig/testing/consumer >/dev/null 2>&1; then
  fail 'unprivileged identity unexpectedly read the test secret'
fi
unset denied_token

# Issue a short-lived scoped token, prove read, then revoke and prove denial.
POLICY="toolrig-test-${RUN_ID}"
root_bao policy write "$POLICY" - <<EOF >/dev/null
path "secret/data/toolrig/testing/consumer" {
  capabilities = ["read"]
}
EOF
consumer_token="$(root_bao token create -policy="$POLICY" -ttl=2m -field=token)"
consumer_hash="$(BAO_TOKEN="$consumer_token" compose exec -T -e BAO_TOKEN openbao bao kv get -format=json secret/toolrig/testing/consumer | jq -j '.data.data.value' | sha256)"
[[ "$consumer_hash" == "$EXPECTED_SHA256" ]] || fail 'scoped consumer token did not read the expected test secret'
BAO_TOKEN="$consumer_token" compose exec -T -e BAO_TOKEN openbao bao token revoke -self >/dev/null
if BAO_TOKEN="$consumer_token" compose exec -T -e BAO_TOKEN openbao bao kv get secret/toolrig/testing/consumer >/dev/null 2>&1; then
  fail 'revoked consumer token still read the test secret'
fi
unset consumer_token

# AppRole plus Agent process-supervisor injection exercises the actual consumer path.
root_bao auth enable approle >/dev/null
ROLE="toolrig-test-${RUN_ID}"
root_bao write "auth/approle/role/$ROLE" \
  token_policies="$POLICY" token_ttl=5m token_max_ttl=5m \
  secret_id_num_uses=1 secret_id_ttl=5m >/dev/null
mkdir -m 700 "$CONSUMER_CREDENTIALS"
root_bao read -format=json "auth/approle/role/$ROLE/role-id" |
  jq -er '.data.role_id' >"$CONSUMER_CREDENTIALS/role_id"
root_bao write -format=json -f "auth/approle/role/$ROLE/secret-id" |
  jq -er '.data.secret_id' >"$CONSUMER_CREDENTIALS/secret_id"
chmod 600 "$CONSUMER_CREDENTIALS/role_id" "$CONSUMER_CREDENTIALS/secret_id"
export TOOLRIG_OPENBAO_AGENT_CREDENTIALS="$CONSUMER_CREDENTIALS"
export TOOLRIG_OPENBAO_EXPECTED_SHA256="$EXPECTED_SHA256"
export TOOLRIG_OPENBAO_CONSUMER_UID="$(id -u)"
export TOOLRIG_OPENBAO_CONSUMER_GID="$(id -g)"
export TOOLRIG_OPENBAO_COMPOSE_OVERRIDE="$OPENBAO_ROOT/compose.consumer.yaml"
compose --profile test-consumer run --detach --rm --no-deps --name "$CONSUMER_NAME" consumer >/dev/null
consumer_logs="$TMP_ROOT/consumer.log"
seen=false
for _ in $(seq 1 30); do
  docker logs "$CONSUMER_NAME" >"$consumer_logs" 2>&1 || true
  if grep -q '^consumer-read-permitted$' "$consumer_logs"; then
    seen=true
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$CONSUMER_NAME" 2>/dev/null || true)" != true ]]; then
    break
  fi
  sleep 1
done
[[ "$seen" == true ]] || fail 'Agent-launched consumer did not report permitted operation'
if grep -F -f "$SECRET_FILE" "$consumer_logs" >/dev/null; then
  fail 'secret value appeared in consumer logs'
fi
docker stop "$CONSUMER_NAME" >/dev/null
docker rm "$CONSUMER_NAME" >/dev/null 2>&1 || true

# Restart the container and recreate it like a host restart; unseal and verify persistence.
compose restart openbao >/dev/null
wait_for_api
run_with_root unseal >/dev/null
compose down >/dev/null
compose up -d openbao >/dev/null
wait_for_api
run_with_root unseal >/dev/null
persisted_hash="$(root_bao kv get -format=json secret/toolrig/testing/consumer | jq -j '.data.data.value' | sha256)"
[[ "$persisted_hash" == "$EXPECTED_SHA256" ]] || fail 'test secret did not persist across host-style recreation'

printf 'OpenBao integration: PASS (pinned service, durable data, restart, isolated restore, scoped deny/revoke, Agent consumer; secret value redacted)\n'
